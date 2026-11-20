/**
 * Site chrome every page shows: site settings, the primary and secondary menus, the footer and announcement site
 * parts, and the popups. Loaded in the PAGE's frontmatter (pages/[...slug].astro, pages/404.astro) and handed to the
 * layout, because route-cache tags only reach the response when they are set before Astro starts streaming it: a
 * layout renders while the page streams, so its Astro.cache.set() calls come too late for the Cache-Tag header and
 * chrome edits would not purge the cached pages (measured on staging, docs/spikes/performance-findings.md).
 */
import type { AstroGlobal } from "astro";
import { CACHE_TAG as ANALYTICS_TAG } from "@wp2emdash/seo/analytics/store";
import { getEmDashCollection, getEmDashEntry, getMenuWithCacheHint, getSiteSettingsWithCacheHint } from "emdash";

export async function loadChrome() {
	const [settings, primary, secondary, footer, popups, announcementPart] = await Promise.all([
		getSiteSettingsWithCacheHint(),
		getMenuWithCacheHint("primary"),
		getMenuWithCacheHint("secondary"),
		getEmDashEntry("site_parts", "footer"),
		getEmDashCollection("popups", { status: "published" }),
		getEmDashEntry("site_parts", "announcement"),
	]);
	return { settings, primary, secondary, footer, popups, announcementPart };
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
	for (const r of Object.values(chrome)) cache.set(r.cacheHint);
	cache.set({ tags: [ANALYTICS_TAG] });
	const next = announcementState(chrome, now).nextChange;
	const maxAge = cache.options.maxAge;
	if (next !== undefined && maxAge !== undefined) {
		const seconds = Math.max(1, Math.ceil((next - now) / 1000));
		if (seconds < maxAge) cache.set({ maxAge: seconds, swr: 0 });
	}
}
