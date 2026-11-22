/**
 * What changed in WordPress since the last extract (`wp2emdash changes <slug>`, and the summary at the end of extract).
 * For sites whose owner keeps editing WordPress during the migration.
 *
 * Every complete extract writes a compact manifest of what it read (raw/manifest.json: per entry type, WordPress id,
 * slug, path, title, status, modified date and a hash of the raw export; menus, media and forms as hashes), and keeps the
 * previous one beside it (raw/manifest.previous.json). The two are compared here. A site extracted before manifests
 * existed gets its previous manifest derived from the raw export already on disk, once.
 *
 * Reports only: nothing is deleted from EmDash because it disappeared from WordPress (load never deletes entries).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_FILE = "manifest.json";
export const PREVIOUS_MANIFEST_FILE = "manifest.previous.json";
export const CHANGES_REPORT = "changes.json";

export interface ManifestItem {
	type: string;
	wpId: number;
	slug: string;
	/** The entry's path from its parents' slugs (`about/team` for a child page); the slug for flat types. */
	path: string;
	title: string;
	status: string;
	modified?: string;
	/** Short hash of the raw export of the entry (content, meta, terms…), without its modified date. */
	rawHash: string;
}

export interface Manifest {
	version: 1;
	extractedAt?: string;
	items: ManifestItem[];
	menus: { name: string; items: number; hash: string }[];
	/** `wp:<id>` or the file URL → file hash (sha1 of the bytes, else of the URL). */
	media: Record<string, string>;
	forms: { key: string; title: string; hash: string }[];
}

export interface ItemChange {
	type: string;
	wpId: number;
	slug: string;
	path: string;
	title: string;
	status: string;
	modified?: string;
}
export interface ChangeSet {
	from?: string;
	to?: string;
	content: {
		added: ItemChange[];
		/** The raw export or the modified date changed. */
		edited: (ItemChange & { previousModified?: string })[];
		deleted: ItemChange[];
		/** The slug or path changed (the entry may be edited too). */
		moved: (ItemChange & { previousPath: string })[];
	};
	menus: { added: string[]; edited: string[]; deleted: string[] };
	media: { before: number; after: number; added: number; removed: number; changed: number };
	forms: { added: string[]; edited: string[]; deleted: string[] };
	total: number;
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);
const readJson = <T>(file: string): T | undefined => {
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
};

interface RawPost {
	id: number;
	post_type: string;
	status?: string;
	slug?: string;
	title?: string;
	modified_gmt?: string;
	parent?: number | null;
}

/** Hash of the raw entry without the fields that change on every save (modified date). */
export function rawEntryHash(p: Record<string, unknown>): string {
	const { modified_gmt: _m, modified: _m2, ...rest } = p;
	return hash(JSON.stringify(rest));
}

/** Entries of one type → manifest items, with each entry's path from its parents' slugs. */
export function manifestItems(posts: RawPost[]): ManifestItem[] {
	const byKey = new Map(posts.map((p) => [`${p.post_type}:${p.id}`, p]));
	const pathOf = (p: RawPost): string => {
		const parts: string[] = [];
		const seen = new Set<number>();
		let cur: RawPost | undefined = p;
		while (cur && !seen.has(cur.id)) {
			seen.add(cur.id);
			parts.unshift(cur.slug || String(cur.id));
			cur = cur.parent ? byKey.get(`${cur.post_type}:${cur.parent}`) : undefined;
		}
		return parts.join("/");
	};
	return posts.map((p) => ({
		type: p.post_type,
		wpId: p.id,
		slug: p.slug ?? "",
		path: pathOf(p),
		title: typeof p.title === "string" ? p.title : "",
		status: p.status ?? "",
		...(p.modified_gmt ? { modified: p.modified_gmt } : {}),
		rawHash: rawEntryHash(p as unknown as Record<string, unknown>),
	}));
}

/**
 * Builds the manifest of the raw export in `rawDir` (exporter/content/*.json, exporter/menus.json,
 * media-manifest.json, forms/<provider>/<id>.json). Undefined when there is no content export there.
 */
