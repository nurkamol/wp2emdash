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

const EMDASH_FIELD_TYPES = ["string", "text", "url", "number", "integer", "boolean", "datetime", "select", "multiSelect", "portableText", "image", "file", "json"] as const;
const collectionDecision = z.object({
	as: z.literal("collection"),
	name: z.string().regex(/^[a-z][a-z0-9_]*$/, "a collection slug: lowercase letters, digits, underscores").optional(),
	reason: z.string().optional(),
	fields: z.record(z.string(), z.enum([...EMDASH_FIELD_TYPES, "skip"])).optional(),
});

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
			/**
			 * Which media-library files load uploads besides the ones content uses (and the files content links to, always):
			 * "documents" (default) = every PDF, Word, Excel, ZIP… file in the library too, so links from emails and other
			 * sites keep working through the old upload address; "referenced" = only what content uses; "all" = every file.
			 */
			library: z.enum(["referenced", "documents", "all"]).default("documents"),
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
	 * Post types (CPTs, Gutenberg/classic posts, products…; coverage report → "Content types" and "Custom post types"):
	 * skip = not carried (their URLs may answer 404/410 in verify), pages = migrated as pages at their WordPress address
	 * (a reason is required for both); collection = its own EmDash collection (the default for a public post type the
	 * Exporter describes): `name` renames the collection, `fields` maps meta keys no field definition describes to an
	 * EmDash field type, or leaves a field out ("skip").
	 */
	contentTypes: z.record(z.string(), z.union([decision(["skip", "pages"]), collectionDecision])).default({}),
	/**
	 * Taxonomies with terms in use that the blog does not migrate (taxonomies of other post types; categories/tags when
	 * posts are skipped): skip = archives not rebuilt (URLs follow `wpUrls`).
	 */
	taxonomies: z.record(z.string(), decision(["skip"])).default({}),
	/** Authors with published content: skip = no bylines or author pages (blog sites get bylines by default). */
	authors: decision(["skip"]).optional(),
	/**
	 * Private and password-protected posts (EmDash has no private or password status; coverage report → "Blog"):
	 * draft = loaded as drafts (editors see them, visitors do not); skip = not migrated; publish = public on the new site
	 * (password-protected only: the password is dropped). A reason is required.
	 */
	protectedPosts: decision(["draft", "skip", "publish"]).optional(),
	/**
	 * Password-protected and private pages and posts (src/transform/protected.ts; coverage report → "Protected content").
	 * Unset = the defaults: password → "protect" (published behind the starter's password page with the WordPress password,
	 * hashed; noindex, not in the sitemap, never cached), private → "draft" (editors only, as on WordPress).
	 * `protectedPosts`, when set, still decides posts.
	 */
	protectedContent: z
		.object({
			password: decision(["protect", "draft", "skip", "publish"]).optional(),
			private: decision(["draft", "skip", "publish"]).optional(),
		})
		.optional(),
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
	/**
	 * WordPress comments (coverage report → Comments). migrate: import approved comments (default on, except on a site
	 * with sensitiveData, which needs this decision); includePending: also import pending ones into the moderation
	 * queue; form: the comment form for new comments (default: where WordPress took comments; off on sensitive sites);
	 * moderation / closedAfterDays: EmDash's collection settings instead of WordPress's discussion settings. A reason is
	 * required whenever migrate or form is set.
	 */
	comments: z
		.object({
			migrate: z.boolean().optional(),
			includePending: z.boolean().optional(),
			form: z.boolean().optional(),
			moderation: z.enum(["all", "first_time", "none"]).optional(),
			closedAfterDays: z.number().int().min(0).optional(),
			reason: z.string().min(3, "give the owner's reason").optional(),
		})
		.refine((c) => (c.migrate === undefined && c.form === undefined) || !!c.reason, { message: "give the owner's reason (comments.reason) for comments.migrate / comments.form" })
		.optional(),
	/**
	 * Classic-theme widgets the kit has no mapping for (coverage report → "Widgets", ids like `calendar-2`): html = keep
	 * the widget's rendered HTML as a content widget in the same EmDash widget area; skip = not carried (the owner's
	 * choice). Unknown widgets without a decision fail the transform gate `widgets-handled`.
	 */
	widgets: z.record(z.string(), z.enum(["html", "skip"])).default({}),
	/**
	 * Pages rebuilt from the live page's rendered HTML by the DOM fallback (a builder without an adapter; coverage report →
	 * "Rebuilt from rendered HTML"): page slug → the owner's note that the rebuilt page was checked against the live one
	 * (who, when, what was fixed). Until every such published page has one, the transform gate `dom-fallback-reviewed` fails.
	 */
	domFallbackReviewed: z.record(z.string(), z.string().min(3, "give the owner's review note")).default({}),
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
