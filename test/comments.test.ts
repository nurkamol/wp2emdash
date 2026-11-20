/**
 * WordPress comments: transform plan (threading flattened to EmDash's one level, pending/spam/trash/pingbacks left out
 * and counted, discussion settings), the import route (@wp2emdash/comments), load's idempotent import + EmDash
 * moderation, the starter's helpers, verify's count check — and that no e-mail address reaches a report, gate or log.
 * Fixtures: test/fixtures/blog/site.json + test/fixtures/comments/site.json. Goldens: test/golden/comments/*.json
 * (regenerate after an intended change: UPDATE_GOLDEN=1 pnpm test).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { overridesSchema } from "../src/config/overrides.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { runTransform } from "../src/phases/transform.js";
import { buildSeed, POSTS_COLLECTION, seedMediaResolver } from "../src/scaffold/seed.js";
import { commentsGuide } from "../src/scaffold/client-repo.js";
import { type CommentMapEntry, type CommentsApi, type CommentsFile, loadComments } from "../src/targets/emdash/comments.js";
import { commentBody, commentId, commentsGate, commentsReport, deterministicUlid, discussionSettings, planComments, starterCommentsConfig, type WpComment } from "../src/transform/comments.js";
import { commentCountProblem } from "../src/verify/comments.js";
import { type CommentStore, type ExistingRow, importComments, type StoredRow } from "../packages/comments/src/import.js";
import { createPlugin, kyselyStore } from "../packages/comments/src/plugin/index.js";
import { commentsPlugin } from "../packages/comments/src/index.js";
import { commentCacheInvalidations } from "./stubs/emdash.js";
import { testDb } from "./stubs/emdash-runtime.js";
import { bodyParts, commentPayload, commentPostTarget, commentsHeading, formOpen, showsComments, submitMessage } from "../starter/src/utils/comments.js";
import type { IrSite } from "../src/ir/schema.js";

const blog = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "blog", "site.json"), "utf8"));
const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "comments", "site.json"), "utf8")) as { commentStatus: Record<string, string>; restDiscussion: Record<string, string>; dumpDiscussion: Record<string, string>; comments: WpComment[] };
const EMAILS = [...new Set(fx.comments.map((c) => c.author_email).filter(Boolean))] as string[];
const goldenDir = join(import.meta.dirname, "golden", "comments");
const golden = (name: string, value: unknown) => {
	const file = join(goldenDir, name);
	const json = `${JSON.stringify(value, null, "\t")}\n`;
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
		mkdirSync(goldenDir, { recursive: true });
		writeFileSync(file, json);
	}
	expect(json).toBe(readFileSync(file, "utf8"));
};
const noEmails = (text: string) => {
	for (const e of EMAILS) expect(text, `leaks ${e}`).not.toContain(e);
	expect(text).not.toMatch(/@example\.test/);
};

const dir = mkdtempSync(join(tmpdir(), "wp2e-comments-"));
const put = (file: string, data: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const config = (over: Record<string, unknown> = {}) => kitConfigSchema.parse({ slug: "blog", name: "Example Journal", source: { url: "https://blog.example.test" }, target: { productionUrl: "https://blog.example.test" }, ...over });
const DECIDED = `protectedPosts: { as: "draft", reason: "owner: members-only posts stay drafts" }`;
const withStatus = (items: { id: number }[]) => items.map((p) => ({ ...p, ...(fx.commentStatus[String(p.id)] ? { comment_status: fx.commentStatus[String(p.id)] } : {}) }));

function workspace(name: string, o: { comments?: boolean; overrides?: string } = {}) {
	const paths = sitePaths(name, dir);
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "options.json"), blog.options);
	put(join(paths.raw, "exporter", "content", "page.json"), withStatus(blog.pages));
	put(join(paths.raw, "exporter", "content", "post.json"), withStatus(blog.posts));
	put(join(paths.raw, "exporter", "taxonomies.json"), blog.taxonomies);
	put(join(paths.raw, "exporter", "analyze.json"), blog.analyze);
	put(join(paths.raw, "media-manifest.json"), blog.media);
	put(join(paths.snapshot, "urls.json"), blog.urls);
	put(join(paths.snapshot, "discovery.json"), blog.discovery);
	if (o.comments !== false) {
		put(join(paths.raw, "exporter", "comments.json"), fx.comments);
		put(join(paths.raw, "exporter", "discussion.json"), fx.restDiscussion);
		put(join(paths.raw, "discussion.json"), fx.dumpDiscussion);
	} else put(join(paths.raw, "exporter", "comments.json"), []);
	put(paths.overrides, `export default { ${[DECIDED, o.overrides].filter(Boolean).join(", ")} };\n`);
	return paths;
}
const events: unknown[] = [];
const run = (paths: ReturnType<typeof sitePaths>, cfg = config()) => runTransform({ config: cfg, paths, reporter: { runId: "t", emit: (e) => void events.push(e) } });
const readIr = (paths: ReturnType<typeof sitePaths>) => JSON.parse(readFileSync(join(paths.ir, "comments.json"), "utf8")) as CommentsFile;

describe("comments transform", () => {
	it("plans the import: threads flattened, pending/spam/trash/pingbacks/orphans left out and counted (golden)", async () => {
		const paths = workspace("comments");
		const checks = await run(paths);
		const gate = checks.find((c) => c.id === "comments");
		expect(gate).toMatchObject({ ok: true });
		const file = readIr(paths);
		golden("comments.json", file);
		expect(file.counts).toEqual({ found: 12, approved: 8, pending: 1, imported: 6, skipped: { spam: 1, pending: 1, pingback: 1, "entry-not-migrated": 1, trash: 1, empty: 1 }, flattened: 1, reparented: 1, authorUrls: 2 });
		const byWp = new Map(file.items.map((c) => [c.wpId, c]));
		// 103 answered 102 (a reply): it joins 101's thread, EmDash nests one level.
		expect(byWp.get(102)?.parentId).toBe(byWp.get(101)?.id);
		expect(byWp.get(103)?.parentId).toBe(byWp.get(101)?.id);
		// 108 answered a pending comment that is not imported: top-level.
		expect(byWp.get(108)?.parentId).toBeNull();
		expect(byWp.get(102)?.body).toBe("Thanks & welcome!\n\nMore in the notes (https://blog.example.test/classic-notes/).");
		expect(byWp.get(102)?.createdAt).toBe("2024-05-11T09:30:00.000Z");
		expect(byWp.get(107)?.authorName).toBe("Sam & Co");
		expect(byWp.get(110)).toMatchObject({ collection: "pages", entry: "page:2" });
		// Settings: posts take comments (open in WordPress); pages show their comment, no form (closed in WordPress).
		expect(file.collections).toEqual([
			{ slug: "pages", form: false, moderation: "first_time", closedAfterDays: 30, approved: 1, pending: 0, why: "off: comments were closed in WordPress" },
			{ slug: "posts", form: true, moderation: "first_time", closedAfterDays: 30, approved: 5, pending: 0, why: "on: WordPress took comments" },
		]);
		expect(file.entries.find((e) => e.key === "post:11")).toMatchObject({ approved: 2, closed: true });
		expect(file.settings).toMatchObject({ defaultOpen: true, threadDepth: 3, source: "REST settings + backup options" });
	});

	it("reports counts only: no e-mail address in the coverage report, coverage.json, gate details or logs", async () => {
		events.length = 0;
		const paths = workspace("privacy");
		const checks = await run(paths);
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toContain("## Comments");
		expect(md).toContain("| Replies deeper than one level (joined their top-level thread: EmDash nests one level) | 1 |");
		noEmails(md);
		noEmails(readFileSync(join(paths.reports, "transform", "coverage.json"), "utf8"));
		noEmails(JSON.stringify(checks));
		noEmails(JSON.stringify(events));
		for (const name of ["Ana Reader", "Great post"]) expect(md).not.toContain(name);
	});

	it("a site without comments gets no plan, report section or gate (output unchanged)", async () => {
		const paths = workspace("none", { comments: false });
		const checks = await run(paths);
		expect(checks.some((c) => c.id === "comments")).toBe(false);
		expect(existsSync(join(paths.ir, "comments.json"))).toBe(false);
		expect(readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8")).not.toContain("## Comments");
		expect(JSON.parse(readFileSync(join(paths.ir, "wp-urls.json"), "utf8")).explain.find((e: { rule: string }) => e.rule === "commentsFeed").why).toMatch(/not migrated/);
	});

	it("a sensitive site needs the owner's decision; migrate: false keeps every comment out and passes", async () => {
		const sensitive = config({ sensitiveData: true });
		const a = workspace("sensitive");
		expect((await run(a, sensitive)).find((c) => c.id === "comments")).toMatchObject({ ok: false });
		expect(readIr(a).collections.every((c) => !c.form)).toBe(true);
		const b = workspace("sensitive-no", { overrides: `comments: { migrate: false, reason: "owner: health questions in comments" }` });
		const gate = (await run(b, sensitive)).find((c) => c.id === "comments");
		expect(gate).toMatchObject({ ok: true });
		expect(gate?.detail).toMatch(/not migrated by decision/);
		expect(readIr(b).items).toEqual([]);
		const c = workspace("sensitive-yes", { overrides: `comments: { migrate: true, reason: "owner: comments are public anyway" }` });
		expect((await run(c, sensitive)).find((x) => x.id === "comments")).toMatchObject({ ok: true });
		expect(readIr(c).items.length).toBe(6);
		expect(readIr(c).collections.find((x) => x.slug === "posts")?.form).toBe(false); // the form stays off unless decided
	});

	it("includePending imports pending comments as pending; the comment feed rule names migrated comments", async () => {
		const paths = workspace("pending", { overrides: `comments: { includePending: true, moderation: "all" }` });
		await run(paths);
		const file = readIr(paths);
		expect(file.items.find((c) => c.wpId === 104)?.status).toBe("pending");
		expect(file.items.find((c) => c.wpId === 108)?.parentId).toBeNull(); // parent on another entry
		expect(file.collections.every((c) => c.moderation === "all")).toBe(true);
		expect(JSON.parse(readFileSync(join(paths.ir, "wp-urls.json"), "utf8")).explain.find((e: { rule: string }) => e.rule === "commentsFeed")).toMatchObject({ target: "gone", why: expect.stringMatching(/migrated but no comment feed/) });
	});

	it("overrides: a reason is required for migrate/form", () => {
		expect(overridesSchema.safeParse({ comments: { migrate: false } }).success).toBe(false);
		expect(overridesSchema.safeParse({ comments: { migrate: false, reason: "owner said so" } }).success).toBe(true);
		expect(overridesSchema.safeParse({ comments: { includePending: true } }).success).toBe(true);
	});
});

describe("comment helpers", () => {
	it("bodies: plain text EmDash shows (paragraphs, links with their address, entities, no scripts)", () => {
		expect(commentBody("<p>One<br/>two</p><p>Three &hellip; &#8217;</p>")).toBe("One\ntwo\n\nThree … ’");
		expect(commentBody('<a href="https://x.test/">https://x.test/</a> and <a href="javascript:alert(1)">me</a>')).toBe("https://x.test/ and me");
		expect(commentBody("<ul><li>a</li><li>b</li></ul>")).toBe("• a\n• b");
		expect(commentBody("<script>x</script><style>y</style>  ")).toBe("");
		expect(commentBody("Plain\r\n\r\n\r\ntext")).toBe("Plain\n\ntext");
	});
	it("ids: deterministic ULIDs that sort by the comment's time", () => {
		const a = commentId("blog.example.test", 101, "2024-05-11T08:00:00Z");
		expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(commentId("blog.example.test", 101, "2024-05-11T08:00:00Z")).toBe(a);
		expect(commentId("other.test", 101, "2024-05-11T08:00:00Z")).not.toBe(a);
		expect(commentId("blog.example.test", 102, "2024-05-12T08:00:00Z") > a).toBe(true);
		expect(deterministicUlid(0, "x").slice(0, 10)).toBe("0000000000");
	});
	it("discussion settings → EmDash moderation and closing (WordPress defaults when unknown)", () => {
		expect(discussionSettings(undefined, undefined)).toMatchObject({ defaultOpen: null, moderation: "first_time", closedAfterDays: 0, registration: false, source: "WordPress defaults (no discussion settings found)" });
		expect(discussionSettings({ default_comment_status: "closed" }, { comment_moderation: "1", close_comments_for_old_posts: "1", close_comments_days_old: "14" })).toMatchObject({ defaultOpen: false, moderation: "all", closedAfterDays: 14 });
		expect(discussionSettings(undefined, { comment_moderation: "0", comment_previously_approved: "0" }).moderation).toBe("none");
		expect(discussionSettings(undefined, { comment_registration: "1" }).registration).toBe(true);
	});
	it("registered-users-only sites get no form; form: true overrides it", () => {
		const s = { ...discussionSettings({ default_comment_status: "open" }, { comment_registration: "1" }) };
		const targets = [{ key: "post:1", wpId: 1, collection: "posts", slug: "a", published: true, commentStatus: "open" }];
		const c: WpComment[] = [{ id: 5, post_id: 1, author_name: "A", author_email: "a@example.test", body: "hi", date_gmt: "2024-01-01T00:00:00Z", status: "approved" }];
		expect(planComments({ comments: c, targets, settings: s, sensitive: false, site: "x" }).plan.collections[0]).toMatchObject({ form: false, why: "off: WordPress required registered users" });
		expect(planComments({ comments: c, targets, settings: s, decision: { form: true, reason: "owner" }, sensitive: false, site: "x" }).plan.collections[0]?.form).toBe(true);
		const plan = planComments({ comments: c, targets, settings: s, sensitive: false, site: "x" }).plan;
		expect(starterCommentsConfig(plan)).toEqual({ collections: { posts: { form: false } } });
		expect(starterCommentsConfig({ ...plan, collections: [{ ...plan.collections[0], form: true, closedAfterDays: 14 } as never] })).toEqual({ collections: { posts: { form: true, closedAfterDays: 14 } } });
		noEmails(commentsReport(plan).join("\n") + commentsGate(plan).detail);
	});
});

// ── Import route (packages/comments) ─────────────────────────────────────────────────────────────────────────
function memoryStore(entries: Record<string, string[]>) {
	type Row = Omit<StoredRow, "status"> & { status: string };
	const rows = new Map<string, Row>();
	const store: CommentStore & { rows: Map<string, Row> } = {
		rows,
		async collections() {
			return new Set(Object.keys(entries));
		},
		async contentIds(c, ids) {
			return new Set(ids.filter((i) => entries[c]?.includes(i)));
		},
		async existing(ids) {
			return new Map(ids.flatMap((i): [string, ExistingRow][] => {
				const r = rows.get(i);
				return r ? [[i, { id: i, collection: r.collection, contentId: r.content_id, parentId: r.parent_id, status: r.status }]] : [];
			}));
		},
		async insert(list) {
			for (const r of list) if (!rows.has(r.id)) rows.set(r.id, r);
		},
	};
	return store;
}
const ID = (n: number) => commentId("t", n, `2024-01-0${n}T00:00:00Z`);
const row = (n: number, o: Record<string, unknown> = {}) => ({ id: ID(n), wpId: n, collection: "posts", contentId: "E1", parentId: null, authorName: "Ana", authorEmail: "ana@example.test", body: "Hello", createdAt: `2024-01-0${n}T00:00:00Z`, ...o });

describe("import route", () => {
	it("writes pending rows with the WordPress date; reruns report them as existing; checks entries and threads", async () => {
		const store = memoryStore({ posts: ["E1", "E2"] });
		const first = await importComments(store, { comments: [row(1), row(2, { parentId: ID(1) }), row(3, { parentId: ID(2) }), row(4, { contentId: "E2", parentId: ID(1) }), row(5, { contentId: "NOPE" }), row(6, { collection: "nope" }), { id: "bad" }, row(7, { body: "  " })] });
		if ("error" in first) throw new Error(first.error);
		expect(first.results.map((r) => r.outcome)).toEqual(["created", "created", "rejected", "rejected", "rejected", "rejected", "rejected", "rejected"]);
		expect(first.results.filter((r) => r.outcome === "rejected").map((r) => (r as { reason: string }).reason)).toEqual(["parent comment is a reply (EmDash nests one level)", "parent comment belongs to another entry", "entry NOPE not found in posts", "collection nope does not exist", "id is not a ULID", "body empty"]);
		expect(store.rows.get(ID(1))).toMatchObject({ status: "pending", created_at: "2024-01-01T00:00:00.000Z", updated_at: "2024-01-01T00:00:00.000Z", ip_hash: null, user_agent: null, author_user_id: null, moderation_metadata: '{"importedFrom":"wordpress","wpCommentId":1}' });
		expect(store.rows.get(ID(2))?.parent_id).toBe(ID(1));
		noEmails(JSON.stringify(first.results));
		const again = await importComments(store, { comments: [row(1), row(2, { parentId: ID(1) })] });
		expect("results" in again && again.results).toEqual([{ id: ID(1), outcome: "exists", status: "pending" }, { id: ID(2), outcome: "exists", status: "pending" }]);
		expect(await importComments(store, { comments: Array.from({ length: 51 }, () => row(1)) })).toEqual({ error: "at most 50 comments per request" });
	});

	it("the plugin route: admins only, EmDash's database handle, comment cache invalidated after a write", async () => {
		const tables: Record<string, Record<string, unknown>[]> = { _emdash_collections: [{ slug: "posts" }], ec_posts: [{ id: "E1", deleted_at: null }], _emdash_comments: [] };
		// A minimal stand-in for EmDash's Kysely handle: the calls the store makes.
		const q = (t: string) => {
			const where: [string, string, unknown][] = [];
			const api = {
				select: () => api,
				where: (c: string, op: string, v: unknown) => (where.push([c, op, v]), api),
				execute: async () => (tables[t] ?? []).filter((r) => where.every(([c, op, v]) => (op === "in" ? (v as unknown[]).includes(r[c]) : op === "is" ? r[c] === v : r[c] === v))),
			};
			return api;
		};
		testDb.current = { selectFrom: q, insertInto: (t: string) => ({ values: (rows: Record<string, unknown>[]) => ({ onConflict: () => ({ execute: async () => void tables[t]?.push(...rows) }) }) }) };
		const plugin = createPlugin();
		expect(commentsPlugin()).toMatchObject({ id: "wp2emdash-comments", entrypoint: "@wp2emdash/comments/plugin", format: "native" });
		expect(plugin.routes.import.permission).toBe("plugins:manage");
		expect(await plugin.routes.import.handler({ input: { comments: [row(1)] }, user: { role: 40 } } as never)).toEqual({ error: "admins only" });
		const before = commentCacheInvalidations.count;
		const logs: unknown[] = [];
		const r = await plugin.routes.import.handler({ input: { comments: [row(1)] }, user: { role: 50 }, log: { info: (m: string, d: unknown) => logs.push([m, d]) } } as never);
		expect(r).toMatchObject({ created: 1 });
		expect(tables._emdash_comments).toHaveLength(1);
		expect(commentCacheInvalidations.count).toBe(before + 1);
		noEmails(JSON.stringify(logs));
		expect(await kyselyStore(testDb.current).existing([ID(1)])).toEqual(new Map([[ID(1), { id: ID(1), collection: "posts", contentId: "E1", parentId: null, status: "pending" }]]));
	});
});

// ── Load: idempotent import, approval through EmDash's moderation, read back ───────────────────────────────────
function fakeTarget(store = memoryStore({ posts: ["E10", "E11"], pages: ["E2"] })) {
	const calls = { imports: 0, sent: 0, approved: [] as string[] };
	let failApprove = false;
	const api: CommentsApi = {
		commentsPluginStatus: async () => ({ plugin: "wp2emdash-comments", version: "0.1.0" }),
		importComments: async (comments) => {
			calls.imports++;
			calls.sent += comments.length;
			return (await importComments(store, { comments })) as never;
		},
		moderateComments: async (ids, action) => {
			if (failApprove) throw new Error("HTTP 502");
			for (const id of ids) {
				const r = store.rows.get(id);
				if (r) store.rows.set(id, { ...r, status: action === "approve" ? "approved" : action });
			}
			calls.approved.push(...ids);
			return ids.length;
		},
		commentIds: async (status, collection) => [...store.rows.values()].filter((r) => r.status === status && (!collection || r.collection === collection)).map((r) => ({ id: r.id, contentId: r.content_id, status: r.status })),
	};
	return { api, store, calls, failApprove: (v: boolean) => (failApprove = v) };
}

describe("load comments", () => {
	const file = (() => {
		const settings = discussionSettings(fx.restDiscussion, fx.dumpDiscussion);
		const targets = [
			{ key: "post:10", wpId: 10, collection: "posts", slug: "hello-gutenberg", path: "/hello-gutenberg/", published: true, commentStatus: "open" },
			{ key: "post:11", wpId: 11, collection: "posts", slug: "classic-notes", path: "/classic-notes/", published: true, commentStatus: "closed" },
			{ key: "page:2", wpId: 2, collection: "pages", slug: "home", path: "/", published: true, commentStatus: "closed" },
		];
		const { plan, items } = planComments({ comments: fx.comments, targets, settings, decision: { includePending: true }, sensitive: false, site: "blog.example.test" });
		return { ...plan, items } as CommentsFile;
	})();
	const ids: Record<string, string> = { "post:10": "E10", "post:11": "E11", "page:2": "E2" };

	it("first load writes pending, approves through EmDash's moderation; a rerun sends nothing and passes", async () => {
		const t = fakeTarget();
		const map: Record<string, CommentMapEntry> = {};
		const r = await loadComments(t.api, file, (k) => ids[k], map, () => {});
		expect(r).toMatchObject({ ok: true, created: 7, existing: 0, approved: 6, editorChanged: 0 });
		expect([...t.store.rows.values()].filter((x) => x.status === "approved")).toHaveLength(6);
		expect(t.store.rows.get(file.items.find((c) => c.wpId === 104)?.id ?? "")?.status).toBe("pending");
		expect(Object.values(map).every((m) => m.done)).toBe(true);
		noEmails(r.detail);
		const again = await loadComments(t.api, file, (k) => ids[k], map, () => {});
		expect(again).toMatchObject({ ok: true, created: 0, approved: 0 });
		expect(t.calls.sent).toBe(7); // nothing sent the second time
	});

	it("an editor's moderation after a load is kept (never re-approved or re-created)", async () => {
		const t = fakeTarget();
		const map: Record<string, CommentMapEntry> = {};
		await loadComments(t.api, file, (k) => ids[k], map, () => {});
		const trashed = file.items.find((c) => c.wpId === 107)?.id as string;
		const was = t.store.rows.get(trashed);
		if (was) t.store.rows.set(trashed, { ...was, status: "trash" });
		t.store.rows.delete(file.items.find((c) => c.wpId === 101)?.id as string);
		const r = await loadComments(t.api, file, (k) => ids[k], map, () => {});
		expect(r).toMatchObject({ ok: true, created: 0, editorChanged: 2 });
		expect(t.store.rows.get(trashed)?.status).toBe("trash");
		expect(r.detail).toMatch(/2 changed by an editor/);
	});

	it("an interrupted approval is finished by the next load; a missing route fails with the fix", async () => {
		const t = fakeTarget();
		const map: Record<string, CommentMapEntry> = {};
		t.failApprove(true);
		const first = await loadComments(t.api, file, (k) => ids[k], map, () => {});
		expect(first.ok).toBe(false);
		expect(Object.values(map).filter((m) => !m.done)).toHaveLength(6);
		t.failApprove(false);
		const second = await loadComments(t.api, file, (k) => ids[k], map, () => {});
		expect(second).toMatchObject({ ok: true, existing: 6, approved: 6 });
		const missing = await loadComments({ ...t.api, commentsPluginStatus: async () => Promise.reject(Object.assign(new Error("404"), { code: "NOT_FOUND" })) }, file, (k) => ids[k], {}, () => {});
		expect(missing).toMatchObject({ ok: false, detail: expect.stringMatching(/rerun scaffold/) });
		const noEntry = await loadComments(fakeTarget().api, file, (k) => (k === "page:2" ? undefined : ids[k]), {}, () => {});
		expect(noEntry.detail).toMatch(/#110: entry page:2 not on the target/);
	});
});

describe("seed, starter, verify, client docs", () => {
	it("seed: posts get commentsEnabled and the Comments closed field; POSTS_COLLECTION is not changed", () => {
		const site: IrSite = { version: 1, title: "x", menus: [], partials: [], popups: [] };
		const plan = JSON.parse(readFileSync(join(import.meta.dirname, "golden", "blog", "blog.json"), "utf8"));
		const s = buildSeed({ name: "x", site, pages: [], partials: [], popups: [], media: seedMediaResolver(new Map(), (u) => u), titleSeparator: "-", forms: [], includeContent: false, blog: { plan, posts: [] }, comments: { form: ["posts"] } });
		const posts = (s.collections as { slug: string; commentsEnabled?: boolean; fields: { slug: string; type: string }[] }[]).find((c) => c.slug === "posts");
		expect(posts?.commentsEnabled).toBe(true);
		expect(posts?.fields.at(-1)).toMatchObject({ slug: "comments_closed", type: "boolean" });
		expect(POSTS_COLLECTION.fields.some((f) => (f.slug as string) === "comments_closed")).toBe(false);
		const pages = (s.collections as { slug: string; commentsEnabled?: boolean }[]).find((c) => c.slug === "pages");
		expect(pages?.commentsEnabled).toBeUndefined();
	});
	it("starter helpers: where the list and form show, the closed check, payload, messages, bodies", () => {
		const cfg = { collections: { posts: { form: true }, pages: { form: false } } };
		expect(showsComments(cfg, "posts")).toBe(true);
		expect(showsComments(undefined, "posts")).toBe(false);
		expect(formOpen(cfg, "posts", false)).toBe(true);
		expect(formOpen(cfg, "posts", 1)).toBe(false);
		expect(formOpen(cfg, "pages", false)).toBe(false);
		const aging = { collections: { posts: { form: true, closedAfterDays: 30 } } };
		expect(formOpen(aging, "posts", false, "2024-01-01T00:00:00Z", Date.parse("2024-01-20"))).toBe(true);
		expect(formOpen(aging, "posts", false, "2024-01-01T00:00:00Z", Date.parse("2024-03-01"))).toBe(false);
		expect(commentPostTarget("/_emdash/api/comments/posts/01ABC", cfg)).toEqual({ collection: "posts", id: "01ABC" });
		expect(commentPostTarget("/_emdash/api/comments/pages/01ABC", cfg)).toBeUndefined();
		expect(commentPostTarget("/_emdash/api/comments/posts/01ABC/reactions", cfg)).toBeUndefined();
		expect(commentPayload({ authorName: " Ana ", authorEmail: "a@x.test", body: " hi ", parentId: "", website_url: "", extra: "x" }, "tok")).toEqual({ authorName: "Ana", authorEmail: "a@x.test", body: " hi ", turnstileToken: "tok" });
		expect(submitMessage(true, { data: { status: "pending" } })).toMatch(/once it is approved/);
		expect(submitMessage(false, { error: { code: "RATE_LIMITED" } })).toMatch(/Too many/);
		expect(commentsHeading(1)).toBe("1 comment");
		expect(bodyParts("Hi\nsee https://x.test/a.\n\nBye").paragraphs).toEqual([[{ text: "Hi" }, { br: true }, { text: "see " }, { text: "https://x.test/a", href: "https://x.test/a" }, { text: "." }], [{ text: "Bye" }]]);
	});
	it("verify reads the count the starter prints", () => {
		expect(commentCountProblem('<section class="comments" id="comments" data-comment-count="3">', 3)).toBeUndefined();
		expect(commentCountProblem('<section data-comment-count="2">', 3)).toBe("2 comments shown, expected 3");
		expect(commentCountProblem("<main></main>", 1)).toBe("no comments section (expected 1)");
	});
	it("client guide: moderation steps, the form's data note, counts only", () => {
		const md = commentsGuide({ collections: [{ slug: "posts", form: true, moderation: "first_time", closedAfterDays: 30, approved: 5 }], turnstile: true });
		expect(md).toContain("# Moderating comments");
		expect(md).toContain("| posts | 5 | on — a visitor's first comment waits for approval");
		expect(md).toContain("Comments closed");
		expect(md).toContain("Turnstile");
		expect(commentsGuide({ collections: [{ slug: "posts", form: false, moderation: "all", closedAfterDays: 0, approved: 2 }], turnstile: false })).toContain("## No new comments");
	});
});
