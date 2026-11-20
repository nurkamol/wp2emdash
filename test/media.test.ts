/**
 * @wp2emdash/media (Media Assistant): detection (oversized, missing alt, unused, duplicates, formats, broken
 * references), the optimize planner and runner, alt text suggestions (mocked Workers AI) and their review, the trash
 * with its undo, confirmation plans before every destructive action, permissions, and the kit side (kit.config,
 * scaffold options, wrangler AI binding, client docs, the Site health check). Synthetic data only; every binding mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { aiAlt, AiLicenseError, cleanAlt, filenameWords, heuristicAlt, review, type Suggestion } from "../packages/media/src/alt.js";
import { DEFAULT_LIMITS, mediaPlugin, type MediaOptions } from "../packages/media/src/index.js";
import { backupKey, BACKUP_PREFIX, expiredBackups, optimizeOne, planOptimize, restoreOriginal } from "../packages/media/src/optimize.js";
import { createPlugin, cronSchedule } from "../packages/media/src/plugin/index.js";
import { confirmView, focalValue } from "../packages/media/src/plugin/views.js";
import { analyse, collectUsage, mentions, type MediaRow, type SourceTable, summaryOf, tableKind, TRASH_FOLDER, trashable } from "../packages/media/src/scan.js";
import { KEYS, grantPlan, redeemPlan } from "../packages/media/src/store.js";
import { mediaCheck } from "../packages/health/src/checks/media.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { wranglerJsonc } from "../src/phases/scaffold.js";
import { mediaDoc, mediaGuide } from "../src/scaffold/media-docs.js";
import { mediaNeedsAi, mediaOptions } from "../src/scaffold/media.js";
import { env } from "./stubs/cloudflare-workers.js";
import { memoryKv } from "./health-fixtures.js";

type B = Record<string, any>;
const ORIGIN = "https://acme.example";
const NOW = Date.parse("2026-11-20T12:00:00Z");
const OLD = "2026-01-01T00:00:00Z";

// ULIDs (Crockford base32, 26 chars).
const ID = { hero: "01JAAAAAAAAAAAAAAAAAAAAAA1", logo: "01JAAAAAAAAAAAAAAAAAAAAAA2", orphan: "01JAAAAAAAAAAAAAAAAAAAAAA3", dupA: "01JAAAAAAAAAAAAAAAAAAAAAA4", dupB: "01JAAAAAAAAAAAAAAAAAAAAAA5", video: "01JAAAAAAAAAAAAAAAAAAAAAA6", svg: "01JAAAAAAAAAAAAAAAAAAAAAA7", hist: "01JAAAAAAAAAAAAAAAAAAAAAA8", fresh: "01JAAAAAAAAAAAAAAAAAAAAAA9", gone: "01JAAAAAAAAAAAAAAAAAAAAAAB", page: "01JPAGEAAAAAAAAAAAAAAAAAA1" };
const key = (id: string, ext = "jpg") => `01KEY${id.slice(5)}.${ext}`;
const row = (id: string, o: Partial<MediaRow> = {}): MediaRow => ({ id, filename: `${id}.jpg`, mimeType: "image/jpeg", size: 200_000, width: 1600, height: 1000, alt: "Something", storageKey: key(id), contentHash: `h-${id}`, folderId: null, createdAt: OLD, focalX: null, focalY: null, ...o });

const LIB: MediaRow[] = [
	row(ID.hero, { filename: "reformer-class-studio.jpg", size: 2_400_000, width: 5000, height: 3000, alt: null }),
	row(ID.logo, { filename: "acme-logo.png", mimeType: "image/png", storageKey: key(ID.logo, "png") }),
	row(ID.orphan, { filename: "IMG_2041.jpg", alt: null, size: 900_000 }),
	row(ID.dupA, { filename: "team.jpg", contentHash: "same" }),
	row(ID.dupB, { filename: "team-copy.jpg", contentHash: "same" }),
	row(ID.video, { filename: "tour.mp4", mimeType: "video/mp4", size: 30 * 1024 * 1024, width: null, height: null }),
	row(ID.svg, { filename: "pattern.svg", mimeType: "image/svg+xml", width: null, height: null }),
	row(ID.hist, { filename: "old-banner.jpg" }),
	row(ID.fresh, { filename: "new-upload.jpg", createdAt: new Date(NOW - 3600_000).toISOString() }),
];

const pt = (style: string, text: string) => ({ _type: "block", style, children: [{ _type: "span", text }] });
const TABLES = (): SourceTable[] => [
	{
		name: "ec_pages",
		rows: [
			{ id: ID.page, slug: "about", title: "About us", status: "published", deleted_at: null, content: JSON.stringify([pt("h2", "Our studio"), { _type: "image", asset: { id: ID.hero, provider: "local", mimeType: "image/jpeg" } }, { _type: "section_gallery", heading: "The team", images: [{ id: ID.dupA, provider: "local" }, { id: ID.gone, provider: "local" }] }]) },
			{ id: "01JPAGEAAAAAAAAAAAAAAAAAA2", slug: "old", title: "Old page", status: "draft", deleted_at: "2026-11-01", content: JSON.stringify([{ _type: "image", asset: { id: ID.video, provider: "local" } }]) },
		],
	},
	{ name: "options", rows: [{ name: "site:logo", value: JSON.stringify({ mediaId: ID.logo }) }, { name: `plugin:media-assistant:trash`, value: JSON.stringify([{ id: ID.orphan }]) }] },
	{ name: "_emdash_widgets", rows: [{ id: "w1", content: `<img src="/_emdash/api/media/file/${key(ID.svg)}">` }] },
	{ name: "revisions", rows: [{ id: "r1", collection: "pages", entry_id: ID.page, data: JSON.stringify({ image: { id: ID.hist, provider: "local" } }) }] },
	{ name: "users", rows: [{ id: "u", avatar: ID.orphan }] },
	{ name: "_emdash_media_usage", rows: [{ media_id: ID.orphan }] },
];
const svgFixed = () => LIB.map((m) => (m.id === ID.svg ? { ...m, storageKey: key(ID.svg) } : m));

describe("usage scan", () => {
	it("classifies tables and never reads the library, the usage index, auth or people", () => {
		expect(tableKind("ec_pages")).toBe("content");
		expect(tableKind("options")).toBe("settings");
		expect(tableKind("revisions")).toBe("revision");
		expect(tableKind("_emdash_menu_items")).toBe("menu");
		for (const t of ["media", "media_folders", "_emdash_media_usage", "users", "credentials", "audit_logs", "_emdash_api_tokens", "sqlite_sequence"]) expect(tableKind(t)).toBeUndefined();
		expect(tableKind("some_new_table")).toBe("other");
	});
	it("finds ids, storage-key URLs, image objects and the heading above them", () => {
		const f = mentions({ content: JSON.stringify([pt("h2", "Our studio"), { _type: "image", asset: { id: ID.hero, provider: "local" } }]), html: `<img src="/_emdash/api/media/file/${key(ID.svg)}">` });
		expect([...f.ids]).toContain(ID.hero);
		expect([...f.keys]).toEqual([key(ID.svg)]);
		expect(f.structured.find((s) => s.id === ID.hero)?.heading).toBe("Our studio");
	});
	it("maps uses per file, skips its own KV rows, and finds broken references in live content only", () => {
		const u = collectUsage(svgFixed(), TABLES());
		expect(u.refs.get(ID.hero)?.[0]).toMatchObject({ kind: "content", label: "Page: About us", collection: "pages", entryId: ID.page, heading: "Our studio" });
		expect(u.refs.get(ID.logo)?.[0]).toMatchObject({ kind: "settings", label: "Site settings (logo)" });
		expect(u.refs.get(ID.video)?.[0]?.kind).toBe("trashed");
		expect(u.refs.get(ID.svg)?.[0]?.kind).toBe("widget");
		expect(u.refs.get(ID.hist)?.map((r) => r.kind)).toEqual(["revision"]);
		expect(u.refs.get(ID.orphan)).toBeUndefined(); // own trash ledger, users and the usage index are not uses
		expect(u.broken).toEqual([expect.objectContaining({ missing: ID.gone, label: "Page: About us" })]);
	});
});

describe("media health report", () => {
	const report = (complete = true) => analyse(svgFixed(), collectUsage(svgFixed(), TABLES(), complete), { now: NOW });
	it("totals by type", () => {
		const r = report();
		expect(r.totals.files).toBe(LIB.length);
		expect(r.totals.byType.video).toEqual({ files: 1, bytes: 30 * 1024 * 1024 });
	});
	it("flags oversized images (pixels, bytes) and videos over 10 MB", () => {
		const r = report();
		const o = Object.fromEntries(r.oversized.map((x) => [x.m.id, x.reasons.join(" | ")]));
		expect(o[ID.hero]).toMatch(/5000×3000 px.*2500.*\| .*MB/);
		expect(o[ID.orphan]).toMatch(/879 KB/);
		expect(o[ID.video]).toMatch(/30\.0 MB/);
		expect(o[ID.logo]).toBeUndefined();
	});
	it("lists images without alt text, those on pages first, with where they are used", () => {
		const r = report();
		expect(r.missingAlt.map((x) => x.m.id)).toEqual([ID.hero, ID.orphan]);
		expect(r.missingAlt[0]?.refs[0]?.label).toBe("Page: About us");
	});
	it("unused: nothing names it; brand files and fresh uploads protected; history-only noted; none when incomplete", () => {
		const r = report();
		const u = Object.fromEntries(r.unused.map((x) => [x.m.id, x]));
		expect(Object.keys(u).sort()).toEqual([ID.orphan, ID.dupB, ID.hist, ID.fresh].sort());
		expect(u[ID.hist]?.historyOnly).toBe(true);
		expect(u[ID.fresh]?.protected).toMatch(/24 hours/);
		expect(u[ID.logo]).toBeUndefined();
		expect(analyse([row(ID.logo, { filename: "logo-dark.png" })], collectUsage([], [])).unused[0]?.protected).toMatch(/brand/);
		expect(report(false).unused).toEqual([]);
		expect(summaryOf(report())).toMatchObject({ missingAlt: 2, missingAltUsed: 1, unused: 3, duplicates: 1, broken: 1 });
	});
	it("duplicates by content hash, and format issues (PNG photo, SVG)", () => {
		const r = report();
		expect(r.duplicates.map((g) => g.items.map((i) => i.m.id))).toEqual([[ID.dupA, ID.dupB]]);
		const lib = [...svgFixed(), row("01JAAAAAAAAAAAAAAAAAAAAAAC", { filename: "photo.png", mimeType: "image/png", size: 2_000_000, width: 2000, height: 1500 })];
		const f = analyse(lib, collectUsage(lib, TABLES()), { now: NOW }).formats.map((x) => x.issue).sort();
		expect(f).toEqual(["png-photo", "svg"]);
	});
	it("files in the trash folder leave the lists; trashable re-checks everything", () => {
		const lib = svgFixed().map((m) => (m.id === ID.orphan ? { ...m, folderId: "trash" } : m));
		const r = analyse(lib, collectUsage(lib, TABLES()), { now: NOW, trashFolderId: "trash" });
		expect(r.trashed).toEqual([ID.orphan]);
		expect(r.unused.some((u) => u.m.id === ID.orphan)).toBe(false);
		expect(trashable(r, ID.orphan)).toEqual({ ok: false, reason: "already in the trash" });
		expect(trashable(r, ID.hero)).toEqual({ ok: false, reason: "it is used on the site" });
		expect(trashable(r, ID.fresh)).toMatchObject({ ok: false });
		expect(trashable(r, ID.dupB)).toEqual({ ok: true });
		expect(trashable(analyse(lib, collectUsage(lib, TABLES(), false)), ID.dupB)).toMatchObject({ ok: false, reason: "the usage scan was incomplete" });
	});
});

describe("optimize planner", () => {
	const L = DEFAULT_LIMITS;
	it("resizes to the longest side, keeps the type, quality 82 for JPEG/WebP", () => {
		expect(planOptimize({ mimeType: "image/jpeg", size: 3e6, width: 5000, height: 3000 }, L)).toEqual({ ok: true, width: 2500, height: 1500, format: "image/jpeg", quality: 82, resize: true, why: "5000×3000 → 2500×1500 px" });
		expect(planOptimize({ mimeType: "image/webp", size: 9e5, width: 1200, height: 3600 }, L)).toMatchObject({ ok: true, width: 833, height: 2500, format: "image/webp" });
		expect(planOptimize({ mimeType: "image/jpeg", size: 9e5, width: 1600, height: 1000 }, L)).toMatchObject({ ok: true, resize: false, why: "re-encode at quality 82" });
	});
	it("PNG: resize only, no quality; refuses what EmDash cannot replace or a plugin cannot read", () => {
		expect(planOptimize({ mimeType: "image/png", size: 4e6, width: 4000, height: 4000 }, L)).toMatchObject({ ok: true, width: 2500, height: 2500, format: "image/png" });
		expect(planOptimize({ mimeType: "image/png", size: 4e6, width: 4000, height: 4000 }, L)).not.toHaveProperty("quality");
		expect(planOptimize({ mimeType: "image/png", size: 9e5, width: 1600, height: 1000 }, L)).toMatchObject({ ok: false, reason: expect.stringMatching(/lossless/) });
		expect(planOptimize({ mimeType: "image/gif", size: 9e6, width: 3000, height: 3000 }, L)).toMatchObject({ ok: false, reason: expect.stringMatching(/GIF/) });
		expect(planOptimize({ mimeType: "image/jpeg", size: 17 * 1024 * 1024, width: 9000, height: 6000 }, L)).toMatchObject({ ok: false, reason: expect.stringMatching(/16 MB/) });
		expect(planOptimize({ mimeType: "image/jpeg", size: 1e5, width: 1600, height: 1000 }, L)).toEqual({ ok: false, reason: "Already within the limits." });
		expect(planOptimize({ mimeType: "video/mp4", size: 3e7, width: null, height: null }, L).ok).toBe(false);
	});
});

const stream = (b: Uint8Array) => new Response(b as Uint8Array<ArrayBuffer>).body as ReadableStream<Uint8Array>;
function fakeImages(outSize: (w: number) => number, fail?: unknown) {
	const calls: B[] = [];
	return {
		calls,
		input: (_s: ReadableStream<Uint8Array>) => ({
			transform: (t: B) => ({
				output: async (o: B) => {
					if (fail) throw fail;
					calls.push({ ...t, ...o });
					return { image: () => stream(new Uint8Array(outSize(t.width as number))), contentType: () => o.format as string };
				},
			}),
		}),
		info: async () => ({ format: "image/jpeg", width: calls.at(-1)?.width as number, height: calls.at(-1)?.height as number, fileSize: 1 }),
	};
}
function fakeBucket() {
	const store = new Map<string, { bytes: Uint8Array; type?: string; meta?: Record<string, string>; uploaded: Date }>();
	return {
		store,
		put: vi.fn(async (k: string, v: Uint8Array, o?: B) => void store.set(k, { bytes: v, type: o?.httpMetadata?.contentType, meta: o?.customMetadata, uploaded: new Date(NOW) })),
		get: vi.fn(async (k: string) => {
			const e = store.get(k);
			return e ? { arrayBuffer: async () => e.bytes.buffer as ArrayBuffer, customMetadata: e.meta, httpMetadata: { contentType: e.type } } : null;
		}),
		delete: vi.fn(async (k: string | string[]) => void [k].flat().forEach((x) => store.delete(x))),
		list: vi.fn(async (o?: B) => ({ objects: [...store.entries()].filter(([k]) => k.startsWith(o?.prefix ?? "")).map(([k, e]) => ({ key: k, size: e.bytes.length, uploaded: e.uploaded, customMetadata: e.meta })), truncated: false })),
	};
}

describe("optimize runner", () => {
	const hero = row(ID.hero, { size: 3_000_000, width: 5000, height: 3000, focalX: 0.2, focalY: 0.8 });
	const deps = (images = fakeImages(() => 400_000), replace = vi.fn(async () => {}), original = 3_000_000) => {
		const bucket = fakeBucket();
		const focal = vi.fn(async () => {});
		return { bucket, replace, focal, images, d: { readBytes: async () => ({ bytes: new Uint8Array(original), mimeType: "image/jpeg" }), images, bucket, replacer: { replace, focal }, now: NOW } };
	};
	it("keeps the old file first, replaces in place with the new size, puts the focal point back", async () => {
		const x = deps();
		const r = await optimizeOne(x.d, hero, DEFAULT_LIMITS);
		expect(r).toMatchObject({ status: "done", before: 3_000_000, after: 400_000, width: 2500, height: 1500 });
		expect(x.images.calls[0]).toEqual({ width: 2500, height: 1500, fit: "scale-down", format: "image/jpeg", quality: 82 });
		const [k, e] = [...x.bucket.store.entries()][0] ?? [];
		expect(k?.startsWith(`${BACKUP_PREFIX}${ID.hero}/`)).toBe(true);
		expect(e?.meta).toMatchObject({ mediaId: ID.hero, width: "5000", height: "3000" });
		expect(x.bucket.put.mock.invocationCallOrder[0]).toBeLessThan(x.replace.mock.invocationCallOrder[0] as number);
		expect(x.replace).toHaveBeenCalledWith(ID.hero, expect.objectContaining({ type: "image/jpeg", width: 2500, height: 1500 }));
		expect(x.focal).toHaveBeenCalledWith(ID.hero, 0.2, 0.8);
	});
	it("a refused replacement removes the kept copy and reports; no gain = left alone; quota errors explained", async () => {
		const x = deps(undefined, vi.fn(async () => Promise.reject(new Error("INVALID_TYPE"))));
		expect(await optimizeOne(x.d, hero, DEFAULT_LIMITS)).toMatchObject({ status: "failed", reason: expect.stringMatching(/INVALID_TYPE/) });
		expect(x.bucket.store.size).toBe(0);
		const y = deps(fakeImages(() => 880_000), undefined, 900_000);
		expect(await optimizeOne(y.d, row(ID.orphan, { size: 900_000 }), DEFAULT_LIMITS)).toMatchObject({ status: "skipped", reason: expect.stringMatching(/less than 10%/) });
		expect(y.replace).not.toHaveBeenCalled();
		const z = deps(fakeImages(() => 1, Object.assign(new Error("quota"), { code: 9422 })));
		expect(await optimizeOne(z.d, hero, DEFAULT_LIMITS)).toMatchObject({ status: "failed", reason: expect.stringMatching(/9422/) });
		expect(z.bucket.store.size).toBe(0);
	});
	it("puts a kept original back with its own size; old copies expire after 30 days", async () => {
		const x = deps();
		await optimizeOne(x.d, hero, DEFAULT_LIMITS);
		const k = [...x.bucket.store.keys()][0] as string;
		expect(await restoreOriginal(x.d, k, hero)).toEqual({ ok: true });
		expect(x.replace).toHaveBeenLastCalledWith(ID.hero, expect.objectContaining({ width: 5000, height: 3000 }));
		expect(await restoreOriginal(x.d, k, row(ID.orphan))).toMatchObject({ ok: false });
		const objs = [{ key: backupKey(ID.hero, NOW, "a.jpg"), uploaded: new Date(NOW), customMetadata: { until: new Date(NOW + 30 * 86400_000).toISOString() } }, { key: `${BACKUP_PREFIX}x/old.jpg`, uploaded: new Date(NOW - 31 * 86400_000) }, { key: "backups/2026-11-01-000000-abcdef12.json.gz", uploaded: new Date(0) }];
		expect(expiredBackups(objs, NOW)).toEqual([`${BACKUP_PREFIX}x/old.jpg`]);
		expect(expiredBackups(objs, NOW + 31 * 86400_000)).toHaveLength(2);
	});
});

describe("alt text suggestions", () => {
	it("reads words from file names, skipping camera names, sizes and hashes", () => {
		expect(filenameWords("reformer-class_studio-1024x768.jpg")).toEqual(["reformer", "class", "studio"]);
		expect(filenameWords("IMG_2041.jpg")).toEqual([]);
		expect(filenameWords("PXL_20240101_123456789.jpg")).toEqual([]);
		expect(filenameWords("a1b2c3d4e5f6a7b8.webp")).toEqual([]);
		expect(heuristicAlt("reformer-class-studio.jpg", [])).toEqual({ text: "Reformer class studio", source: "filename" });
		expect(heuristicAlt("IMG_2041.jpg", [{ kind: "content", label: "Page: About", heading: "Our studio" }])).toEqual({ text: "Our studio", source: "page" });
		expect(heuristicAlt("DSC0001.jpg", [])).toBeUndefined();
	});
	it("cleans model output", () => {
		expect(cleanAlt('Alt text: "An image of three reformer machines in a bright room."\nMore')).toBe("Three reformer machines in a bright room.");
		expect(cleanAlt("x ".repeat(200)).length).toBeLessThanOrEqual(150);
	});
	it("AI: sends a 512 px JPEG copy, not the original; licence errors are told apart", async () => {
		const images = fakeImages(() => 20_000);
		const run = vi.fn(async (_m: string, i: B) => ({ response: `Picture of a studio (${(i.image as number[]).length} bytes)` }));
		expect(await aiAlt({ run }, images, "@cf/meta/llama-3.2-11b-vision-instruct", new Uint8Array(3_000_000), "p")).toBe("A studio (20000 bytes)");
		expect(images.calls[0]).toMatchObject({ width: 512, height: 512, format: "image/jpeg" });
		await expect(aiAlt({ run: async () => Promise.reject(new Error("5016: Prior to using this model, you must submit the prompt 'agree'")) }, images, "m", new Uint8Array(10), "p")).rejects.toBeInstanceOf(AiLicenseError);
	});
	it("review saves only rows marked Save (as edited), drops rejects, keeps the rest", () => {
		const s = (id: string): Suggestion => ({ id, filename: `${id}.jpg`, text: "Old", source: "ai", at: OLD, used: [] });
		const r = review([s("A"), s("B"), s("C"), s("D")], { "do:A": "save", "text:A": "  Edited   text ", "do:B": "reject", "text:C": "Changed", "do:D": "save", "text:D": "" });
		expect(r.saved).toEqual([{ id: "A", text: "Edited text" }]);
		expect(r.rejected).toEqual(["B"]);
		expect(r.kept.map((k) => [k.id, k.text])).toEqual([["C", "Changed"], ["D", "Old"]]);
		expect(r.errors).toHaveLength(1);
	});
});

describe("confirmation plans", () => {
	it("are one-time, kind-bound, person-bound and expire after 10 minutes", async () => {
		const kv = memoryKv();
		const t = await grantPlan(kv, { kind: "trash", ids: [ID.orphan], user: "u1" }, NOW);
		expect(await redeemPlan(kv, t, "delete", "u1", NOW)).toBeUndefined();
		const t2 = await grantPlan(kv, { kind: "trash", ids: [ID.orphan], user: "u1" }, NOW);
		expect(await redeemPlan(kv, t2, "trash", "u2", NOW)).toBeUndefined();
		const t3 = await grantPlan(kv, { kind: "trash", ids: [ID.orphan], user: "u1" }, NOW);
		expect(await redeemPlan(kv, t3, "trash", "u1", NOW + 11 * 60_000)).toBeUndefined();
		const t4 = await grantPlan(kv, { kind: "trash", ids: [ID.orphan], user: "u1" }, NOW);
		expect((await redeemPlan(kv, t4, "trash", "u1", NOW))?.ids).toEqual([ID.orphan]);
		expect(await redeemPlan(kv, t4, "trash", "u1", NOW)).toBeUndefined();
	});
	it("every destructive button carries a confirm dialog", () => {
		for (const k of ["optimize", "trash", "delete", "restore-original"] as const) {
			const run = confirmView(k, "t", [{ file: "a.jpg", detail: "x" }], []).flatMap((b) => (b.elements as B[] | undefined) ?? []).find((e) => e.action_id === `${k}-run`);
			expect(run?.confirm).toMatchObject({ confirm: expect.any(String), deny: "Cancel" });
		}
		expect(confirmView("delete", "", [], ["a: in the trash until 2026-12-20."]).flatMap((b) => (b.elements as B[] | undefined) ?? []).some((e) => e.action_id === "delete-run")).toBe(false);
	});
	it("focal point picks the nearest of nine positions", () => {
		expect(focalValue(0.5, 0.5)).toBe("0.5,0.5");
		expect(focalValue(0.1, 0.9)).toBe("0.15,0.85");
		expect(focalValue(null, null)).toBe("");
	});
});

// ─── The plugin, end to end (fake D1, SELF = EmDash's API, R2, Images, AI) ─────────────────────────────────────

function fakeDb(lib: MediaRow[], tables: SourceTable[], folders: { id: string; name: string }[]) {
	const media = () => lib.map((m) => ({ id: m.id, filename: m.filename, mime_type: m.mimeType, size: m.size, width: m.width, height: m.height, alt: m.alt, storage_key: m.storageKey, content_hash: m.contentHash, folder_id: m.folderId, created_at: m.createdAt, focal_x: m.focalX, focal_y: m.focalY }));
	return {
		prepare(sql: string) {
			let args: unknown[] = [];
			const stmt = {
				bind(...a: unknown[]) {
					args = a;
					return stmt;
				},
				async all() {
					const [limit, offset] = (args.slice(-2) as number[]).map(Number);
					const page = <T>(rows: T[]) => ({ results: rows.slice(offset ?? 0, (offset ?? 0) + (limit ?? rows.length)) });
					if (/FROM media WHERE status/.test(sql)) return page(media());
					if (/FROM media_folders/.test(sql)) return { results: folders.filter((f) => f.name === args[0]).map((f) => ({ id: f.id })) };
					if (/sqlite_master/.test(sql)) return { results: tables.map((t) => ({ name: t.name })) };
					if (/SELECT value FROM options WHERE name = \?/.test(sql)) return { results: [] };
					const t = tables.find((x) => sql.includes(`"${x.name}"`));
					const rows = t?.name === "options" ? t.rows.filter((r) => !String(r.name).startsWith("plugin:media-assistant:")) : (t?.rows ?? []);
					return page(rows);
				},
			};
			return stmt;
		},
	};
}

describe("Media plugin", () => {
	const OPTS: MediaOptions = { productionUrl: ORIGIN, siteName: "Acme", aiAlt: true };
	const plugin = createPlugin(OPTS) as unknown as { capabilities: string[]; hooks: Record<string, any>; admin: B; routes: Record<string, { permission: string; handler: (c: unknown) => Promise<B> }> };
	let kv: ReturnType<typeof memoryKv>;
	let lib: MediaRow[];
	let folders: { id: string; name: string }[];
	let api: { method: string; path: string; body?: unknown }[];
	let bucket: ReturnType<typeof fakeBucket>;
	const updateMetadata = vi.fn(async (_id: string, _p: B) => ({}));
	const readBytes = vi.fn(async (_id: string) => ({ bytes: new Uint8Array(3_000_000), mimeType: "image/jpeg" }));
	const aiRun = vi.fn(async () => ({ response: "Three reformer machines in a bright studio." }));
	const self = vi.fn(async (req: Request) => {
		const u = new URL(req.url);
		const p = u.pathname.replace("/_emdash/api", "");
		const body = req.headers.get("content-type")?.includes("json") ? await req.json() : undefined;
		api.push({ method: req.method, path: p, ...(body ? { body } : {}) });
		expect(req.headers.get("X-EmDash-Request")).toBe("1");
		expect(req.headers.get("cookie")).toBe("session=abc");
		const ok = (data: unknown) => Response.json({ data });
		if (p === "/media/folders" && req.method === "GET") return ok({ items: folders.filter((f) => f.name === u.searchParams.get("q")) });
		if (p === "/media/folders" && req.method === "POST") {
			folders.push({ id: "F1", name: (body as B).name });
			return ok({ item: { id: "F1" } });
		}
		const id = /^\/media\/([0-9A-Z]{26})/.exec(p)?.[1];
		const m = lib.find((x) => x.id === id);
		if (!m) return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
		if (req.method === "PUT" && p.endsWith("/replace")) return ok({ item: {} });
		if (req.method === "PUT") {
			const f = (body as B).folderId;
			m.folderId = f === "unfiled" ? null : f;
			return ok({ item: {} });
		}
		if (req.method === "DELETE") {
			lib = lib.filter((x) => x.id !== id);
			return ok({ deleted: true });
		}
		return ok({});
	});
	const ctx = (input: unknown, role = 40) => ({ input, kv, request: new Request(`${ORIGIN}/_emdash/api/plugins/media-assistant/admin`, { headers: { cookie: "session=abc" } }), user: { id: "u1", name: "Ed", email: "ed@acme.example", role }, media: { readBytes, updateMetadata }, log: { info: vi.fn(), warn: vi.fn() } });
	const call = (input: unknown, role = 40) => plugin.routes.admin?.handler(ctx(input, role)) as Promise<B>;
	const tabs = (r: B) => (r.blocks.find((b: B) => b.type === "tab")?.panels ?? []) as { label: string; blocks: B[] }[];
	const tab = (r: B, name: string) => tabs(r).find((p) => p.label.startsWith(name))?.blocks ?? [];
	const runToken = (r: B, kind: string) => r.blocks.flatMap((b: B) => b.elements ?? []).find((e: B) => e.action_id === `${kind}-run`)?.value as string | undefined;

	beforeEach(() => {
		kv = memoryKv();
		lib = svgFixed().map((m) => ({ ...m }));
		folders = [];
		api = [];
		bucket = fakeBucket();
		for (const k of Object.keys(env)) delete env[k];
		Object.defineProperty(env, "DB", { get: () => fakeDb(lib, TABLES(), folders), configurable: true, enumerable: true });
		Object.assign(env, { SELF: { fetch: self }, MEDIA: bucket, IMAGES: fakeImages(() => 400_000), AI: { run: aiRun } });
		updateMetadata.mockClear();
		// The library keeps what was saved, as EmDash would.
		updateMetadata.mockImplementation(async (id: string, p: B) => {
			const m = lib.find((x) => x.id === id);
			if (m && typeof p.alt === "string") m.alt = p.alt;
			return {};
		});
		aiRun.mockClear();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
	});
	afterEach(() => vi.useRealTimers());

	it("is a native plugin for editors: Media page, widget, upload hook, cron; least capabilities", () => {
		expect(mediaPlugin(OPTS)).toMatchObject({ id: "media-assistant", format: "native", entrypoint: "@wp2emdash/media/plugin" });
		expect(plugin.capabilities).toEqual(["media:read", "media:bytes:read", "media:metadata:write"]);
		expect(plugin.routes.admin?.permission).toBe("content:edit_any");
		expect(plugin.admin.pages[0]).toMatchObject({ path: "/media", label: "Media" });
		expect(Object.keys(plugin.hooks)).toEqual(expect.arrayContaining(["media:afterUpload", "cron"]));
		expect(cronSchedule("acme.example")).toMatch(/^\d{1,2} \* \* \* \*$/);
	});
	it("authors and below see nothing; editors see every tab but Settings; admins see Settings", async () => {
		expect((await call({}, 30)).blocks[0]).toMatchObject({ type: "banner", title: "Editors and admins only" });
		const ed = await call({});
		expect(tabs(ed).map((p) => p.label)).toEqual(["Overview", "Optimize (3)", "Alt text (2)", "Unused (3)", "Duplicates (1)", "Broken (1)", "Trash"]);
		expect(tabs(ed).some((p) => p.label === "Settings")).toBe(false);
		expect(tabs(await call({}, 50)).some((p) => p.label === "Settings")).toBe(true);
		const denied = await call({ type: "form_submit", action_id: "save-settings", values: { aiAlt: false } }, 40);
		expect(denied.toast).toMatchObject({ type: "error" });
		expect(await kv.get(KEYS.settings)).toBeNull();
		expect(await kv.get(KEYS.summary)).toMatchObject({ missingAltUsed: 1, oversized: 3 });
	});
	it("trash: preview → confirm → moved to the trash folder; nothing without the plan; used files refused; undo", async () => {
		// Without a plan nothing happens.
		const none = await call({ type: "block_action", action_id: "trash-run", value: "0".repeat(32) });
		expect(none.toast?.message).toMatch(/expired/);
		expect(api).toEqual([]);
		const preview = await call({ type: "form_submit", action_id: "trash-preview", values: { ids: [ID.dupB, ID.hero, ID.fresh] } });
		expect(preview.blocks.find((b: B) => b.block_id === "plan")?.rows).toEqual([expect.objectContaining({ file: "team-copy.jpg" })]);
		expect(preview.blocks.find((b: B) => b.type === "banner")?.description).toMatch(/reformer-class-studio\.jpg: not moved — it is used on the site.*new-upload\.jpg/);
		expect(api).toEqual([]);
		const moved = await call({ type: "block_action", action_id: "trash-run", value: runToken(preview, "trash") });
		expect(moved.toast).toMatchObject({ type: "success", message: expect.stringMatching(/1 file moved/) });
		expect(api.map((c) => `${c.method} ${c.path}`)).toEqual([`GET /media/folders`, "POST /media/folders", `PUT /media/${ID.dupB}`]);
		expect(folders[0]?.name).toBe(TRASH_FOLDER);
		expect(lib.find((m) => m.id === ID.dupB)?.folderId).toBe("F1");
		// The same plan cannot run twice.
		expect((await call({ type: "block_action", action_id: "trash-run", value: runToken(preview, "trash") })).toast?.message).toMatch(/expired/);
		expect(tab(moved, "Trash")[1]?.rows).toEqual([expect.objectContaining({ file: "team-copy.jpg" })]);
		// Delete for good: refused before 30 days.
		const early = await call({ type: "block_action", action_id: "delete-preview", value: [ID.dupB] });
		expect(early.blocks.find((b: B) => b.type === "banner")?.description).toMatch(/in the trash until/);
		expect(runToken(early, "delete")).toBeUndefined();
		// Undo.
		const back = await call({ type: "block_action", action_id: "untrash", value: ID.dupB });
		expect(back.toast?.type).toBe("success");
		expect(lib.find((m) => m.id === ID.dupB)?.folderId).toBeNull();
		expect(await kv.get(KEYS.trash)).toEqual([]);
	});
	it("delete for good only after 30 days, keeps a last copy first, then asks EmDash to delete", async () => {
		const preview = await call({ type: "form_submit", action_id: "trash-preview", values: { ids: [ID.dupB] } });
		await call({ type: "block_action", action_id: "trash-run", value: runToken(preview, "trash") });
		vi.setSystemTime(NOW + 31 * 86400_000);
		const p = await call({ type: "block_action", action_id: "delete-preview", value: [ID.dupB] });
		const ran = await call({ type: "block_action", action_id: "delete-run", value: runToken(p, "delete") });
		expect(ran.toast?.message).toMatch(/1 file deleted/);
		expect([...bucket.store.keys()].some((k) => k.startsWith(`${BACKUP_PREFIX}${ID.dupB}/deleted-`))).toBe(true);
		expect(api.at(-1)).toMatchObject({ method: "DELETE", path: `/media/${ID.dupB}` });
	});
	it("optimize: preview → confirm → replaced through EmDash, logged, undoable", async () => {
		const p = await call({ type: "block_action", action_id: "optimize-preview", value: [ID.hero, ID.svg] });
		expect(p.blocks.find((b: B) => b.block_id === "plan")?.rows).toEqual([{ file: "reformer-class-studio.jpg", detail: expect.stringMatching(/5000×3000 → 2500×1500/) }]);
		expect(api).toEqual([]);
		const r = await call({ type: "block_action", action_id: "optimize-run", value: runToken(p, "optimize") });
		expect(r.toast?.message).toMatch(/1 file optimized/);
		expect(api.map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /media/${ID.hero}/replace`]);
		expect(await kv.get(KEYS.transforms("2026-11"))).toBe(1);
		const log = (await kv.get<B[]>(KEYS.optimized)) ?? [];
		expect(log[0]).toMatchObject({ id: ID.hero, before: 3_000_000, after: 400_000 });
		const rp = await call({ type: "block_action", action_id: "restore-preview", value: ID.hero });
		const back = await call({ type: "block_action", action_id: "restore-original-run", value: runToken(rp, "restore-original") });
		expect(back.toast?.message).toMatch(/old file is back/);
	});
	it("alt text: suggestions from AI are stored, never written until reviewed; heuristics without AI", async () => {
		const s = await call({ type: "block_action", action_id: "suggest" });
		expect(s.toast?.message).toMatch(/2 suggestions ready to review \(2 from AI\)/);
		expect(updateMetadata).not.toHaveBeenCalled();
		expect(aiRun).toHaveBeenCalledWith("@cf/meta/llama-3.2-11b-vision-instruct", expect.objectContaining({ prompt: expect.stringMatching(/Acme/), image: expect.any(Array) }));
		const r = await call({ type: "form_submit", action_id: "review", values: { [`do:${ID.hero}`]: "save", [`text:${ID.hero}`]: "Reformer machines in the studio", [`do:${ID.orphan}`]: "reject" } });
		expect(updateMetadata).toHaveBeenCalledTimes(1);
		expect(updateMetadata).toHaveBeenCalledWith(ID.hero, { alt: "Reformer machines in the studio" });
		expect(r.toast?.message).toMatch(/1 description saved, 1 rejected/);
		expect(await kv.get(KEYS.suggestions)).toEqual([]);
		// Sensitive site / AI off: file names and headings, no model call.
		await kv.set(KEYS.rejected, []);
		await kv.set(KEYS.settings, { aiAlt: false });
		aiRun.mockClear();
		await call({ type: "block_action", action_id: "suggest" });
		expect(aiRun).not.toHaveBeenCalled();
		// The hero has its description now; IMG_2041.jpg has no words in its name and is on no page: no suggestion.
		expect(((await kv.get<Suggestion[]>(KEYS.suggestions)) ?? []).map((x) => x.source)).toEqual([]);
	});
	it("a licence error marks AI as needing agreement (admins accept it, with a confirm dialog)", async () => {
		aiRun.mockImplementationOnce(async () => Promise.reject(new Error("5016: Prior to using this model, you must submit the prompt 'agree'")));
		const r = await call({ type: "block_action", action_id: "suggest" });
		expect(r.blocks[1]).toMatchObject({ type: "banner", title: expect.stringMatching(/licence/) });
		expect(await kv.get(KEYS.ai)).toMatchObject({ needsAgreement: true });
		const admin = await call({}, 50);
		const agree = tab(admin, "Settings").flatMap((b) => b.elements ?? []).find((e: B) => e.action_id === "ai-agree");
		expect(agree?.confirm).toBeTruthy();
		expect((await call({ type: "block_action", action_id: "ai-agree" }, 40)).toast?.type).toBe("error");
		await call({ type: "block_action", action_id: "ai-agree" }, 50);
		expect(aiRun).toHaveBeenLastCalledWith("@cf/meta/llama-3.2-11b-vision-instruct", { prompt: "agree" });
	});
	it("upload hook queues only when on, and only replaceable images", async () => {
		const hook = plugin.hooks["media:afterUpload"] as (e: unknown, c: unknown) => Promise<void>;
		await hook({ media: { id: ID.hero, mimeType: "image/jpeg" } }, { kv });
		expect(await kv.get(KEYS.queue)).toBeNull();
		await kv.set(KEYS.settings, { autoOptimize: true });
		await hook({ media: { id: ID.hero, mimeType: "image/jpeg" } }, { kv });
		await hook({ media: { id: ID.svg, mimeType: "image/svg+xml" } }, { kv });
		expect(await kv.get(KEYS.queue)).toEqual([ID.hero]);
	});
	it("details: alt text and a focal point saved through the media API", async () => {
		const d = await call({ type: "block_action", action_id: "detail", value: ID.hero });
		expect(d.blocks.find((b: B) => b.block_id === "where")?.rows[0]).toMatchObject({ where: "Page: About us", section: "Our studio" });
		await call({ type: "form_submit", action_id: `save-file:${ID.hero}`, values: { alt: "Studio", focal: "0.15,0.85" } });
		expect(updateMetadata).toHaveBeenCalledWith(ID.hero, { alt: "Studio", focalX: 0.15, focalY: 0.85 });
		updateMetadata.mockClear();
		// A focal value that is not one of the nine positions is ignored: nothing is written.
		expect((await call({ type: "form_submit", action_id: `save-file:${ID.hero}`, values: { focal: "0.3,0.3" } })).toast?.message).toBe("Nothing to save.");
		expect(updateMetadata).not.toHaveBeenCalled();
	});
});

describe("kit wiring", () => {
	const base = { slug: "acme", name: "Acme", source: { url: ORIGIN }, target: { productionUrl: ORIGIN }, email: { to: ["owner@acme.example"], stagingTo: ["team@agency.example"] } };
	it("kit.config: on by default; AI off on sensitive sites unless asked; media: false", () => {
		const c = kitConfigSchema.parse(base);
		expect(c.media).toEqual({ autoOptimize: false, maxDimension: 2500, protect: [] });
		expect(mediaOptions({ config: c, productionUrl: ORIGIN })).toEqual({ productionUrl: ORIGIN, siteName: "Acme", aiAlt: true });
		const s = kitConfigSchema.parse({ ...base, sensitiveData: true });
		expect(mediaOptions({ config: s, productionUrl: ORIGIN })).toMatchObject({ aiAlt: false, sensitive: true });
		expect(mediaOptions({ config: kitConfigSchema.parse({ ...base, sensitiveData: true, media: { aiAlt: true, maxDimension: 3000 } }), productionUrl: ORIGIN })).toMatchObject({ aiAlt: true, limits: { maxDimension: 3000 } });
		expect(mediaOptions({ config: kitConfigSchema.parse({ ...base, media: false }), productionUrl: ORIGIN })).toBeUndefined();
		expect(mediaNeedsAi(undefined)).toBe(false);
	});
	it("wrangler: the AI binding only when AI alt text is on (also in env.staging); SELF for the API", () => {
		const c = kitConfigSchema.parse(base);
		const w = (ai: boolean, staging = false) => wranglerJsonc({ config: c, workerName: "acme", compatibilityDate: "2026-11-20", cf: {} as never, staging, sandboxedEnvs: [], seoPanel: false, media: true, ai, productionHost: "acme.example" });
		expect(w(true)).toContain('"ai": { "binding": "AI" }');
		expect(w(true)).toContain('"binding":"SELF"');
		expect(w(false)).not.toContain('"ai"');
		expect(w(true, true).match(/"ai": \{ "binding": "AI" \}/g)).toHaveLength(2);
	});
	it("client docs: guide section and docs/media.md (sensitive note)", () => {
		expect(mediaGuide(undefined)).toBe("");
		expect(mediaGuide({ aiAlt: true, autoOptimize: false, maxDimension: 2500 })).toContain("Plugins → Media");
		const doc = mediaDoc({ aiAlt: false, autoOptimize: true, maxDimension: 2500 }, { sensitiveData: true });
		expect(doc).toContain("sensitive information");
		expect(doc).toContain("New uploads are queued");
		expect(doc).toContain("30 days");
	});
	it("Site health: a Media check from the scan counts (never an alert)", () => {
		const at = new Date(NOW).toISOString();
		expect(mediaCheck(false, undefined, at).status).toBe("off");
		expect(mediaCheck(true, null, at).status).toBe("unknown");
		expect(mediaCheck(true, { at, missingAltUsed: 0, oversized: 0, broken: 0 }, at, NOW).status).toBe("ok");
		expect(mediaCheck(true, { at, missingAltUsed: 3, oversized: 1, broken: 0 }, at, NOW)).toMatchObject({ status: "warn", summary: expect.stringMatching(/3 images on pages without alt text, 1 oversized original/) });
		expect(mediaCheck(true, { at, missingAltUsed: 0, oversized: 0, broken: 2 }, at, NOW).status).toBe("fail");
	});
});
