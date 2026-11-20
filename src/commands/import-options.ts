/**
 * `wp2emdash import-options <slug> <database.sql>`: builder settings the REST API does not serve, read from a backup's
 * SQL dump (allow-listed option names only) into the files the adapters read. Settings that look like credentials are
 * dropped before anything is written.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BRICKS_OPTIONS } from "../adapters/bricks/site.js";
import { sitePaths } from "../core/paths.js";
import { readOptionsFromDump } from "../extract/sql-options.js";

/** Rank Math and Yoast options the site settings read (social profiles, default sharing image, verification). */
export const SEO_OPTIONS = ["rank-math-options-titles", "rank-math-options-general", "wpseo_social", "wpseo"];

/** WordPress discussion settings (Settings → Discussion) for the comment settings: plain flags and numbers, no secrets. */
export const DISCUSSION_OPTIONS = ["default_comment_status", "comment_moderation", "comment_previously_approved", "close_comments_for_old_posts", "close_comments_days_old", "comment_registration", "require_name_email", "thread_comments", "thread_comments_depth"];

/** SEO options keep `twitter_author_names` (the general filter's "auth" would drop it); credentials still go. */
const SEO_SECRETISH = /(key|secret|token|password|passwd|api_|license|licence|salt|captcha)/i;
const SECRETISH = /(key|secret|token|password|passwd|api|license|licence|salt|auth|captcha)/i;

/** Drop credential-looking fields at any depth (Bricks global settings keep API keys for maps, captcha, mail). */
export function withoutSecrets(v: unknown, dropped: string[] = [], path = "", secretish: RegExp = SECRETISH): unknown {
	if (Array.isArray(v)) return v.map((x, i) => withoutSecrets(x, dropped, `${path}[${i}]`, secretish));
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) {
			if (secretish.test(k) && (typeof x === "string" || typeof x === "number") && String(x).length > 0) {
				dropped.push(`${path}${path ? "." : ""}${k}`);
				continue;
			}
			out[k] = withoutSecrets(x, dropped, `${path}${path ? "." : ""}${k}`, secretish);
		}
		return out;
	}
	return v;
}

export async function importOptions(slug: string, dump: string, sitesDir?: string): Promise<{ file: string; found: string[]; missing: string[]; dropped: string[] }> {
	if (!existsSync(dump)) throw new Error(`No such file: ${dump}`);
	const paths = sitesDir ? sitePaths(slug, sitesDir) : sitePaths(slug);
	const all = await readOptionsFromDump(dump, [...BRICKS_OPTIONS, ...SEO_OPTIONS, ...DISCUSSION_OPTIONS]);
	const raw = Object.fromEntries(Object.entries(all).filter(([k]) => (BRICKS_OPTIONS as readonly string[]).includes(k)));
	const dropped: string[] = [];
	const clean = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, withoutSecrets(v, dropped, k)]));
	const file = join(paths.raw, "bricks-options.json");
	writeFileSync(file, `${JSON.stringify(clean, null, 2)}\n`);
	// SEO plugin options for EmDash's Settings (social profiles, default sharing image, verification): src/transform/settings.ts.
	const seo = Object.fromEntries(Object.entries(all).filter(([k]) => SEO_OPTIONS.includes(k)).map(([k, v]) => [k, withoutSecrets(v, dropped, k, SEO_SECRETISH)]));
	if (Object.keys(seo).length) writeFileSync(join(paths.raw, "seo-options.json"), `${JSON.stringify(seo, null, 2)}\n`);
	// Discussion settings for the comments plan (src/transform/comments.ts): scalars only.
	const discussion = Object.fromEntries(Object.entries(all).filter(([k, v]) => DISCUSSION_OPTIONS.includes(k) && (typeof v === "string" || typeof v === "number")));
	if (Object.keys(discussion).length) writeFileSync(join(paths.raw, "discussion.json"), `${JSON.stringify(discussion, null, 2)}\n`);
	return { file, found: Object.keys(clean), missing: BRICKS_OPTIONS.filter((k) => !(k in clean)), dropped };
}
