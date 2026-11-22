import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { changesCommand, changesText } from "../src/commands/changes.js";
import { buildManifest, diffManifests, formatChanges, MANIFEST_FILE, manifestItems, PREVIOUS_MANIFEST_FILE, rawEntryHash, siteChanges } from "../src/extract/changes.js";
import { changedInWordPress, editedInAdmin, editState, emptyRecord, shouldWrite, updateRecord } from "../src/targets/emdash/content-record.js";

const dirs: string[] = [];
const tmp = () => {
	const d = mkdtempSync(join(tmpdir(), "wp2e-changes-"));
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const put = (file: string, data: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};

const post = (o: Partial<Record<string, unknown>> & { id: number; post_type: string; slug: string }) => ({ status: "publish", title: `T${o.id}`, content: "<p>hello</p>", excerpt: "", date_gmt: "2026-01-01T00:00:00", modified_gmt: "2026-01-01T00:00:00", parent: null, menu_order: 0, taxonomies: {}, meta: {}, ...o });

/** A synthetic raw export (exporter content per type, menus, media manifest, forms). */
function rawExport(dir: string, o: { pages: unknown[]; posts?: unknown[]; menus?: unknown[]; media?: unknown[]; forms?: Record<string, unknown>; extractedAt?: string }) {
	put(join(dir, "exporter", "content", "page.json"), o.pages);
	if (o.posts) put(join(dir, "exporter", "content", "post.json"), o.posts);
	put(join(dir, "exporter", "menus.json"), o.menus ?? []);
	put(join(dir, "media-manifest.json"), o.media ?? []);
	for (const [k, v] of Object.entries(o.forms ?? {})) put(join(dir, "forms", ...k.split("/")), v);
	if (o.extractedAt) put(join(dir, "extract.json"), { extractedAt: o.extractedAt });
}

describe("extract manifest", () => {
	it("builds item paths from parent pages and hashes the raw entry without its modified date", () => {
		const items = manifestItems([post({ id: 1, post_type: "page", slug: "about" }), post({ id: 2, post_type: "page", slug: "team", parent: 1 }), post({ id: 3, post_type: "page", slug: "loop", parent: 3 })] as never);
		expect(items.map((i) => i.path)).toEqual(["about", "about/team", "loop"]);
		const a = post({ id: 9, post_type: "page", slug: "x" });
		expect(rawEntryHash({ ...a, modified_gmt: "2030-01-01T00:00:00" })).toBe(rawEntryHash(a));
		expect(rawEntryHash({ ...a, content: "<p>changed</p>" })).not.toBe(rawEntryHash(a));
	});

	it("returns undefined without a content export", () => {
		expect(buildManifest(tmp())).toBeUndefined();
	});

	it("reports new, edited, moved and deleted entries, menus, media and forms", () => {
		const before = tmp();
		const after = tmp();
		rawExport(before, {
			extractedAt: "2026-11-01T00:00:00Z",
			pages: [post({ id: 1, post_type: "page", slug: "about" }), post({ id: 2, post_type: "page", slug: "team", parent: 1 }), post({ id: 3, post_type: "page", slug: "old" }), post({ id: 4, post_type: "page", slug: "same" })],
			posts: [post({ id: 10, post_type: "post", slug: "hello" })],
			menus: [{ name: "Main", items: [{ id: 1, title: "Home" }] }, { name: "Footer", items: [] }],
			media: [{ id: 100, url: "https://example.test/a.jpg", sha1: "aaa" }, { id: 101, url: "https://example.test/b.jpg", sha1: "bbb" }],
			forms: { "fluent-forms/1.json": { title: "Contact", fields: 2 } },
		});
		rawExport(after, {
			extractedAt: "2026-11-20T00:00:00Z",
			pages: [
				post({ id: 1, post_type: "page", slug: "about-us" }), // moved (and its child moves with it)
				post({ id: 2, post_type: "page", slug: "team", parent: 1 }),
				post({ id: 4, post_type: "page", slug: "same" }),
				post({ id: 5, post_type: "page", slug: "new-page", title: "New page" }),
			],
			posts: [post({ id: 10, post_type: "post", slug: "hello", content: "<p>edited</p>", modified_gmt: "2026-11-19T10:00:00" })],
			menus: [{ name: "Main", items: [{ id: 1, title: "Home" }, { id: 2, title: "Blog" }] }, { name: "Top", items: [] }],
			media: [{ id: 100, url: "https://example.test/a.jpg", sha1: "aaa2" }, { id: 102, url: "https://example.test/c.jpg", sha1: "ccc" }, { url: "https://cdn.example.test/x.png", sha1: "xxx" }],
			forms: { "fluent-forms/1.json": { title: "Contact", fields: 3 }, "cf7/7.json": { title: "Quote" } },
		});
		const prev = buildManifest(before);
		const next = buildManifest(after);
		expect(prev?.extractedAt).toBe("2026-11-01T00:00:00Z");
		const c = diffManifests(prev as never, next as never);
		expect(c.content.added.map((i) => `${i.type}:${i.wpId}`)).toEqual(["page:5"]);
		expect(c.content.deleted.map((i) => i.path)).toEqual(["old"]);
		expect(c.content.moved.map((i) => `${i.previousPath}→${i.path}`)).toEqual(["about→about-us", "about/team→about-us/team"]);
		// The renamed page's raw export changed (its slug); the edited post changed content and modified date.
		expect(c.content.edited.map((i) => `${i.type}:${i.wpId}`)).toEqual(["page:1", "post:10"]);
		expect(c.content.edited.find((i) => i.wpId === 10)?.previousModified).toBe("2026-01-01T00:00:00");
		expect(c.menus).toEqual({ added: ["Top"], edited: ["Main"], deleted: ["Footer"] });
		expect(c.media).toEqual({ before: 2, after: 3, added: 2, removed: 1, changed: 1 });
		expect(c.forms).toEqual({ added: ["Quote (cf7:7)"], edited: ["Contact (fluent-forms:1)"], deleted: [] });
		// page 2 only moved (counted once), page 1 edited + moved (counted once).
		expect(c.total).toBe(1 + 2 + 1 + 1 + 3 + 4 + 2);
		const text = formatChanges(c);
		expect(text).toContain("New (1)");
		expect(text).toContain("page /new-page \"New page\"");
		expect(text).toContain("(was /about/team)");
		expect(text).toContain("Deleted in WordPress (kept in EmDash");
		expect(text).toContain("Media: 2 → 3 (2 new, 1 replaced, 1 gone)");
	});

	it("says so when nothing changed", () => {
		const d = tmp();
		rawExport(d, { pages: [post({ id: 1, post_type: "page", slug: "a" })] });
		const m = buildManifest(d);
		const c = diffManifests(m as never, m as never);
		expect(c.total).toBe(0);
		expect(formatChanges(c)).toMatch(/^No changes in WordPress/);
	});
});

describe("wp2emdash changes", () => {
	const site = (sitesDir: string) => {
		const root = join(sitesDir, "acme");
		put(join(root, "kit.config.ts"), "export default {};\n");
		return root;
	};

	it("explains when there is nothing to compare", () => {
		const sites = tmp();
		const root = site(sites);
		expect(changesCommand("acme", sites).reason).toMatch(/Not extracted yet/);
		rawExport(join(root, "raw"), { pages: [post({ id: 1, post_type: "page", slug: "a" })] });
		expect(siteChanges(join(root, "raw")).reason).toMatch(/older kit/);
		put(join(root, "raw", MANIFEST_FILE), buildManifest(join(root, "raw")));
		expect(changesText(changesCommand("acme", sites))).toMatch(/Only one extract/);
		expect(() => changesCommand("nope", sites)).toThrow(/No site/);
	});

	it("compares the previous and current manifests", () => {
		const sites = tmp();
		const root = site(sites);
		const a = tmp();
		rawExport(a, { pages: [post({ id: 1, post_type: "page", slug: "a" })] });
		rawExport(join(root, "raw"), { pages: [post({ id: 1, post_type: "page", slug: "a" }), post({ id: 2, post_type: "page", slug: "b" })] });
		put(join(root, "raw", PREVIOUS_MANIFEST_FILE), buildManifest(a));
		put(join(root, "raw", MANIFEST_FILE), buildManifest(join(root, "raw")));
		const r = changesCommand("acme", sites);
		expect(r.changes?.content.added.map((i) => i.slug)).toEqual(["b"]);
		expect(changesText(r)).toContain("--overwrite-edited");
		expect(JSON.parse(JSON.stringify(r)).changes.total).toBe(1);
	});
});

describe("load: entries edited in the EmDash admin", () => {
	const rec = { collection: "pages", id: "e1", version: 4, updatedAt: "2026-11-01T00:00:00Z", wpModified: "2026-10-01T00:00:00", wpHash: "h1", loadedAt: "2026-11-01T00:00:00Z" };

	it("tells new, unchanged, edited and conflicting entries apart", () => {
		expect(editState(undefined, { id: "e1", version: 9 }, {})).toBe("new");
		expect(editState(rec, { id: "other", version: 9 }, {})).toBe("new"); // a new database: ids differ
		expect(editState(rec, { id: "e1", version: 4, updatedAt: rec.updatedAt }, { hash: "h2" })).toBe("unchanged");
		expect(editState(rec, { id: "e1", version: 5, updatedAt: "2026-11-05T00:00:00Z" }, { hash: "h1", modified: "2026-10-01T00:00:00" })).toBe("edited");
		expect(editState(rec, { id: "e1", version: 5, updatedAt: "2026-11-05T00:00:00Z" }, { hash: "h2" })).toBe("conflict");
		// Without a raw hash, the WordPress modified date decides.
		expect(changedInWordPress({ ...rec, wpHash: undefined }, { modified: "2026-11-02T00:00:00" })).toBe(true);
		expect(changedInWordPress({ ...rec, wpHash: undefined }, { modified: rec.wpModified })).toBe(false);
		expect(editedInAdmin({ ...rec, version: undefined, updatedAt: undefined }, { id: "e1", version: 99 })).toBe(false);
	});

	it("writes only new and unchanged entries unless --overwrite-edited", () => {
		expect(shouldWrite("new", false)).toBe(true);
		expect(shouldWrite("unchanged", false)).toBe(true);
		expect(shouldWrite("edited", false)).toBe(false);
		expect(shouldWrite("conflict", false)).toBe(false);
		expect(shouldWrite("conflict", true)).toBe(true);
	});

	it("records what load wrote and keeps the old record of entries it left alone", () => {
		const start = { version: 1 as const, entries: { "page:1": rec, "page:2": { ...rec, id: "e2" } } };
		const next = updateRecord(
			start,
			[
				{ key: "page:1", collection: "pages", id: "e1", item: { version: 6, updatedAt: "2026-11-22T00:00:00Z" }, wpModified: "2026-11-21T00:00:00", wpHash: "h9" },
				{ key: "page:2", collection: "pages", id: "e2", item: { version: 12, updatedAt: "2026-11-22T00:00:00Z" } },
				{ key: "page:3", collection: "pages", id: "e3" }, // not read back: no record
			],
			new Set(["page:2"]),
			"2026-11-22T00:00:00Z",
		);
		expect(next.entries["page:1"]).toEqual({ collection: "pages", id: "e1", version: 6, updatedAt: "2026-11-22T00:00:00Z", wpModified: "2026-11-21T00:00:00", wpHash: "h9", loadedAt: "2026-11-22T00:00:00Z" });
		expect(next.entries["page:2"]).toEqual(start.entries["page:2"]);
		expect(next.entries["page:3"]).toBeUndefined();
		expect(emptyRecord()).toEqual({ version: 1, entries: {} });
	});
});
