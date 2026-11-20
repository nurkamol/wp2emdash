/**
 * Media folders: REST attachment taxonomies and FileBird / Real Media Library tables (synthetic fixtures in
 * test/fixtures/media-folders) → the folder plan (golden: test/golden/media-folders/plan.json; regenerate after an
 * intended change with UPDATE_GOLDEN=1 pnpm test) → EmDash folders and filing through a fake EmDash API.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentTaxonomies, folderSourceFromRest, folderSourcesFromDump } from "../src/extract/media-folders.js";
import { EmDashApi } from "../src/targets/emdash/api.js";
import { ensureMediaFolders, type FolderResult, fileUnfiledMedia } from "../src/targets/emdash/media-folders.js";
import { folderInputs, type MediaFolderPlan, mediaFoldersReport, planMediaFolders } from "../src/transform/media-folders.js";

const fx = join(import.meta.dirname, "fixtures", "media-folders");
const goldenDir = join(import.meta.dirname, "golden", "media-folders");
const golden = (name: string, value: unknown) => {
	const file = join(goldenDir, name);
	const json = `${JSON.stringify(value, null, 2)}\n`;
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
		mkdirSync(goldenDir, { recursive: true });
		writeFileSync(file, json);
	}
	expect(json).toBe(readFileSync(file, "utf8"));
};

const rest = JSON.parse(readFileSync(join(fx, "rest.json"), "utf8"));
const restSources = () => attachmentTaxonomies(rest.taxonomies).map((t) => folderSourceFromRest(t, rest.terms[t.slug], rest.media));

async function fullPlan() {
	const dump = await folderSourcesFromDump(join(fx, "dump.sql"));
	const inputs = folderInputs({ sources: dump }, { sources: restSources() }, ["filebird", "media-library-plus", "folders"]);
	return planMediaFolders(inputs.sources, inputs.unreachable);
}

describe("media folders: extract", () => {
	it("reads attachment taxonomies, terms and each attachment's term ids over REST", () => {
		const [eml, hf] = restSources();
		expect(eml).toMatchObject({ plugin: "Enhanced Media Library", via: "rest", key: "media_category" });
		expect(eml?.folders.find((f) => f.id === 13)?.name).toBe("Team & Studio");
		expect(eml?.assignments).toEqual({ "101": [12], "102": [13, 11], "105": [14] }); // 999 is not a term: ignored
		expect(hf).toMatchObject({ plugin: "HappyFiles", assignments: { "102": [22], "103": [22] } });
	});

	it("reads FileBird and Real Media Library tables from a dump, nothing else", async () => {
		const [fb, rml, ...rest2] = await folderSourcesFromDump(join(fx, "dump.sql"));
		expect(rest2).toHaveLength(0);
		expect(fb).toMatchObject({ plugin: "FileBird", via: "dump", assignments: { "201": [2], "202": [3], "203": [4], "204": [1] } });
		expect(fb?.folders.find((f) => f.id === 4)).toEqual({ id: 4, name: "It's new", parent: 2 });
		expect(rml?.folders).toEqual([{ id: 5, name: "photos", parent: 0 }, { id: 6, name: "Archive", parent: 5 }]);
		// 206 is a shortcut in Archive and really lives in photos: the real folder comes first.
		expect(rml?.assignments).toEqual({ "205": [6], "201": [5], "206": [5, 6] });
	});
});

describe("media folders: plan", () => {
	it("flattens the trees to 'Parent / Child', dedupes like EmDash, first folder wins (golden)", async () => {
		const plan = await fullPlan();
		golden("plan.json", plan);
		expect(plan.folders).toContain("Photos / Classes / It's new");
		expect(plan.folders.filter((f) => f.toLowerCase() === "photos")).toHaveLength(1); // FileBird "Photos" = RML "photos"
		expect(plan.assignments["201"]).toBe("Photos / Classes"); // FileBird before Real Media Library
		expect(plan.merged).toBe(1); // "Brand / Logos" and "Brand /   logos "
		expect(plan.unreachable.map((u) => u.plugin)).toEqual(["Media Library Folders (Max Foundry)", "Folders (Premio)"]);
		const md = mediaFoldersReport(plan).join("\n");
		expect(md).toContain("## Media folders");
		expect(md).toContain("| FileBird | database dump (`fbv`) | 4 | 4 |");
	});

	it("shortens names past EmDash's 200 characters", () => {
		const plan = planMediaFolders([{ plugin: "X", via: "rest", key: "x", folders: [{ id: 1, name: "a".repeat(150), parent: 0 }, { id: 2, name: "b".repeat(80), parent: 1 }], assignments: { "9": [2] } }]);
		expect(plan.truncated).toBe(1);
		expect(plan.folders.every((f) => f.length <= 200)).toBe(true);
	});
});

/** A fake EmDash media API: folders, media items with folderId, PUT /media/{id}. */
function fakeEmDash(folders: { id: string; name: string }[], media: { id: string; folderId: string | null }[]) {
	const calls: string[] = [];
	let n = 0;
	const json = (data: unknown, status = 200) => new Response(JSON.stringify(status < 400 ? { data } : { error: data }), { status });
	const fetchImpl = (async (url: string, init: RequestInit = {}) => {
		const path = new URL(url).pathname.replace("/_emdash/api", "");
		const method = init.method ?? "GET";
		calls.push(`${method} ${path}`);
		if (path === "/media/folders" && method === "GET") return json({ items: folders });
		if (path === "/media/folders" && method === "POST") {
			const { name } = JSON.parse(String(init.body));
			if (folders.some((f) => f.name.trim().toLowerCase() === name.trim().toLowerCase())) return json({ code: "CONFLICT", message: "exists" }, 409);
			const item = { id: `f${++n}`, name: name.trim() };
			folders.push(item);
			return json({ item }, 201);
		}
		const m = /^\/media\/(.+)$/.exec(path);
		if (m && method === "PUT") {
			const item = media.find((x) => x.id === m[1]);
			if (!item) return json({ code: "NOT_FOUND" }, 404);
			item.folderId = JSON.parse(String(init.body)).folderId;
			return json({ item });
		}
		return json({ code: "NOT_FOUND" }, 404);
	}) as typeof fetch;
	return { api: new EmDashApi("https://emdash.test", { token: "t" }, fetchImpl), calls, folders, media };
}

