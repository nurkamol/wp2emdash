/**
 * Coming-soon / maintenance mode. An admin switches it on in Site health → Settings (@wp2emdash/health, stored in the
 * plugin's KV: EmDash `options` row `plugin:site-health:maintenance`); the migration never does. While it is on, visitors
 * get a branded holding page with 503 + Retry-After and noindex (search engines keep the old index and come back), and
 * signed-in people (an admin session cookie) see the site as usual, and so does anyone who opened the preview link
 * (`?preview=<key>`, Site health → Settings: a cookie for 7 days; "New link" changes the key and ends every old one). The middleware reads the row on every request it
 * renders (cached pages never reach it; saving the switch purges them): an isolate that trusted an older read could
 * re-cache the public page for the whole page lifetime right after the purge.
 *
 * Optional schedule (`startAt` / `endAt`, UTC): the holding page shows while now is inside [startAt, endAt), even with
 * the switch off; the switch still forces it on. `maintenanceActive` decides, everywhere the switch used to. Pages a
 * visitor gets from the cache never reach this code, so Site health's 5-minute cron purges the cache once when a start
 * or end passes (packages/health/src/maintenance.ts, which keeps a copy of `maintenanceActive`, as does
 * utils/rewarm.ts; test/coming-soon-schedule.test.ts keeps them in step): switching takes up to 5 minutes.
 *
 * No imports here: this file must load in Node (kit tests) and in the Worker (starter).
 */
export const MAINTENANCE_OPTION = "plugin:site-health:maintenance";
/** How long an isolate trusts the last read of the switch: 0 = read it on every rendered request (one D1 row). */
export const MAINTENANCE_TTL_MS = 0;

export interface MaintenanceState {
	on: boolean;
	heading?: string;
	message?: string;
	/** When the site is expected back (ISO): sets Retry-After. */
	until?: string;
	/** Scheduled start (ISO). Empty with an end time: from now. */
	startAt?: string;
	/** Scheduled end (ISO): the holding page stops; also Retry-After and "Back at" on the holding page. */
	endAt?: string;
	at?: string;
	/** The preview link's key (Site health → Settings); absent: no link. */
	previewKey?: string;
}

/** `?preview=<key>` opens the site for a person without an admin account; the cookie keeps it open for 7 days. */
export const PREVIEW_PARAM = "preview";
export const PREVIEW_COOKIE = "site-preview";
export const PREVIEW_DAYS = 7;
const KEY = /^[A-Za-z0-9_-]{20,64}$/;

