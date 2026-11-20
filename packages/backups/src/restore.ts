/**
 * Restore from a backup, in the browser: the site settings, the menus, or ONE entry (a page, post, …). Never the whole
 * site — that stays a guided CLI step (D1 Time Travel restores the database in one transaction; an HTTP restore of
 * every table could not be undone halfway and would race editors).
 *
 * 1. Plan (read-only): the current state is read from D1 with the same reader as a backup, compared with the backup,
 *    and turned into a list of changes people can read, plus a fingerprint of the current state.
 * 2. Apply (after the admin confirms): a fresh backup is taken first (the caller does that); the fingerprint is checked
 *    again — if anything changed since the preview, nothing is written; then the changes go through EmDash's own REST
 *    API as the admin who confirmed (their session, through the Worker's SELF binding), so EmDash validates every
 *    write, keeps revisions and purges its caches exactly as when the admin edits by hand.
 *
 * Settings: one request (EmDash writes it in a transaction). The site address and the staging switch are never
 * restored (they belong to the deployment). An entry: restored from the trash if needed, then one save, then publish
 * if it was published in the backup. Menus: EmDash has no bulk menu write, so items are ADDED first and the old ones
 * removed after — a failure while adding removes what was added (the menu is unchanged); a failure while removing
 * leaves extra items, never a missing menu. Preview again and retry.
 */
import { type BackupDoc, entryData, entryTitle, seoInput, settingsOf } from "./format.js";
import { type D1Db, readRows, readSettingsRows } from "./export.js";
import { sha256Hex } from "./util.js";

export type RestoreKind = "settings" | "menus" | "entry";
export interface Change {
	what: string;
	now: string;
	backup: string;
}
export interface Plan {
	kind: RestoreKind;
	backupId: string;
	title: string;
	changes: Change[];
	notes: string[];
	fingerprint: string;
	/** For an entry: the collection and id. */
	target?: { collection: string; id: string };
}

/** Settings the restore writes (the settings API's fields), and the ones it never touches. */
export const RESTORABLE_SETTINGS = ["title", "tagline", "logo", "favicon", "postsPerPage", "dateFormat", "timezone", "social", "seo"] as const;
export const NEVER_RESTORED = { url: "the site address belongs to this deployment", staging: "the staging switch (noindex everywhere) belongs to this deployment" } as Record<string, string>;
const NULLABLE = new Set(["logo", "favicon"]);

export const show = (v: unknown): string => {
	if (v === undefined || v === null || v === "") return "—";
	const s = typeof v === "string" ? v : JSON.stringify(v);
	return s.length > 140 ? `${s.slice(0, 137)}…` : s;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Flat `key` / `key.sub` view of settings (one level), for the diff. */
function flat(s: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(s)) {
		if (v && typeof v === "object" && !Array.isArray(v) && (k === "seo" || k === "social")) for (const [sk, sv] of Object.entries(v)) out[`${k}.${sk}`] = sv;
		else out[k] = v;
	}
	return out;
}

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

export async function currentSettings(db: D1Db): Promise<Record<string, unknown>> {
	return settingsOf({ tables: { options: { columns: [], rows: await readSettingsRows(db) } } });
}

/** The settings plan and the POST /settings payload (pure). */
export function planSettings(backup: Record<string, unknown>, now: Record<string, unknown>): { changes: Change[]; notes: string[]; payload: Record<string, unknown> } {
	const payload: Record<string, unknown> = {};
	const notes: string[] = [];
	for (const k of RESTORABLE_SETTINGS) {
		if (k in backup) payload[k] = backup[k];
		else if (NULLABLE.has(k) && now[k] != null) payload[k] = null;
	}
	const b = flat(Object.fromEntries(Object.entries(payload)));
	const n = flat(Object.fromEntries(RESTORABLE_SETTINGS.filter((k) => k in now).map((k) => [k, now[k]])));
	const changes: Change[] = [];
	for (const key of [...new Set([...Object.keys(b), ...Object.keys(n)])].sort()) {
		if (same(b[key], n[key])) continue;
		if (!(key in b) && key.includes(".")) {
			notes.push(`${key} is kept as it is (not in the backup; a restore cannot clear it).`);
			continue;
		}
		if (!(key in b)) continue;
		changes.push({ what: key, now: show(n[key]), backup: show(b[key]) });
	}
	for (const [k, why] of Object.entries(NEVER_RESTORED)) if (k in backup && !same(backup[k], now[k])) notes.push(`${k} is not restored: ${why}.`);
	for (const k of Object.keys(backup)) if (!(RESTORABLE_SETTINGS as readonly string[]).includes(k) && !(k in NEVER_RESTORED)) notes.push(`${k} is not restored (not a setting EmDash's settings API writes).`);
	return { changes, notes, payload };
}

