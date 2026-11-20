/**
 * Writing EmDash's site settings without clobbering an editor (docs/spikes/settings-findings.md).
 *
 * Load records a hash of every value it wrote (sites/<slug>/load/settings.<target>.json). On the next run a setting
 * whose current value no longer matches that hash was changed in the admin: it is kept unless the run passes
 * --overwrite-settings. POST /_emdash/api/settings merges: top-level keys are replaced, `seo` and `social` are merged
 * field by field, so the payload carries only the fields to write.
 */
import { createHash } from "node:crypto";
import type { IrSite } from "../../ir/schema.js";
import type { IrSettings } from "../../transform/settings.js";

/** A flat setting path ("title", "social.facebook", "seo.defaultOgImage") → its value. Media as { mediaId, alt? }. */
export type FlatSettings = Record<string, unknown>;

export interface SettingsRecord {
	/** Setting path → hash of the value load last wrote (or found equal to what it would write). */
	written: Record<string, string>;
}

export interface SettingsPlan {
	/** The POST /settings body (nested). Empty when there is nothing to write. */
	payload: Record<string, unknown>;
	record: SettingsRecord;
	written: string[];
	unchanged: string[];
	/** Changed in the admin since the last load: kept. */
	kept: string[];
	/** The record matched nothing on the target (a reset or new database) and was ignored. */
	staleRecord?: boolean;
}

/** Paths load manages, in the order the report lists them. */
export const SETTING_PATHS = ["title", "tagline", "logo", "favicon", "postsPerPage", "dateFormat", "timezone", "social.twitter", "social.github", "social.facebook", "social.instagram", "social.linkedin", "social.youtube", "seo.titleSeparator", "seo.defaultOgImage", "seo.googleVerification", "seo.bingVerification", "seo.robotsTxt"] as const;

type Media = { mediaId: string; alt?: string } | undefined;

/** Everything load writes, as flat paths: identity from site.json, the rest from ir/settings.json, media resolved by load. */
export function desiredSettings(site: Pick<IrSite, "title" | "tagline">, s: IrSettings | undefined, x: { titleSeparator?: string; logo?: Media; favicon?: Media; defaultOgImage?: Media }): FlatSettings {
	const out: FlatSettings = { title: site.title };
	const put = (k: string, v: unknown) => {
		if (v !== undefined && v !== null && v !== "") out[k] = v;
	};
	put("tagline", site.tagline);
	put("logo", x.logo);
	put("favicon", x.favicon);
	put("postsPerPage", s?.postsPerPage);
	put("dateFormat", s?.dateFormat);
	put("timezone", s?.timezone);
	for (const [n, url] of Object.entries(s?.social ?? {})) put(`social.${n}`, url);
	put("seo.titleSeparator", s?.seo.titleSeparator ?? x.titleSeparator);
	put("seo.defaultOgImage", x.defaultOgImage);
	put("seo.googleVerification", s?.seo.googleVerification);
	put("seo.bingVerification", s?.seo.bingVerification);
	put("seo.robotsTxt", s?.seo.robotsTxt);
	return out;
}

/** The comparable part of a value: a media reference by its media id only (the admin rewrites alt and resolved fields). */
export function normalizeSetting(v: unknown): unknown {
	if (v === null || v === undefined) return undefined;
	if (typeof v === "string") return v.trim() ? v.replace(/\r\n?/g, "\n").trimEnd() : undefined;
	if (typeof v === "object" && !Array.isArray(v) && "mediaId" in (v as object)) {
		const id = (v as { mediaId?: unknown }).mediaId;
		return typeof id === "string" && id ? { mediaId: id } : undefined;
	}
	return v;
}

export const settingHash = (v: unknown) => createHash("sha256").update(JSON.stringify(normalizeSetting(v) ?? null)).digest("hex").slice(0, 16);

/** Read a flat path from the GET /settings response. */
export function settingAt(current: Record<string, unknown>, path: string): unknown {
	let v: unknown = current;
	for (const k of path.split(".")) v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
	return v;
}

/**
 * Decide what to write. Per setting:
 * - the target already holds the value → unchanged (recorded, so a later admin edit is recognised);
 * - load wrote it before and the target's value is no longer that → changed in the admin → kept (overwrite: written);
 * - never written by load: written — except on a live production site, where a value already there is an editor's
 *   (sites loaded before load kept this record) and is kept unless overwrite.
 */
export function planSettings(o: { desired: FlatSettings; current: Record<string, unknown>; record?: SettingsRecord; overwrite?: boolean; live?: boolean }): SettingsPlan {
	// A record none of whose values is on the target any more belongs to an earlier database (a reset local dev site, a
	// re-provisioned target): an editor does not change every setting load wrote, so it is ignored.
	const prior = Object.entries(o.record?.written ?? {});
	const stale = prior.length > 0 && !prior.some(([p, h]) => settingHash(settingAt(o.current, p)) === h);
	const record: SettingsRecord = { written: stale ? {} : Object.fromEntries(prior) };
	const payload: Record<string, unknown> = {};
	const written: string[] = [];
	const unchanged: string[] = [];
	const kept: string[] = [];
	for (const [path, want] of Object.entries(o.desired)) {
		if (normalizeSetting(want) === undefined) continue;
		const have = settingAt(o.current, path);
		const wantHash = settingHash(want);
		const haveHash = settingHash(have);
		if (haveHash === wantHash) {
			unchanged.push(path);
			record.written[path] = wantHash;
			continue;
		}
		const last = record.written[path];
		const editorChanged = last !== undefined ? haveHash !== last : !!o.live && normalizeSetting(have) !== undefined;
		if (editorChanged && !o.overwrite) {
			kept.push(path);
			continue;
		}
		const [head, field] = path.split(".") as [string, string | undefined];
		if (field) payload[head] = { ...((payload[head] as Record<string, unknown> | undefined) ?? {}), [field]: want };
		else payload[head] = want;
		record.written[path] = wantHash;
		written.push(path);
	}
	return { payload, record, written, unchanged, kept, ...(stale ? { staleRecord: true } : {}) };
}