export function buildManifest(rawDir: string): Manifest | undefined {
	const contentDir = join(rawDir, "exporter", "content");
	if (!existsSync(contentDir)) return undefined;
	const files = readdirSync(contentDir).filter((f) => f.endsWith(".json")).sort();
	if (!files.length) return undefined;
	const posts = files.flatMap((f) => readJson<RawPost[]>(join(contentDir, f)) ?? []).filter((p) => p && typeof p.id === "number" && typeof p.post_type === "string");
	const menus = (readJson<{ name: string; items?: unknown[] }[]>(join(rawDir, "exporter", "menus.json")) ?? []).map((m) => ({ name: m.name, items: m.items?.length ?? 0, hash: hash(JSON.stringify(m.items ?? [])) }));
	const media: Record<string, string> = {};
	for (const m of readJson<{ id?: number; url: string; sha1?: string }[]>(join(rawDir, "media-manifest.json")) ?? []) media[m.id ? `wp:${m.id}` : m.url] = m.sha1 ?? hash(m.url);
	const forms: Manifest["forms"] = [];
	const formsDir = join(rawDir, "forms");
	if (existsSync(formsDir)) {
		for (const provider of readdirSync(formsDir).sort()) {
			const dir = join(formsDir, provider);
			if (!statSync(dir).isDirectory()) continue;
			for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
				const text = readFileSync(join(dir, f), "utf8");
				let title = "";
				try {
					title = String((JSON.parse(text) as { title?: unknown }).title ?? "");
				} catch {}
				forms.push({ key: `${provider}:${f.replace(/\.json$/, "")}`, title, hash: hash(text) });
			}
		}
	}
	const summary = readJson<{ extractedAt?: string }>(join(rawDir, "extract.json"));
	return { version: 1, ...(summary?.extractedAt ? { extractedAt: summary.extractedAt } : {}), items: manifestItems(posts), menus, media, forms };
}

export function readManifest(file: string): Manifest | undefined {
	const m = readJson<Manifest>(file);
	return m?.version === 1 && Array.isArray(m.items) ? m : undefined;
}

const change = (i: ManifestItem): ItemChange => ({ type: i.type, wpId: i.wpId, slug: i.slug, path: i.path, title: i.title, status: i.status, ...(i.modified ? { modified: i.modified } : {}) });

/** Compares two manifests: new, edited, deleted and moved entries; menus, media counts and forms. */
export function diffManifests(prev: Manifest, next: Manifest): ChangeSet {
	const key = (i: ManifestItem) => `${i.type}:${i.wpId}`;
	const before = new Map(prev.items.map((i) => [key(i), i]));
	const after = new Map(next.items.map((i) => [key(i), i]));
	const content: ChangeSet["content"] = { added: [], edited: [], deleted: [], moved: [] };
	for (const [k, n] of after) {
		const p = before.get(k);
		if (!p) {
			content.added.push(change(n));
			continue;
		}
		if (p.rawHash !== n.rawHash || (p.modified ?? "") !== (n.modified ?? "")) content.edited.push({ ...change(n), ...(p.modified ? { previousModified: p.modified } : {}) });
		if (p.path !== n.path || p.slug !== n.slug) content.moved.push({ ...change(n), previousPath: p.path });
	}
	for (const [k, p] of before) if (!after.has(k)) content.deleted.push(change(p));
	const byName = (l: Manifest["menus"]) => new Map(l.map((m) => [m.name, m]));
	const mb = byName(prev.menus);
	const ma = byName(next.menus);
	const menus = { added: [...ma.keys()].filter((n) => !mb.has(n)), edited: [...ma].filter(([n, m]) => mb.has(n) && mb.get(n)?.hash !== m.hash).map(([n]) => n), deleted: [...mb.keys()].filter((n) => !ma.has(n)) };
	const media = { before: Object.keys(prev.media).length, after: Object.keys(next.media).length, added: 0, removed: 0, changed: 0 };
	for (const [k, h] of Object.entries(next.media)) {
		if (!(k in prev.media)) media.added++;
		else if (prev.media[k] !== h) media.changed++;
	}
	for (const k of Object.keys(prev.media)) if (!(k in next.media)) media.removed++;
	const fb = new Map(prev.forms.map((f) => [f.key, f]));
	const fa = new Map(next.forms.map((f) => [f.key, f]));
	const label = (f: { key: string; title: string }) => (f.title ? `${f.title} (${f.key})` : f.key);
	const forms = {
		added: [...fa.values()].filter((f) => !fb.has(f.key)).map(label),
		edited: [...fa.values()].filter((f) => fb.has(f.key) && fb.get(f.key)?.hash !== f.hash).map(label),
		deleted: [...fb.values()].filter((f) => !fa.has(f.key)).map(label),
	};
	const sortItems = <T extends ItemChange>(l: T[]) => l.sort((a, b) => a.type.localeCompare(b.type) || a.path.localeCompare(b.path));
	for (const l of Object.values(content)) sortItems(l as ItemChange[]);
	const movedOnly = content.moved.filter((m) => !content.edited.some((e) => e.type === m.type && e.wpId === m.wpId)).length;
	const total = content.added.length + content.edited.length + content.deleted.length + movedOnly + menus.added.length + menus.edited.length + menus.deleted.length + media.added + media.removed + media.changed + forms.added.length + forms.edited.length + forms.deleted.length;
	return { ...(prev.extractedAt ? { from: prev.extractedAt } : {}), ...(next.extractedAt ? { to: next.extractedAt } : {}), content, menus, media, forms, total };
}

