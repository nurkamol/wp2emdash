/**
 * Site chrome every page shows: site settings, the primary and secondary menus, the footer and announcement site
 * parts, and the popups. Loaded in the PAGE's frontmatter (pages/[...slug].astro, pages/404.astro) and handed to the
 * layout, because route-cache tags only reach the response when they are set before Astro starts streaming it: a
 * layout renders while the page streams, so its Astro.cache.set() calls come too late for the Cache-Tag header and
 * chrome edits would not purge the cached pages (measured on staging, docs/spikes/performance-findings.md).
 */
import type { AstroGlobal } from "astro";
import { CACHE_TAG as ANALYTICS_TAG } from "@wp2emdash/seo/analytics/store";
import { getEmDashCollection, getEmDashEntry, getMenuWithCacheHint, getSiteSettingsWithCacheHint, getWidgetAreaWithCacheHint } from "emdash";
import site from "../site.config.json";

/** Where the old theme showed widget areas (site.config.json `widgetAreas`, from the migration) and whether a classic footer menu is shown. */
const areasConfig = (site as { widgetAreas?: { footer?: string[]; sidebar?: string[] } }).widgetAreas;
const footerMenuOn = (site as { footerMenu?: boolean }).footerMenu === true;

type Areas = Awaited<ReturnType<typeof getWidgetAreaWithCacheHint>>["data"][];

/** The widget areas a site part shows, in order, with one cache hint for all of them. */
async function loadAreas(names: string[]): Promise<{ data: Areas; cacheHint: { tags?: string[] } }> {
	const all = await Promise.all(names.map((n) => getWidgetAreaWithCacheHint(n)));
	return { data: all.map((a) => a.data), cacheHint: { tags: all.flatMap((a) => a.cacheHint.tags ?? []) } };
}

export async function loadChrome() {
	const [settings, primary, secondary, footer, popups, announcementPart, footerWidgets, sidebar, footerMenu] = await Promise.all([
		getSiteSettingsWithCacheHint(),
		getMenuWithCacheHint("primary"),
		getMenuWithCacheHint("secondary"),
		getEmDashEntry("site_parts", "footer"),
		getEmDashCollection("popups", { status: "published" }),
		getEmDashEntry("site_parts", "announcement"),
		areasConfig?.footer?.length ? loadAreas(areasConfig.footer) : undefined,
		areasConfig?.sidebar?.length ? loadAreas(areasConfig.sidebar) : undefined,
		footerMenuOn ? getMenuWithCacheHint("footer") : undefined,
	]);
	// Optional parts only when the site has them: a brochure site's chrome (and its cache tags) is unchanged.
	return { settings, primary, secondary, footer, popups, announcementPart, ...(footerWidgets ? { footerWidgets } : {}), ...(sidebar ? { sidebar } : {}), ...(footerMenu ? { footerMenu } : {}) };
}
export type Chrome = Awaited<ReturnType<typeof loadChrome>>;

const at = (v?: string) => (v && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : undefined);

/**
 * The announcement bar to render: the first enabled bar block of the "announcement" site part whose schedule has not
 * ended. `later`: it starts after now (rendered hidden; the browser shows it on time). `nextChange`: the next start or
 * end, after which this render is out of date.
 */
export function announcementState(chrome: Chrome, now = Date.now()) {
	const blocks = ((chrome.announcementPart.entry?.data as { content?: any[] } | undefined)?.content ?? []) as any[];
	const block = blocks.find((b) => b?._type === "section_announcement" && b.enabled !== false && Array.isArray(b.message) && b.message.length && !((at(b.ends_at) ?? Infinity) < now));
	const later = !!block && (at(block.starts_at) ?? 0) > now;
	const nextChange = block ? [at(block.starts_at), at(block.ends_at)].filter((t): t is number => t !== undefined && t > now).sort((a, b) => a - b)[0] : undefined;
	return { block, later, nextChange };
}

/**
 * Route cache: the chrome's tags (emdash:settings, emdash:menu:<name>, site_parts, popups) on this page, so EmDash's
 * purge on save reaches it; the analytics tag, purged when the Analytics admin page saves (SEO & Analytics, @wp2emdash/seo); and a lifetime no longer than the announcement's next start or end, so visitors without
 * JavaScript see a scheduled bar change too (the browser check covers everyone else).
 */
export function cacheChrome(cache: AstroGlobal["cache"] | undefined, chrome: Chrome, now = Date.now()): void {
	if (!cache?.enabled) return;
	for (const r of Object.values(chrome)) if (r?.cacheHint) cache.set(r.cacheHint);
	cache.set({ tags: [ANALYTICS_TAG] });
	const next = announcementState(chrome, now).nextChange;
	const maxAge = cache.options.maxAge;
	if (next !== undefined && maxAge !== undefined) {
		const seconds = Math.max(1, Math.ceil((next - now) / 1000));
		if (seconds < maxAge) cache.set({ maxAge: seconds, swr: 0 });
	}
}