// ── Menus ────────────────────────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;
export interface MenuState {
	menus: Row[];
	items: Row[];
}
export async function currentMenus(db: D1Db): Promise<MenuState> {
	return { menus: await readRows(db, "_emdash_menus"), items: await readRows(db, "_emdash_menu_items") };
}
export const menusOf = (doc: Pick<BackupDoc, "tables">): MenuState => ({ menus: doc.tables._emdash_menus?.rows ?? [], items: doc.tables._emdash_menu_items?.rows ?? [] });

const menuKey = (m: Row) => `${m.name}${m.locale ? `@${m.locale}` : ""}`;
/** A menu's items as readable lines, in tree order: "Label → /path" with "  " per level. */
export function menuLines(menu: Row, items: Row[]): string[] {
	const mine = items.filter((i) => i.menu_id === menu.id);
	const out: string[] = [];
	const walk = (parent: unknown, depth: number) => {
		for (const i of mine.filter((x) => (x.parent_id ?? null) === (parent ?? null)).sort((a, b) => Number(a.sort_order) - Number(b.sort_order))) {
			out.push(`${"  ".repeat(depth)}${i.label} → ${i.custom_url ?? (i.reference_collection ? `${i.reference_collection}:${i.reference_id}` : i.type)}`);
			walk(i.id, depth + 1);
		}
	};
	walk(null, 0);
	return out;
}

export function planMenus(backup: MenuState, now: MenuState): { changes: Change[]; notes: string[] } {
	const changes: Change[] = [];
	const notes: string[] = [];
	for (const m of backup.menus) {
		const cur = now.menus.find((x) => menuKey(x) === menuKey(m));
		const want = menuLines(m, backup.items);
		if (!cur) {
			changes.push({ what: `${m.label} (${m.name})`, now: "no such menu", backup: `${want.length} items: ${show(want.map((l) => l.trim()).join(" · "))}` });
			continue;
		}
		const have = menuLines(cur, now.items);
		if (cur.label !== m.label) changes.push({ what: `${m.name}: name shown`, now: show(cur.label), backup: show(m.label) });
		if (same(have, want)) continue;
		const added = want.filter((l) => !have.includes(l));
		const removed = have.filter((l) => !want.includes(l));
		changes.push({ what: `${m.label} (${m.name})`, now: `${have.length} items${removed.length ? `; goes: ${show(removed.map((l) => l.trim()).join(" · "))}` : ""}`, backup: `${want.length} items${added.length ? `; comes back: ${show(added.map((l) => l.trim()).join(" · "))}` : ""}${!added.length && !removed.length ? " (order changes)" : ""}` });
	}
	for (const m of now.menus) if (!backup.menus.some((x) => menuKey(x) === menuKey(m))) notes.push(`Menu "${m.label}" is not in the backup: it is left as it is.`);
	return { changes, notes };
}