const fresh = (): FolderResult => ({ created: 0, reused: 0, filed: 0, inPlace: 0, kept: 0, errors: [] });
async function run(env: ReturnType<typeof fakeEmDash>, plan: MediaFolderPlan, idOf: Record<string, string>) {
	const r = fresh();
	const ids = await ensureMediaFolders(env.api, plan, r);
	await fileUnfiledMedia(env.api, plan, ids, (wp) => idOf[wp], new Map(env.media.map((m) => [m.id, m.folderId])), r);
	return r;
}

describe("media folders: load", () => {
	const plan = planMediaFolders([{ plugin: "FileBird", via: "dump", key: "fbv", folders: [{ id: 1, name: "Photos", parent: 0 }, { id: 2, name: "Classes", parent: 1 }], assignments: { "201": [2], "202": [1], "203": [1] } }]);
	const idOf = { "201": "m1", "202": "m2", "203": "m3" };

	it("creates missing folders, reuses an editor's folder by name, files unfiled items", async () => {
		const env = fakeEmDash([{ id: "ed1", name: "photos" }], [{ id: "m1", folderId: null }, { id: "m2", folderId: null }, { id: "m3", folderId: null }]);
		const r = await run(env, plan, idOf);
		expect(r).toMatchObject({ created: 1, reused: 1, filed: 3, errors: [] });
		expect(env.folders).toEqual([{ id: "ed1", name: "photos" }, { id: "f1", name: "Photos / Classes" }]);
		expect(env.media.map((m) => m.folderId)).toEqual(["f1", "ed1", "ed1"]);
	});

	it("is a no-op on rerun", async () => {
		const env = fakeEmDash([{ id: "ed1", name: "photos" }], [{ id: "m1", folderId: null }, { id: "m2", folderId: null }, { id: "m3", folderId: null }]);
		await run(env, plan, idOf);
		env.calls.length = 0;
		const r = await run(env, plan, idOf);
		expect(r).toMatchObject({ created: 0, reused: 2, filed: 0, inPlace: 3 });
		expect(env.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
	});

	it("never moves an item an editor filed, never renames or deletes folders", async () => {
		const env = fakeEmDash([{ id: "ed9", name: "Hero shots" }], [{ id: "m1", folderId: "ed9" }, { id: "m2", folderId: null }]);
		const r = await run(env, plan, idOf);
		expect(r).toMatchObject({ kept: 1, filed: 1 });
		expect(env.media.find((m) => m.id === "m1")?.folderId).toBe("ed9");
		expect(env.calls.some((c) => c.startsWith("DELETE") || /PUT \/media\/folders/.test(c))).toBe(false);
		expect(env.folders.find((f) => f.id === "ed9")?.name).toBe("Hero shots");
	});
});