/** Same length and characters, without stopping at the first difference. */
function sameKey(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

/**
 * While the mode is on: "link" when the address carries the current key (set the cookie, drop the parameter),
 * "cookie" when the browser already holds it, else null (the holding page).
 */
export function previewAccess(s: MaintenanceState, param: string | null | undefined, cookie: string | undefined, now = Date.now()): "link" | "cookie" | null {
	if (!maintenanceActive(s, now) || !s.previewKey) return null;
	if (param && sameKey(param, s.previewKey)) return "link";
	if (cookie && sameKey(cookie, s.previewKey)) return "cookie";
	return null;
}

const isTime = (v: unknown): v is string => typeof v === "string" && v !== "" && !Number.isNaN(Date.parse(v));

/** The holding page shows: the switch is on, or `now` is inside [startAt, endAt) (either end may be open). */
export function maintenanceActive(s: Pick<MaintenanceState, "on" | "startAt" | "endAt"> | null | undefined, now = Date.now()): boolean {
	if (!s || typeof s !== "object") return false;
	if (s.on === true) return true;
	const start = isTime(s.startAt) ? Date.parse(s.startAt) : Number.NaN;
	const end = isTime(s.endAt) ? Date.parse(s.endAt) : Number.NaN;
	if (Number.isNaN(start) && Number.isNaN(end)) return false;
	return (Number.isNaN(start) || now >= start) && (Number.isNaN(end) || now < end);
}

/** The stored row's value (JSON) → the state; anything unreadable is "off". */
export function parseMaintenance(value: unknown): MaintenanceState {
	try {
		const v = (typeof value === "string" ? JSON.parse(value) : value) as Partial<MaintenanceState> | null;
		if (!v || typeof v !== "object") return { on: false };
		const s: MaintenanceState = { on: v.on === true, ...(isTime(v.startAt) ? { startAt: v.startAt } : {}), ...(isTime(v.endAt) ? { endAt: v.endAt } : {}) };
		// Switched off and nothing scheduled: nothing else matters.
		if (!s.on && !s.startAt && !s.endAt) return { on: false };
		return { ...s, ...(typeof v.heading === "string" && v.heading.trim() ? { heading: v.heading.trim().slice(0, 120) } : {}), ...(typeof v.message === "string" && v.message.trim() ? { message: v.message.trim().slice(0, 1000) } : {}), ...(isTime(v.until) ? { until: v.until } : {}), ...(typeof v.at === "string" ? { at: v.at } : {}), ...(typeof v.previewKey === "string" && KEY.test(v.previewKey) ? { previewKey: v.previewKey } : {}) };
	} catch {
		return { on: false };
	}
}

/** Requests the holding page never answers: EmDash (admin, API, sign-in), images, the consent region check, form posts, files. */
export function maintenanceBypass(path: string): boolean {
	return path.startsWith("/_emdash") || path === "/_image" || path.startsWith("/_consent/") || path.startsWith("/api/") || path.startsWith("/_astro/") || /\.[a-z0-9]{2,5}$/i.test(path);
}

/** When the site is expected back: the scheduled end, else "Expected back" — the first one still ahead of `now`. */
export function backAt(s: MaintenanceState, now = Date.now()): string | undefined {
	return [s.endAt, s.until].find((t): t is string => isTime(t) && Date.parse(t) > now);
}

/** Retry-After in seconds: until the scheduled end or the announced time (at least 5 minutes, at most a day), else an hour. */
export function retryAfter(s: MaintenanceState, now = Date.now()): number {
	const at = backAt(s, now);
	if (!at) return 3600;
	return Math.min(86_400, Math.max(300, Math.round((Date.parse(at) - now) / 1000)));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The holding page: logo (or the site name), heading, message. Self-contained (inline styles only; the CSP allows inline styles, no scripts). */
export function comingSoonHtml(s: MaintenanceState, brand: { siteName: string; logo?: string; lang?: string; accent?: string; background?: string; text?: string }, now = Date.now()): string {
	// Plain text, no countdown: the CSP allows no inline script.
	const at = backAt(s, now);
	const back = at ? new Date(Date.parse(at)).toISOString() : undefined;
	const heading = s.heading || "We'll be back soon";
	const message = s.message || `${brand.siteName} is getting ready. Please check back shortly.`;
	const color = (c: string | undefined, d: string) => (c && /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(c) ? c : d);
	const logo = brand.logo && /^\/[\w./-]+$/.test(brand.logo) ? `<img src="${esc(brand.logo)}" alt="${esc(brand.siteName)}" class="logo">` : `<p class="name">${esc(brand.siteName)}</p>`;
	return `<!doctype html>
<html lang="${esc(brand.lang ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(heading)} – ${esc(brand.siteName)}</title>
<style>
html,body{margin:0;height:100%}
body{display:grid;place-items:center;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:${color(brand.background, "#ffffff")};color:${color(brand.text, "#1d2327")};text-align:center;padding:24px;box-sizing:border-box}
main{max-width:34rem}
.logo{max-width:220px;max-height:96px;height:auto;margin-bottom:28px}
.name{font-weight:700;font-size:1.4rem;margin:0 0 28px}
h1{font-size:clamp(1.6rem,4vw,2.4rem);line-height:1.2;margin:0 0 16px}
p.msg{font-size:1.1rem;line-height:1.6;margin:0;white-space:pre-line}
p.back{font-size:1rem;margin:20px 0 0;opacity:.8}
.bar{width:56px;height:4px;border-radius:2px;background:${color(brand.accent, "#2271b1")};margin:28px auto 0}
</style>
</head>
<body>
<main>
${logo}
<h1>${esc(heading)}</h1>
<p class="msg">${esc(message)}</p>
${back ? `<p class="back">Back at ${esc(`${back.slice(0, 10)} ${back.slice(11, 16)}`)} UTC</p>\n` : ""}<div class="bar" aria-hidden="true"></div>
</main>
</body>
</html>
`;
}