// ── One entry ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EntryState {
	row?: Row;
	seo?: Row;
	/** Field slugs the collection has now. */
	fields: string[];
}
export async function currentEntry(db: D1Db, collection: string, id: string): Promise<EntryState> {
	if (!/^[a-z][a-z0-9_]*$/.test(collection)) throw new Error("bad collection name");
	const [rows, seo, coll] = await Promise.all([readRows(db, `ec_${collection}`, "id = ?", [id]), readRows(db, "_emdash_seo", "collection = ? AND content_id = ?", [collection, id]).catch(() => []), readRows(db, "_emdash_collections", "slug = ?", [collection])]);
	const fields = coll[0] ? (await readRows(db, "_emdash_fields", "collection_id = ?", [coll[0].id])).map((f) => String(f.slug)) : [];
	return { ...(rows[0] ? { row: rows[0] } : {}), ...(seo[0] ? { seo: seo[0] } : {}), fields };
}
export function entryOf(doc: Pick<BackupDoc, "tables">, collection: string, id: string): { row?: Row; seo?: Row } {
	const row = doc.tables[`ec_${collection}`]?.rows.find((r) => r.id === id);
	const seo = doc.tables._emdash_seo?.rows.find((r) => r.collection === collection && r.content_id === id);
	return { ...(row ? { row } : {}), ...(seo ? { seo } : {}) };
}
/** Entries a backup holds (for the picker), newest change first. */
export function entriesOf(doc: Pick<BackupDoc, "tables">): { collection: string; id: string; title: string; slug: string; status: string; trashed: boolean; updatedAt: string }[] {
	return Object.entries(doc.tables)
		.filter(([t]) => t.startsWith("ec_"))
		.flatMap(([t, v]) => v.rows.map((r) => ({ collection: t.slice(3), id: String(r.id), title: entryTitle(r), slug: String(r.slug ?? ""), status: String(r.status ?? ""), trashed: !!r.deleted_at, updatedAt: String(r.updated_at ?? "") })))
		.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** The entry plan and the content API write (pure). */
export function planEntry(backup: { row?: Row; seo?: Row }, now: EntryState): { changes: Change[]; notes: string[]; write?: { data: Record<string, unknown>; slug: string | null; seo?: Record<string, unknown>; publish: boolean; fromTrash: boolean; create: boolean } } {
	const notes: string[] = [];
	if (!backup.row) return { changes: [], notes: ["This entry is not in the chosen backup."] };
	const b = backup.row;
	const fields = new Set(now.fields);
	const all = entryData(b);
	const data = Object.fromEntries(Object.entries(all).filter(([k]) => !fields.size || fields.has(k)));
	for (const k of Object.keys(all)) if (fields.size && !fields.has(k)) notes.push(`Field "${k}" no longer exists in this collection: its old value is not restored.`);
	const cur = now.row ? entryData(now.row) : {};
	const changes: Change[] = [];
	if (!now.row) changes.push({ what: "entry", now: "deleted for good", backup: `"${entryTitle(b)}" — created again (it gets a new id; links to it by id must be re-picked)` });
	else if (now.row.deleted_at) changes.push({ what: "trash", now: "in the trash", backup: "taken out of the trash" });
	if (now.row && !same(now.row.slug, b.slug)) changes.push({ what: "address (slug)", now: show(now.row.slug), backup: show(b.slug) });
	for (const k of Object.keys(data).sort()) if (!same(cur[k], data[k])) changes.push({ what: k, now: show(cur[k]), backup: show(data[k]) });
	const seoB = seoInput(backup.seo);
	// No SEO row yet reads as the defaults (empty fields, indexable), not as a change of every field.
	const seoN = seoInput(now.seo ?? {});
	if (seoB) for (const k of Object.keys(seoB)) if (!same(seoB[k], seoN?.[k])) changes.push({ what: `SEO ${k}`, now: show(seoN?.[k]), backup: show(seoB[k]) });
	const publish = b.status === "published";
	if (now.row && now.row.status !== b.status) changes.push({ what: "status", now: String(now.row.status), backup: publish ? "published" : `${String(b.status)} (the restored version is saved as a draft${now.row.status === "published" ? "; the live page stays as it is until someone publishes" : ""})` });
	if (!publish && now.row?.status === "published") notes.push("In the backup this entry was not published: the restore saves its content as a draft of the live page. Publish it in the editor to make it live.");
	return { changes, notes, write: { data, slug: (b.slug as string | null) ?? null, ...(seoB ? { seo: seoB } : {}), publish, fromTrash: !!now.row?.deleted_at, create: !now.row } };
}

export const fingerprint = (state: unknown) => sha256Hex(JSON.stringify(state));

// ── Applying through EmDash's REST API ───────────────────────────────────────────────────────────────────────────

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}
export type Api = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

/**
 * A client for EmDash's own API as the admin who confirmed: their session cookie (or bearer token) and EmDash's CSRF
 * header, sent through the Worker's SELF binding to the host the admin is using. Nothing leaves the Worker.
 */
