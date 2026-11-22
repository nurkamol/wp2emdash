/**
 * SEO fix-it (@wp2emdash/seo 0.6): prompt building, output validation and cleanup, batching and daily limits, KV
 * bounds, the approve flow against a fake content API, and the admin page with a fake Workers AI binding and roles.
 * No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addUsage,
	AiLicenseError,
	approve,
	buildPrompt,
	type Candidate,
	candidates,
	cleanDescription,
	cleanKeyword,
	cleanTitle,
	DEFAULT_FIXIT_MODEL,
	draftOne,
	edited,
	EXPIRE_DAYS,
	inText,
	KEYS,
	languageName,
	leftToday,
	MAX_DISCARDED,
	MAX_PENDING,
	nextBatch,
	pageText,
	parseAi,
	pruneDiscarded,
	prunePending,
	type ReportPage,
	stripUnsupported,
	type Suggestion,
	validate,
} from "../packages/seo/src/fixit.js";
import { createPlugin } from "../packages/seo/src/plugin/index.js";
import { improvements } from "../packages/health/src/improve.js";
import { workerNeedsAi } from "../src/scaffold/media.js";
import { cache, env } from "./stubs/cloudflare-workers.js";

const pt = (style: string, text: string) => ({ _type: "block", style, children: [{ _type: "span", text }], markDefs: [] });
const BODY = "Our reformer pilates classes in Portland help beginners build core strength with small groups and certified instructors. Book a first class online, bring water and comfortable clothes, and arrive ten minutes early. Call 503-555-0142 for private sessions. Intro offer $49 for two weeks of unlimited classes.";
const content = (heading: string, body = BODY) => [{ _type: "section_hero", heading, heading_level: "h1", body: [pt("normal", body), pt("normal", body)] }];
const NOW = Date.parse("2026-11-22T12:00:00Z");
const DAY = 86400_000;

const report = (over: Partial<ReportPage["item"]> & { keyword?: string; titleStatus?: string } = {}): ReportPage => {
	const { keyword, titleStatus, ...item } = over;
	return {
		collection: "pages",
		item: { id: "P1", slug: "reformer-pilates", status: "published", data: { title: "Reformer Pilates", content: content("Reformer Pilates in Portland") }, seo: { title: null, description: null, noIndex: false }, ...item },
		title: String((item.data as { title?: string } | undefined)?.title ?? "Reformer Pilates"),
		...(keyword ? { keyword } : {}),
		analysis: { checks: [{ id: "title", status: titleStatus ?? "good" }] },
	};
};
const cand = (over: Partial<Candidate> = {}): Candidate => ({ collection: "pages", id: "P1", title: "Reformer Pilates", slug: "reformer-pilates", text: BODY, words: 50, current: { title: "", description: "", keyword: "" }, needs: { description: true, keyword: true, title: false }, ...over });
const sugg = (sid: string, at = new Date(NOW).toISOString(), over: Partial<Suggestion> = {}): Suggestion => {
	const [collection = "pages", id = sid] = sid.split(":");
	return { sid, collection, id, page: id, slug: id, at, model: DEFAULT_FIXIT_MODEL, current: { title: "", description: "", keyword: "" }, suggested: { description: "d".repeat(130), keyword: "reformer pilates" }, notes: [], ...over };
};

describe("SEO fix-it: page text and prompt", () => {
	it("takes headings and text blocks once, trimmed at a word", () => {
		const t = pageText(content("Reformer Pilates"), 120);
		expect(t.text.startsWith("Reformer Pilates\nOur reformer pilates classes")).toBe(true);
		expect(t.text.length).toBeLessThanOrEqual(120);
		expect(t.text.split(BODY.slice(0, 30)).length).toBe(2); // the repeated paragraph appears once
		expect(t.words).toBeGreaterThan(40);
	});
	it("names the site language and asks for a title only when wanted", () => {
		expect(languageName("de-DE")).toBe("German (Germany) (de-DE)");
		expect(languageName(undefined)).toBeUndefined();
		const m = buildPrompt({ site: "Acme Pilates", lang: "de-DE", title: "Reformer", path: "/reformer/", text: "Kurse für Anfänger", wantTitle: false });
		expect(m.map((x) => x.role)).toEqual(["system", "user"]);
		expect(m[0]?.content).toContain("Write in German");
		expect(m[0]?.content).toContain("120-160 characters");
		expect(m[0]?.content).not.toContain("title:");
		expect(m[1]?.content).toBe("Page title: Reformer\nAddress: /reformer/\n\nPage text:\nKurse für Anfänger");
		const t = buildPrompt({ site: "Acme", title: "x", path: "/", text: "y", wantTitle: true });
		expect(t[0]?.content).toContain("same language as the page text");
		expect(t[0]?.content).toContain("title: an SEO title of at most 60 characters");
	});
});

describe("SEO fix-it: reading and cleaning the AI answer", () => {
	it("reads JSON mode, string, fenced and OpenAI-style answers", () => {
		expect(parseAi({ response: { description: "a", keyword: "b" } })).toEqual({ description: "a", keyword: "b" });
		expect(parseAi({ response: 'Sure! ```json\n{"description":"a","keyword":"b"}\n```' })).toEqual({ description: "a", keyword: "b" });
		expect(parseAi({ choices: [{ message: { content: '{"keyword":"k"}' } }] })).toEqual({ keyword: "k" });
		expect(parseAi("no json here")).toBeUndefined();
		expect(parseAi(42)).toBeUndefined();
	});
	it("strips phone numbers, prices, emails and links the page does not have; keeps those it has", () => {
		const r = stripUnsupported("Call (555) 123-4567 or 503-555-0142, from $29 or $49, write hi@x.example, see www.other.example.", BODY);
		expect(r.removed).toEqual(["(555) 123-4567", "$29", "hi@x.example", "www.other.example."]);
		expect(r.text).toContain("503-555-0142");
		expect(r.text).toContain("$49");
		expect(r.text).not.toMatch(/555\) 123|\$29|hi@|other\.example/);
	});
	it("drops claims the page does not make and flags the doubtful ones", () => {
		const r = stripUnsupported("Award-winning reformer classes, the best in Portland.", BODY);
		expect(r.removed).toEqual(["Award-winning"]);
		expect(r.text.startsWith("reformer classes")).toBe(true);
		expect(r.flagged).toEqual(["best"]);
		expect(stripUnsupported("Certified instructors.", BODY).flagged).toEqual([]);
	});
	it("description: plain, 120–160 characters, cut at a sentence or word, too short dropped", () => {
		const d = cleanDescription(`“Reformer pilates classes in Portland for beginners 🧘 — small groups, certified instructors and an intro offer of $49 for two weeks of unlimited classes. Book your first class online today and feel stronger.”`, BODY);
		expect(d.value).toBeDefined();
		expect(d.value?.length).toBeLessThanOrEqual(160);
		expect(d.value?.length).toBeGreaterThanOrEqual(120);
		expect(d.value).not.toMatch(/[“”🧘]/u);
		expect(d.value?.endsWith(".")).toBe(true);
		expect(cleanDescription("Pilates classes.", BODY).value).toBeUndefined();
		expect(cleanDescription("Pilates classes.", BODY).notes[0]).toMatch(/too short/);
		const short = cleanDescription("Reformer pilates classes in Portland for beginners, with small groups and certified instructors", BODY);
		expect(short.value?.length).toBeLessThan(120);
		expect(short.notes.join(" ")).toMatch(/Short description/);
		expect(cleanDescription(undefined, BODY).value).toBeUndefined();
		const phone = cleanDescription("Reformer pilates classes in Portland for beginners with certified instructors. Call 212-555-9999 to book a private session with a coach.", BODY);
		expect(phone.value).not.toContain("212");
		expect(phone.notes[0]).toMatch(/Removed from the description/);
	});
	it("keyword: 2–4 words that appear in the page text, shortened when needed, else dropped", () => {
		expect(cleanKeyword("Reformer Pilates Classes", BODY)).toEqual({ value: "reformer pilates classes", notes: [] });
		expect(cleanKeyword("reformer pilates classes miami", BODY).value).toBe("reformer pilates classes");
		expect(cleanKeyword("yoga retreat bali", BODY).value).toBeUndefined();
		expect(cleanKeyword("pilates", BODY).value).toBeUndefined();
		expect(inText("core strength", BODY)).toBe(true);
		expect(inText("core strengths", BODY)).toBe(false);
	});
	it("title: at most 60 characters, cut at a separator, else dropped", () => {
		expect(cleanTitle("Reformer Pilates Classes in Portland", BODY).value).toBe("Reformer Pilates Classes in Portland");
		expect(cleanTitle("Reformer Pilates Classes for Beginners in Portland | Acme Pilates Studio Downtown", BODY).value).toBe("Reformer Pilates Classes for Beginners in Portland");
		expect(cleanTitle("A".repeat(70), BODY).value).toBeUndefined();
		expect(cleanTitle("Pilates", BODY).value).toBeUndefined();
	});
	it("validates only the fields a page needs", () => {
		const v = validate({ description: "Reformer pilates classes in Portland for beginners, with small groups and certified instructors. Book a first class online today.", keyword: "reformer pilates", title: "Ignored" }, cand({ needs: { description: true, keyword: true, title: false } }));
		expect(Object.keys(v.suggested)).toEqual(["description", "keyword"]);
		expect(validate(undefined, cand()).notes).toEqual(["The AI answer could not be read."]);
	});
});

describe("SEO fix-it: candidates, batches and limits", () => {
	it("drafts only published, indexable pages with enough text; titles only when asked", () => {
		const pages = [
			report(),
			report({ id: "P2", status: "draft", data: { title: "Secret draft", content: content("Secret") } }),
			report({ id: "P3", seo: { description: null, noIndex: true } }),
			report({ id: "P4", data: { title: "Tiny", content: content("Tiny", "Just a few words.") } }),
			report({ id: "P5", seo: { description: "Has one", noIndex: false }, keyword: "pilates classes" }),
			report({ id: "P6", seo: { description: "Has one", noIndex: false }, keyword: "pilates classes", titleStatus: "warn" }),
		];
		const a = candidates(pages, false);
		expect(a.ready.map((c) => c.id)).toEqual(["P1"]);
		expect(a.tooShort.map((t) => t.title)).toEqual(["Tiny"]);
		expect(a.ready[0]?.needs).toEqual({ description: true, keyword: true, title: false });
		expect(candidates(pages, true).ready.map((c) => c.id)).toEqual(["P1", "P6"]);
	});
	it("drafts no focus keyword for legal pages (a description still)", () => {
		const legal = ["privacy-policy", "terms-and-conditions", "cookie-policy", "waiver-agreement"].map((slug, n) => report({ id: `L${n}`, slug }));
		for (const c of candidates(legal, false).ready) expect(c.needs).toEqual({ description: true, keyword: false, title: false });
		expect(candidates([report({ slug: "privacy-policy", seo: { description: "Has one", noIndex: false } })], false).ready).toEqual([]);
		expect(candidates([report({ slug: "pilates-terms-explained" })], false).ready[0]?.needs.keyword).toBe(true);
	});
	it("skips pages waiting or discarded, at most 10 and what today allows", () => {
		const ready = Array.from({ length: 15 }, (_, n) => cand({ id: `P${n}` }));
		expect(nextBatch(ready, [sugg("pages:P0")], [{ sid: "pages:P1", at: "" }], 10, 100).map((c) => c.id)).toEqual(["P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10", "P11"]);
		expect(nextBatch(ready, [], [], 10, 3)).toHaveLength(3);
		expect(nextBatch(ready, [], [], 10, 0)).toHaveLength(0);
	});
	it("counts drafts per UTC day", () => {
		const u = addUsage(addUsage(null, 10, NOW), 5, NOW);
		expect(u).toEqual({ day: "2026-11-22", drafts: 15 });
		expect(leftToday(u, 100, NOW)).toBe(85);
		expect(leftToday(u, 100, NOW + DAY)).toBe(100);
		expect(leftToday({ day: "2026-11-22", drafts: 120 }, 100, NOW)).toBe(0);
		expect(addUsage(u, 1, NOW + DAY)).toEqual({ day: "2026-11-23", drafts: 1 });
	});
	it("keeps at most 200 pending suggestions, newest first, none older than 30 days, no duplicates", () => {
		const many = Array.from({ length: 260 }, (_, n) => sugg(`pages:P${n}`, new Date(NOW - n * 60_000).toISOString()));
		const kept = prunePending([...many, sugg("pages:P0", new Date(NOW - DAY).toISOString()), sugg("pages:old", new Date(NOW - (EXPIRE_DAYS + 1) * DAY).toISOString()), { junk: true }], NOW);
		expect(kept).toHaveLength(MAX_PENDING);
		expect(kept[0]?.sid).toBe("pages:P0");
		expect(kept[0]?.at).toBe(new Date(NOW).toISOString());
		expect(kept.some((s) => s.sid === "pages:old")).toBe(false);
		expect(prunePending("nope", NOW)).toEqual([]);
		const d = pruneDiscarded([...Array.from({ length: 230 }, (_, n) => ({ sid: `x${n}`, at: new Date(NOW - n).toISOString() })), { sid: "old", at: new Date(NOW - 31 * DAY).toISOString() }], NOW);
		expect(d).toHaveLength(MAX_DISCARDED);
		expect(d.some((x) => x.sid === "old")).toBe(false);
	});
});

describe("SEO fix-it: AI call", () => {
	const messages = buildPrompt({ site: "Acme", title: "t", path: "/", text: "x", wantTitle: false });
	it("asks for JSON mode and retries once without it when the schema could not be met", async () => {
		const run = vi.fn(async (_m: string, input: Record<string, unknown>) => {
			if (input.response_format) throw new Error("JSON Mode couldn't be met");
			return { response: '{"description":"d","keyword":"k"}' };
		});
		expect(await draftOne({ run }, DEFAULT_FIXIT_MODEL, messages)).toEqual({ description: "d", keyword: "k" });
		expect(run).toHaveBeenCalledTimes(2);
		expect(run.mock.calls[0]?.[0]).toBe("@cf/meta/llama-3.3-70b-instruct-fp8-fast");
		expect(run.mock.calls[0]?.[1]).toMatchObject({ response_format: { type: "json_schema" }, max_tokens: 320 });
	});
	it("turns a licence refusal into AiLicenseError and passes other errors on", async () => {
		await expect(draftOne({ run: async () => Promise.reject(new Error("You must agree to the licence")) }, "m", messages)).rejects.toBeInstanceOf(AiLicenseError);
		await expect(draftOne({ run: async () => Promise.reject(new Error("capacity")) }, "m", messages)).rejects.toThrow("capacity");
	});
});

describe("SEO fix-it: approve", () => {
	const fakeContent = (items: Record<string, { status: string; seo: { title: string | null; description: string | null } }>) => ({
		items,
		get: vi.fn(async (_c: string, id: string) => (items[id] ? { id, ...items[id] } : null)),
		update: vi.fn(async (_c: string, id: string, d: { seo: { title?: string; description?: string } }) => {
			const it = items[id];
			if (it) it.seo = { ...it.seo, ...d.seo };
			return {};
		}),
	});
	const memKv = () => {
		const m = new Map<string, unknown>();
		return { m, get: async <T>(k: string) => (m.get(k) as T) ?? null, set: async (k: string, v: unknown) => void m.set(k, v) };
	};
	it("takes the editor's edits; an emptied box leaves that field out", () => {
		const s = sugg("pages:P1", undefined, { suggested: { description: "Drafted text.", keyword: "reformer pilates", title: "Drafted" } });
		expect(edited(s, { description: "  My own “text” ", keyword: "", title: "Better Title" })).toEqual({ description: "My own “text”", title: "Better Title" });
		expect(edited(s, undefined)).toEqual(s.suggested);
		expect(edited(sugg("pages:P2"), { title: "Not suggested" })).not.toHaveProperty("title");
	});
	it("writes the SEO fields through content.update and the keyword to the panel's KV key", async () => {
		const c = fakeContent({ P1: { status: "published", seo: { title: null, description: null } } });
		const kv = memKv();
		const r = await approve(c, kv, [{ s: sugg("pages:P1"), values: { description: "A description.", keyword: "reformer pilates" } }], (col, id) => `kw:${col}:${id}`);
		expect(r.written).toEqual([{ sid: "pages:P1", page: "P1", fields: ["description", "keyword"] }]);
		expect(c.update).toHaveBeenCalledWith("pages", "P1", { seo: { description: "A description." } });
		expect(kv.m.get("kw:pages:P1")).toBe("reformer pilates");
	});
	it("refuses pages gone, unpublished, or changed since the draft", async () => {
		const c = fakeContent({ P2: { status: "draft", seo: { title: null, description: null } }, P3: { status: "published", seo: { title: null, description: "Written by hand meanwhile" } } });
		const kv = memKv();
		kv.m.set("kw:pages:P4", "set meanwhile");
		const c2 = { ...c, get: vi.fn(async (_c: string, id: string) => (id === "P4" ? { id, status: "published", seo: { title: null, description: null } } : await c.get(_c, id))) };
		const r = await approve(c2, kv, ["P1", "P2", "P3", "P4"].map((id) => ({ s: sugg(`pages:${id}`), values: { description: "D.", keyword: "k w" } })), (col, id) => `kw:${col}:${id}`);
		expect(r.written).toEqual([]);
		expect(r.skipped.map((s) => s.reason)).toEqual(["the page no longer exists.", "the page is no longer published.", expect.stringContaining("changed the description"), expect.stringContaining("changed the focus keyword")]);
		expect(c.update).not.toHaveBeenCalled();
	});
});

describe("SEO fix-it admin page", () => {
	type Out = { blocks: Record<string, any>[]; toast?: { message: string; type: string } };
	const plugin = createPlugin({ productionUrl: "https://acme.example", lang: "en-US" }) as unknown as { admin: { pages: { path: string; label: string }[] }; routes: { admin: { permission: string; handler: (c: unknown) => Promise<Out> } } };
	let kv: Map<string, unknown>;
	let items: { id: string; slug: string; status: string; data: Record<string, unknown>; seo: { title: string | null; description: string | null; image: null; canonical: null; noIndex: boolean } }[];
	let update: ReturnType<typeof vi.fn>;
	let purge: ReturnType<typeof vi.fn>;
	const seoOf = () => ({ title: null, description: null, image: null, canonical: null, noIndex: false });
	beforeEach(() => {
		kv = new Map();
		items = [
			{ id: "P1", slug: "reformer-pilates", status: "published", data: { title: "Reformer Pilates", content: content("Reformer Pilates in Portland") }, seo: seoOf() },
			{ id: "P2", slug: "about", status: "published", data: { title: "About", content: content("About our studio") }, seo: { ...seoOf(), description: "x".repeat(140) } },
			{ id: "P3", slug: "secret", status: "draft", data: { title: "Secret plans", content: content("Secret plans", "Unpublished draft text about a merger nobody may know about yet, with enough words to be drafted if it were published, which it is not, so it must never reach the model at all, not even once, ever.") }, seo: seoOf() },
		];
		update = vi.fn(async (_c: string, id: string, d: { seo: Record<string, string> }) => {
			const it = items.find((x) => x.id === id);
			if (it) it.seo = { ...it.seo, ...d.seo };
			return {};
		});
		purge = vi.fn(async () => ({ success: true, errors: [] }));
		cache.purge = purge as never;
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
	});
	afterEach(() => {
		delete env.AI;
		delete cache.purge;
		vi.unstubAllGlobals();
	});
	const ctx = (input: Record<string, unknown>, role = 40) => ({
		input: { page: "/seo-fixit", ...input },
		user: { role, name: "Ed" },
		request: new Request("https://acme.example/_emdash/api/plugins/site-seo/admin"),
		kv: { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: unknown) => void kv.set(k, v) },
		content: { get: async (_c: string, id: string) => items.find((i) => i.id === id) ?? null, list: async () => ({ items, hasMore: false }), update },
		media: { get: async () => null },
		site: { name: "Acme Pilates" },
	});
	const fakeAi = () => {
		const run = vi.fn(async (_m: string, _input: Record<string, unknown>) => ({ response: { description: "Reformer pilates classes in Portland for beginners, with small groups and certified instructors. Book a first class online today.", keyword: "Reformer Pilates Classes" } }));
		env.AI = { run };
		return run;
	};
	const pendingOf = () => kv.get(KEYS.pending) as Suggestion[];

	it("is its own admin page", () => {
		expect(plugin.admin.pages).toContainEqual({ path: "/seo-fixit", label: "SEO fix-it", icon: "magic-wand" });
		expect(plugin.routes.admin.permission).toBe("content:edit_any");
	});
	it("is for editors and admins only: contributors see a note and nothing runs", async () => {
		const run = fakeAi();
		const r = await plugin.routes.admin.handler(ctx({ type: "block_action", action_id: "fx-draft" }, 30));
		expect(r.blocks[0]).toMatchObject({ type: "banner", title: "Editors and administrators only" });
		expect(run).not.toHaveBeenCalled();
		expect(kv.size).toBe(0);
	});
	it("without the AI binding: explains how to enable it and offers no draft button", async () => {
		const r = await plugin.routes.admin.handler(ctx({ type: "page_load" }));
		expect(r.blocks.find((b) => b.type === "banner")?.title).toBe("Workers AI is not connected");
		expect(r.blocks.some((b) => b.type === "section" && b.text.includes('"ai": { "binding": "AI" }'))).toBe(true);
		expect(r.blocks.some((b) => b.block_id === "fx-draft")).toBe(false);
		expect(r.blocks.find((b) => b.block_id === "fx-queue")?.rows).toEqual([{ page: "Reformer Pilates", missing: "description, focus keyword" }, { page: "About", missing: "focus keyword" }]);
		const t = await plugin.routes.admin.handler(ctx({ type: "form_submit", action_id: "fx-draft", values: { titles: false } }));
		expect(t.toast?.type).toBe("error");
	});
	it("drafts published pages only, stores suggestions without page text, and counts the day's drafts", async () => {
		const run = fakeAi();
		const r = await plugin.routes.admin.handler(ctx({ type: "form_submit", action_id: "fx-draft", values: { titles: false } }));
		expect(r.toast?.message).toMatch(/^2 suggestions drafted/);
		expect(run).toHaveBeenCalledTimes(2);
		const sent = JSON.stringify(run.mock.calls);
		expect(sent).not.toContain("Secret plans");
		expect(sent).not.toContain("merger");
		expect(sent).toContain("Write in American English (en-US)");
		const pending = pendingOf();
		expect(pending.map((s) => s.sid).sort()).toEqual(["pages:P1", "pages:P2"]);
		expect(pending.find((s) => s.sid === "pages:P2")?.suggested).toEqual({ keyword: "reformer pilates classes" });
		expect(JSON.stringify([...kv.values()])).not.toContain("Book a first class online, bring water");
		expect(kv.get(KEYS.usage)).toMatchObject({ drafts: 2 });
		const rows = r.blocks.filter((b) => b.type === "form" && String(b.block_id).startsWith("fx:"));
		expect(rows.map((b) => b.block_id).sort()).toEqual(["fx:pages:P1", "fx:pages:P2"]);
		expect(r.blocks.some((b) => b.type === "context" && /live right away/.test(b.text))).toBe(true);
		// Nothing written yet.
		expect(update).not.toHaveBeenCalled();
		expect(kv.has("kw:pages:P1")).toBe(false);
		// A second press drafts nothing new (both waiting).
		const again = await plugin.routes.admin.handler(ctx({ type: "block_action", action_id: "fx-draft" }));
		expect(again.toast?.message).toBe("No page needs a draft right now.");
		expect(run).toHaveBeenCalledTimes(2);
	});
	it("approves one page with the editor's edits, then purges the cached pages", async () => {
		fakeAi();
		await plugin.routes.admin.handler(ctx({ type: "block_action", action_id: "fx-draft" }));
		const r = await plugin.routes.admin.handler(ctx({ type: "form_submit", action_id: "fx-approve", block_id: "fx:pages:P1", values: { description: "Edited by the editor: reformer pilates classes in Portland for beginners with certified instructors and small groups.", keyword: "reformer pilates" } }));
		expect(r.toast).toMatchObject({ type: "success" });
		expect(r.toast?.message).toContain("Saved for 1 page.");
		expect(update).toHaveBeenCalledWith("pages", "P1", { seo: { description: "Edited by the editor: reformer pilates classes in Portland for beginners with certified instructors and small groups." } });
		expect(kv.get("kw:pages:P1")).toBe("reformer pilates");
		expect(purge).toHaveBeenCalledTimes(1);
		expect(pendingOf().map((s) => s.sid)).toEqual(["pages:P2"]);
	});
	it("approve all shown saves the drafts; a keyword-only approval needs no purge", async () => {
		fakeAi();
		items[0]!.seo.description = "y".repeat(130); // P1 then only needs a keyword
		await plugin.routes.admin.handler(ctx({ type: "block_action", action_id: "fx-draft" }));
		const r = await plugin.routes.admin.handler(ctx({ type: "block_action", action_id: "fx-approve-all" }));
		expect(r.toast?.message).toContain("Saved for 2 pages.");
		expect(update).not.toHaveBeenCalled();
		expect(purge).not.toHaveBeenCalled();
		expect(kv.get("kw:pages:P2")).toBe("reformer pilates classes");
		expect(pendingOf()).toEqual([]);
	});
	it("discard removes a suggestion and keeps the page out of the next batch", async () => {
		const run = fakeAi();
		await plugin.routes.admin.handler(ctx({ type: "block_action", action_id: "fx-draft" }));
		const r = await plugin.routes.admin.handler(ctx({ type: "block_action", action_id: "fx-discard", value: "pages:P1" }));
		expect(r.toast?.message).toMatch(/Discarded the suggestion for Reformer Pilates/);
		expect(pendingOf().map((s) => s.sid)).toEqual(["pages:P2"]);
		expect((kv.get(KEYS.discarded) as { sid: string }[]).map((d) => d.sid)).toEqual(["pages:P1"]);
		await plugin.routes.admin.handler(ctx({ type: "block_action", action_id: "fx-draft" }));
		expect(run).toHaveBeenCalledTimes(2);
	});
	it("stops at the daily limit and remembers a licence refusal", async () => {
		kv.set(KEYS.usage, { day: new Date().toISOString().slice(0, 10), drafts: 100 });
		const run = fakeAi();
		const r = await plugin.routes.admin.handler(ctx({ type: "block_action", action_id: "fx-draft" }));
		expect(r.toast?.message).toMatch(/Today's limit of 100 drafts/);
		expect(run).not.toHaveBeenCalled();
		kv.delete(KEYS.usage);
		run.mockRejectedValue(new Error("Model requires you to agree to the license"));
		const l = await plugin.routes.admin.handler(ctx({ type: "block_action", action_id: "fx-draft" }));
		expect(l.toast?.type).toBe("error");
		expect(l.blocks.find((b) => b.type === "banner")?.title).toBe("The AI model needs its licence accepted");
	});
	it("the SEO dashboard links to it when pages lack a description", async () => {
		const r = await plugin.routes.admin.handler({ ...ctx({ type: "page_load" }), input: { type: "page_load", page: "/seo" } });
		const overview = r.blocks.find((b) => b.type === "tab")?.panels[0].blocks as Record<string, any>[];
		expect(overview.some((b) => b.type === "actions" && b.elements[0]?.target?.path === "/seo-fixit")).toBe(true);
	});
});

describe("SEO fix-it elsewhere", () => {
	it("Site health's missing-description item opens SEO fix-it", () => {
		const s = { v: 1 as const, at: "", pages: 3, average: 70, thin: { count: 0, pages: [] }, noDescription: { count: 2, pages: ["A", "B"] }, keyword: { count: 1, pages: ["A"] }, missingAlt: { count: 0, pages: [] } };
		const list = improvements({ seo: s });
		expect(list.find((x) => x.id === "description")?.link).toMatchObject({ plugin: "site-seo", path: "/seo-fixit" });
		expect(list.find((x) => x.id === "keyword")?.link).toMatchObject({ plugin: "site-seo", path: "/seo" });
	});
	it("scaffold binds Workers AI for fix-it, except on sensitive sites", () => {
		expect(workerNeedsAi(undefined, true, false)).toBe(true);
		expect(workerNeedsAi(undefined, true, true)).toBe(false);
		expect(workerNeedsAi(undefined, false, false)).toBe(false);
		expect(workerNeedsAi({ aiAlt: true } as never, false, true)).toBe(true);
	});
});
