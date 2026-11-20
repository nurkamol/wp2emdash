/**
 * Per-site overrides (sites/<slug>/overrides.ts): every decision the pipeline cannot infer, as data,
 * so a full rerun from raw exports reproduces the same result. Human reasons go in decisions.md.
 */
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { SECTION_TYPES } from "../ir/schema.js";

// The announcement bar is a site part rebuilt from the live HTML, not a row type an adapter can be forced into.
const sectionOrDrop = z.union([z.enum(SECTION_TYPES.filter((t) => t !== "announcement") as [string, ...string[]]), z.literal("drop")]);

const wpTarget = z.union([z.literal("home"), z.literal("gone"), z.string().regex(/^\//, "a path starting with /")]).optional();

export const overridesSchema = z.object({
	/** WordPress path → EmDash path, when the default mapping is wrong. */
	routes: z.record(z.string(), z.string()).default({}),
	/** `<slug>:<row path>` (from the coverage report) → forced section type, or "drop" for decorative rows. */
	elements: z.record(z.string(), sectionOrDrop).default({}),
	/** Integration id (audit) → decision. */
	integrations: z.record(z.string(), z.enum(["keep", "rebuild", "replace", "drop"])).default({}),
	media: z
		.object({
			/** External media URL (or host) → copy into R2 during load, or keep hotlinked. */
			external: z.record(z.string(), z.enum(["copy", "hotlink"])).default({}),
		})
		.prefault({}),
	redirects: z
		.object({
			/** none = the site has no redirect rules to migrate; file = import raw/redirects.json (made by extract from raw/plugin-exports/). */
			source: z.enum(["unknown", "none", "file"]).default("unknown"),
		})
		.prefault({}),
	/**
	 * Announcement bar found in the live pages (transform report): auto = rebuild it when a known plugin/theme bar is on
	 * most pages, report an uncertain match as a warning; keep = also rebuild the uncertain match; drop = do not rebuild.
	 */
	announcement: z.enum(["auto", "keep", "drop"]).default("auto"),
	/** Footer copyright year: keep = as written; current = a single year after © shows the current year (`{year}`). */
	copyrightYear: z.enum(["keep", "current"]).default("keep"),
	/** legacy_html sections approved to ship as-is: `<slug>:<row path>`. */
	approvedLegacy: z.array(z.string()).default([]),
	/**
	 * Site-wide snippets that need a decision (coverage report → "Site-wide snippets", ids `sn-…`): drop = not needed on
	 * the new site; rebuilt = carried by hand (an embed section, kit.config siteWidgets, analytics…). Reason in decisions.md.
	 */
	snippets: z.record(z.string().regex(/^sn-[0-9a-f]{8}$/), z.enum(["drop", "rebuilt"])).default({}),
	/**
	 * Post types the transform does not migrate on its own (CPTs, Gutenberg/classic posts, products…; coverage report →
	 * "Content types"): skip = not carried (their URLs may answer 404/410 in verify), pages = migrated as pages at their
	 * WordPress address. A reason is required.
	 */
	contentTypes: z.record(z.string(), decision(["skip", "pages"])).default({}),
	/** Taxonomies with terms in use (no taxonomy is migrated yet): skip = archives not rebuilt (URLs follow `wpUrls`). */
	taxonomies: z.record(z.string(), decision(["skip"])).default({}),
	/** Authors with published content (no bylines are migrated yet): skip = no author pages or bylines. */
	authors: decision(["skip"]).optional(),
	/**
	 * Old addresses the owner decided are gone: path patterns (`*` = any characters, query included when the pattern has
	 * one) → reason. Verify accepts 404/410 for them (urls-accounted).
	 */
	gone: z.record(z.string().regex(/^\//, "a path starting with /"), z.string().min(3, "give the owner's reason")).default({}),
	/**
	 * WordPress addresses with no page on the new site (feeds, search, archives, attachment pages, query forms): a path
	 * to 301 to, "home", or "gone" (410). Unset = the kit's default for this site (coverage report → "WordPress URLs").
	 */
	wpUrls: z
		.object({ feed: wpTarget, commentsFeed: wpTarget, search: wpTarget, category: wpTarget, tag: wpTarget, author: wpTarget, date: wpTarget, attachment: wpTarget })
		.prefault({}),
	/**
	 * Customizer "Additional CSS" (coverage report → "Additional CSS"): carry = scaffold writes it to its own stylesheet,
	 * loaded after the starter's CSS; drop = not carried. Selectors written for the WordPress theme rarely match.
	 */
	customCss: z.enum(["carry", "drop"]).optional(),
});

function decision<T extends string>(values: [T, ...T[]]) {
	return z.object({ as: z.enum(values), reason: z.string().min(3, "give the owner's reason") });
}
export type Overrides = z.infer<typeof overridesSchema>;

export async function loadOverrides(file: string): Promise<Overrides> {
	if (!existsSync(file)) return overridesSchema.parse({});
	const mod = (await import(`${pathToFileURL(file).href}?t=${Date.now()}`)) as { default?: unknown };
	const parsed = overridesSchema.safeParse(mod.default ?? {});
	if (!parsed.success) throw new Error(`Invalid ${file}:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
	return parsed.data;
}

/** Decision for an external media URL: exact URL first, then host. */
export function externalMediaDecision(o: Overrides, url: string): "copy" | "hotlink" | undefined {
	if (o.media.external[url]) return o.media.external[url];
	try {
		return o.media.external[new URL(url).host];
	} catch {
		return undefined;
	}
}