export function emdashApi(o: { self: (r: Request) => Promise<Response>; origin: string; cookie?: string | null; authorization?: string | null }): Api {
	return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
		const headers: Record<string, string> = { "X-EmDash-Request": "1", accept: "application/json" };
		if (o.cookie) headers.cookie = o.cookie;
		if (o.authorization) headers.authorization = o.authorization;
		if (body !== undefined) headers["content-type"] = "application/json";
		const res = await o.self(new Request(`${o.origin}/_emdash/api${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }));
		const text = await res.text();
		let json: { data?: T; error?: { code?: string; message?: string } } = {};
		try {
			json = text ? JSON.parse(text) : {};
		} catch {
			throw new ApiError(res.status, "NOT_JSON", `${method} ${path.split("?")[0]} → HTTP ${res.status}`);
		}
		if (!res.ok) throw new ApiError(res.status, json.error?.code ?? `HTTP_${res.status}`, `${method} ${path.split("?")[0]} → ${json.error?.code ?? res.status}${json.error?.message ? `: ${json.error.message.slice(0, 160)}` : ""}`);
		return json.data as T;
	};
}

const enc = encodeURIComponent;

export async function applySettings(api: Api, payload: Record<string, unknown>): Promise<void> {
	if (Object.keys(payload).length) await api("POST", "/settings", payload);
}

export async function applyEntry(api: Api, collection: string, id: string, w: NonNullable<ReturnType<typeof planEntry>["write"]>, locale?: string): Promise<{ id: string }> {
	const c = enc(collection);
	if (w.create) {
		const made = await api<{ item?: { id: string }; id?: string }>("POST", `/content/${c}`, { data: w.data, slug: w.slug, ...(w.seo ? { seo: w.seo } : {}), ...(locale ? { locale } : {}) });
		const newId = made.item?.id ?? (made.id as string);
		if (w.publish) await api("POST", `/content/${c}/${enc(newId)}/publish`, {});
		return { id: newId };
	}
	if (w.fromTrash) await api("POST", `/content/${c}/${enc(id)}/restore`, {});
	const got = await api<{ item: unknown; _rev?: string }>("GET", `/content/${c}/${enc(id)}`);
	await api("PUT", `/content/${c}/${enc(id)}`, { data: w.data, slug: w.slug, ...(w.seo ? { seo: w.seo } : {}), ...(got._rev ? { _rev: got._rev } : {}) });
	if (w.publish) await api("POST", `/content/${c}/${enc(id)}/publish`, {});
	return { id };
}

/** Restores every menu in the backup: add the backup's items, then remove the old ones (see the module comment). */
export async function applyMenus(api: Api, backup: MenuState, now: MenuState): Promise<{ added: number; removed: number }> {
	let added = 0;
	let removed = 0;
	for (const m of backup.menus) {
		const name = enc(String(m.name));
		const q = m.locale ? `?locale=${enc(String(m.locale))}` : "";
		const cur = now.menus.find((x) => menuKey(x) === menuKey(m));
		if (same(cur ? menuLines(cur, now.items) : null, menuLines(m, backup.items)) && cur?.label === m.label) continue;
		if (!cur) await api("POST", "/menus", { name: m.name, label: m.label, ...(m.locale ? { locale: m.locale } : {}) });
		else if (cur.label !== m.label) await api("PUT", `/menus/${name}${q}`, { label: m.label });
		const old = cur ? now.items.filter((i) => i.menu_id === cur.id) : [];
		const mine = backup.items.filter((i) => i.menu_id === m.id);
		const created: string[] = [];
		const ids = new Map<unknown, string>();
		try {
			// Parents before children.
			const pending = [...mine];
			while (pending.length) {
				const i = pending.findIndex((x) => !x.parent_id || ids.has(x.parent_id));
				if (i < 0) throw new Error("menu items point at a missing parent");
				const it = pending.splice(i, 1)[0] as Row;
				const body = {
					type: it.type,
					label: it.label,
					...(it.reference_collection ? { referenceCollection: it.reference_collection } : {}),
					...(it.reference_id ? { referenceId: it.reference_id } : {}),
					...(it.custom_url ? { customUrl: it.custom_url } : {}),
					...(it.target ? { target: it.target } : {}),
					...(it.title_attr ? { titleAttr: it.title_attr } : {}),
					...(it.css_classes ? { cssClasses: it.css_classes } : {}),
					...(it.parent_id ? { parentId: ids.get(it.parent_id) } : {}),
					sortOrder: Math.max(0, Number(it.sort_order) || 0),
				};
				const r = await api<{ item?: { id: string }; id?: string }>("POST", `/menus/${name}/items${q}`, body);
				const newId = r.item?.id ?? (r.id as string);
				ids.set(it.id, newId);
				created.push(newId);
				added++;
			}
		} catch (e) {
			for (const id of created.reverse()) await api("DELETE", `/menus/${name}/items/${enc(id)}${q}`).catch(() => {});
			throw e;
		}
		// Old items, children first (a parent's removal may take its children along: a 404 then is fine).
		const depth = (i: Row): number => (i.parent_id ? 1 + depth(old.find((x) => x.id === i.parent_id) ?? {}) : 0);
		for (const it of [...old].sort((a, b) => depth(b) - depth(a))) {
			try {
				await api("DELETE", `/menus/${name}/items/${enc(String(it.id))}${q}`);
				removed++;
			} catch (e) {
				if (!(e instanceof ApiError && e.status === 404)) throw e;
			}
		}
	}
	return { added, removed };
}