/** Short, grouped human summary of a change set. */
export function formatChanges(c: ChangeSet, opts: { max?: number } = {}): string {
	const max = opts.max ?? 15;
	const lines: string[] = [];
	const span = c.from || c.to ? ` (${c.from ?? "?"} → ${c.to ?? "?"})` : "";
	if (!c.total) return `No changes in WordPress since the previous extract${span}.`;
	lines.push(`Changes in WordPress since the previous extract${span}: ${c.total}`);
	const item = (i: ItemChange) => `${i.type} /${i.path}${i.title ? ` "${i.title.slice(0, 60)}"` : ""}${i.status && i.status !== "publish" ? ` [${i.status}]` : ""}`;
	const group = (label: string, list: string[]) => {
		if (!list.length) return;
		lines.push(`  ${label} (${list.length})`);
		for (const l of list.slice(0, max)) lines.push(`    ${l}`);
		if (list.length > max) lines.push(`    … ${list.length - max} more (--json for all)`);
	};
	group("New", c.content.added.map(item));
	group("Edited", c.content.edited.map(item));
	group("Moved", c.content.moved.map((m) => `${item(m)} (was /${m.previousPath})`));
	group("Deleted in WordPress (kept in EmDash; remove by hand if wanted)", c.content.deleted.map(item));
	const menus = [...c.menus.added.map((n) => `${n}: new`), ...c.menus.edited.map((n) => `${n}: edited`), ...c.menus.deleted.map((n) => `${n}: deleted`)];
	group("Menus", menus);
	if (c.media.added || c.media.removed || c.media.changed) lines.push(`  Media: ${c.media.before} → ${c.media.after} (${c.media.added} new, ${c.media.changed} replaced, ${c.media.removed} gone)`);
	const forms = [...c.forms.added.map((n) => `${n}: new`), ...c.forms.edited.map((n) => `${n}: edited`), ...c.forms.deleted.map((n) => `${n}: gone`)];
	group("Forms", forms);
	return lines.join("\n");
}

/** The previous and current manifests of a site's raw export, compared. */
export function siteChanges(rawDir: string): { changes?: ChangeSet; reason?: string } {
	const current = readManifest(join(rawDir, MANIFEST_FILE));
	if (!current) return { reason: existsSync(join(rawDir, "exporter", "content")) ? "No manifest yet: the last extract ran on an older kit. Run extract again; from then on each extract is compared with the one before." : "Not extracted yet: run extract first." };
	const previous = readManifest(join(rawDir, PREVIOUS_MANIFEST_FILE));
	if (!previous) return { reason: "Only one extract so far: nothing to compare with. Run extract again after WordPress changes." };
	return { changes: diffManifests(previous, current) };
}
