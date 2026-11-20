/**
 * Privacy & Consent settings: the banner's mode, its text, the privacy policy link, the category descriptions and the
 * consent log switch — validated plain data, never markup or code. The banner (starter public/scripts/site-consent.js)
 * receives them as JSON in <meta name="site-consent"> and writes every string with textContent.
 *
 * Pure module (no EmDash, no Workers APIs): used by the plugin, the starter (Consent component), the kit's scaffold
 * (prefill from the old site) and tests.
 */
import type { RuntimeConfig, TrackerType } from "@wp2emdash/seo/analytics/trackers";

/**
 * - off: no banner (trackers load as before, or a third-party consent tool from the old site handles consent).
 * - notice: US-style information banner: everything on by default, an opt-out (Global Privacy Control turns marketing off).
 * - opt-in: EU/UK-style: nothing that stores data on the device until the visitor agrees.
 * - auto: opt-in for visitors in the EU/EEA, UK, Switzerland and Québec (Cloudflare's request.cf, asked by the banner
 *   from an uncached endpoint); notice for everyone else.
 */
export const MODES = ["off", "notice", "opt-in", "auto"] as const;
export type Mode = (typeof MODES)[number];
export const MODE_INFO: Record<Mode, { label: string; description: string }> = {
	off: { label: "Off", description: "No banner. Tracking codes load as before (or the old site's consent tool handles consent)." },
	notice: { label: "Notice (US style)", description: "An information banner; analytics and marketing are on until the visitor opts out. Browsers sending Global Privacy Control get marketing off." },
	"opt-in": { label: "Opt-in (EU / UK style)", description: "Nothing that stores data on visitors' devices loads until they agree. Rejecting is as easy as accepting." },
	auto: { label: "By visitor region (recommended)", description: "Opt-in for visitors from the EU/EEA, the UK, Switzerland and Québec; a notice for everyone else. Unknown regions get opt-in." },
};
export const isMode = (v: unknown): v is Mode => typeof v === "string" && (MODES as readonly string[]).includes(v);

export const POSITIONS = ["bar", "card"] as const;
export type Position = (typeof POSITIONS)[number];

/** Optional categories (necessary is always on and has no switch). */
export const CATEGORIES = ["analytics", "marketing", "preferences"] as const;
export type Category = (typeof CATEGORIES)[number];
export const CATEGORY_LABEL: Record<Category | "necessary", string> = { necessary: "Necessary", analytics: "Analytics", marketing: "Marketing", preferences: "Preferences" };
export const DEFAULT_DESCRIPTIONS: Record<Category | "necessary", string> = {
	necessary: "Needed for the site to work (security, remembering this choice). Always on. Cookieless visit counts are included.",
	analytics: "Help us understand how the site is used, so we can improve it.",
	marketing: "Measure our ads and show relevant ads on other sites.",
	preferences: "Remember choices and power extras such as chat and review widgets.",
};

export const TEXT_FIELDS = ["title", "body", "accept", "reject", "choose", "save", "settings"] as const;
export type TextField = (typeof TEXT_FIELDS)[number];
/** Length limits per text (characters). Plain text only. */
export const TEXT_MAX: Record<TextField, number> = { title: 80, body: 600, accept: 40, reject: 40, choose: 40, save: 40, settings: 40 };
export const TEXT_LABEL: Record<TextField, string> = { title: "Title", body: "Message", accept: "Accept button", reject: "Reject button", choose: "Choose button", save: "Save choices button", settings: "Footer link" };
export const DEFAULT_TEXT: Record<TextField, string> = {
	title: "Your privacy",
	body: "We use cookies and similar tools to run this site, measure visits and, with your permission, for marketing. You can accept all, reject what is not essential, or choose.",
	accept: "Accept all",
	reject: "Reject non-essential",
	choose: "Choose",
	save: "Save choices",
	settings: "Cookie settings",
};
export const DESCRIPTION_MAX = 300;

export interface ConsentSettings {
	version: 1;
	mode: Mode;
	position: Position;
	text: Record<TextField, string>;
	/** Site path of the privacy policy page ("" = none). */
	policy: string;
	descriptions: Record<Category | "necessary", string>;
	/** Consent log: counts per day (accepted / rejected / custom), no personal data. Off by default. */
	stats: boolean;
	/** Add the "Cookie settings" link to the footer automatically. */
	footerLink: boolean;
	/** Bumped by "Ask everyone again": stored choices from an older revision are asked again. */
	revision: number;
	updatedAt: string;
	updatedBy?: string;
}

/** What the site carried over (scaffold → plugin options and site.config.json `consent.defaults`). */
export interface ConsentDefaults {
	mode?: Mode;
	position?: Position;
	text?: Partial<Record<TextField, string>>;
	policy?: string;
	descriptions?: Partial<Record<Category | "necessary", string>>;
}

const CONTROL = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f\\u2028\\u2029]", "g");
/** Plain text: no control characters, whitespace collapsed. Markup is not interpreted anywhere (textContent). */
export const plain = (v: unknown): string => (typeof v === "string" ? v.replace(CONTROL, " ").replace(/\s+/g, " ").trim() : "");
const capped = (v: unknown, max: number, fallback: string) => {
	const t = plain(v);
	return t ? t.slice(0, max) : fallback;
};

/** A site path for the privacy policy: "/privacy-policy", "/legal/privacy/"; never another site or a script URL. */
export function policyPath(v: unknown): string | undefined {
	const t = plain(v);
	if (!t) return "";
	return /^\/(?!\/)[\w\-./~%]{0,200}$/.test(t) && !t.includes("..") ? t : undefined;
}

export function defaultSettings(d: ConsentDefaults = {}, at = "1970-01-01T00:00:00.000Z"): ConsentSettings {
	return {
		version: 1,
		mode: isMode(d.mode) ? d.mode : "auto",
		position: d.position === "card" ? "card" : "bar",
		text: Object.fromEntries(TEXT_FIELDS.map((k) => [k, capped(d.text?.[k], TEXT_MAX[k], DEFAULT_TEXT[k])])) as Record<TextField, string>,
		policy: policyPath(d.policy) ?? "",
		descriptions: Object.fromEntries((["necessary", ...CATEGORIES] as const).map((k) => [k, capped(d.descriptions?.[k], DESCRIPTION_MAX, DEFAULT_DESCRIPTIONS[k])])) as ConsentSettings["descriptions"],
		stats: false,
		footerLink: true,
		revision: 1,
		updatedAt: at,
	};
}

/** A stored value read back: every field checked, anything damaged falls back to the default (never trusted as is). */
export function parseSettings(v: unknown, d: ConsentDefaults = {}): ConsentSettings | undefined {
	if (!v || typeof v !== "object") return undefined;
	const o = v as Record<string, unknown>;
	if (o.version !== 1 || !isMode(o.mode)) return undefined;
	const base = defaultSettings(d);
	const text = (o.text && typeof o.text === "object" ? o.text : {}) as Record<string, unknown>;
	const desc = (o.descriptions && typeof o.descriptions === "object" ? o.descriptions : {}) as Record<string, unknown>;
	return {
		version: 1,
		mode: o.mode,
		position: o.position === "card" ? "card" : "bar",
		text: Object.fromEntries(TEXT_FIELDS.map((k) => [k, capped(text[k], TEXT_MAX[k], base.text[k])])) as Record<TextField, string>,
		policy: policyPath(o.policy) ?? "",
		descriptions: Object.fromEntries((["necessary", ...CATEGORIES] as const).map((k) => [k, capped(desc[k], DESCRIPTION_MAX, base.descriptions[k])])) as ConsentSettings["descriptions"],
		stats: o.stats === true,
		footerLink: o.footerLink !== false,
		revision: Number.isInteger(o.revision) && (o.revision as number) > 0 && (o.revision as number) < 1e6 ? (o.revision as number) : 1,
		updatedAt: typeof o.updatedAt === "string" ? o.updatedAt.slice(0, 40) : "",
		...(typeof o.updatedBy === "string" ? { updatedBy: plain(o.updatedBy).slice(0, 80) } : {}),
	};
}

export type FormResult = { ok: true; settings: ConsentSettings } | { ok: false; errors: string[] };

/**
 * The admin form → new settings. Strict: a text over its limit or an unknown policy page is an error (nothing is cut
 * silently); an empty text falls back to the default wording. `pages` = the policy paths the picker offered.
 */
export function settingsFromForm(current: ConsentSettings, values: Record<string, unknown>, pages: string[]): FormResult {
	const errors: string[] = [];
	if (!isMode(values.mode)) errors.push("Choose a mode.");
	const position = values.position === "card" ? "card" : values.position === "bar" || values.position === undefined ? "bar" : undefined;
	if (!position) errors.push("Choose where the banner sits.");
	const text = {} as Record<TextField, string>;
	for (const k of TEXT_FIELDS) {
		const t = plain(values[`text:${k}`]);
		if (t.length > TEXT_MAX[k]) errors.push(`${TEXT_LABEL[k]}: at most ${TEXT_MAX[k]} characters (now ${t.length}).`);
		text[k] = t || DEFAULT_TEXT[k];
	}
	const descriptions = {} as ConsentSettings["descriptions"];
	for (const k of ["necessary", ...CATEGORIES] as const) {
		const t = plain(values[`desc:${k}`]);
		if (t.length > DESCRIPTION_MAX) errors.push(`${CATEGORY_LABEL[k]} description: at most ${DESCRIPTION_MAX} characters (now ${t.length}).`);
		descriptions[k] = t || DEFAULT_DESCRIPTIONS[k];
	}
	const rawPolicy = values.policy === "none" || values.policy === undefined ? "" : values.policy;
	const policy = policyPath(rawPolicy);
	if (policy === undefined || (policy && !pages.includes(policy) && policy !== current.policy)) errors.push("Choose the privacy policy from the list of pages.");
	if (errors.length) return { ok: false, errors };
	return { ok: true, settings: { ...current, mode: values.mode as Mode, position: position as Position, text, descriptions, policy: policy ?? "", stats: values.stats === true, footerLink: values.footerLink !== false } };
}

// ── Which services fall in which category ─────────────────────────────────────────────────────────────────────

/** "cookieless": stores nothing on the device, always allowed (shown under Necessary). */
export type ServiceCategory = Category | "cookieless";

/** Tracker types of the SEO & Analytics suite → category. Universal Analytics is retired (never loaded). */
export const TRACKER_CATEGORY: Record<TrackerType, ServiceCategory | undefined> = {
	ga4: "analytics",
	"google-tag": "analytics",
	gtm: "analytics",
	"google-ads": "marketing",
	meta: "marketing",
	clarity: "analytics",
	hotjar: "analytics",
	cloudflare: "cookieless",
	ua: undefined,
};
const TRACKER_NAME: Record<TrackerType, string> = { ga4: "Google Analytics", "google-tag": "Google tag", gtm: "Google Tag Manager", "google-ads": "Google Ads", meta: "Meta Pixel", clarity: "Microsoft Clarity", hotjar: "Hotjar", cloudflare: "Cloudflare Web Analytics", ua: "Universal Analytics" };

/** Site-widget provider categories (starter utils/providers.ts) → consent category; consent tools are not gated. */
export const WIDGET_CATEGORY: Record<string, Category | undefined> = { chat: "preferences", reviews: "preferences" };

export type Services = Record<ServiceCategory, string[]>;

const googleType = (id: string): TrackerType | undefined => (id.startsWith("GT-") ? "google-tag" : id.startsWith("G-") ? "ga4" : id.startsWith("AW-") ? "google-ads" : undefined);

/** The services a page loads, by category (names only), from the analytics runtime config and the site widgets. */
export function servicesOf(rc: Pick<RuntimeConfig, "google" | "gtm" | "meta" | "cloudflare" | "clarity" | "hotjar"> | undefined, widgets: { name: string; category: string }[] = [], zoneBeacon = false): Services {
	const out: Services = { analytics: [], marketing: [], preferences: [], cookieless: [] };
	const add = (c: ServiceCategory | undefined, name: string) => {
		if (c && !out[c].includes(name)) out[c].push(name);
	};
	for (const id of rc?.google ?? []) {
		const t = googleType(id);
		if (t) add(TRACKER_CATEGORY[t], TRACKER_NAME[t]);
	}
	if (rc?.gtm.length) add("analytics", TRACKER_NAME.gtm);
	if (rc?.meta.length) add("marketing", TRACKER_NAME.meta);
	if (rc?.clarity) add("analytics", TRACKER_NAME.clarity);
	if (rc?.hotjar) add("analytics", TRACKER_NAME.hotjar);
	if (rc?.cloudflare || zoneBeacon) add("cookieless", TRACKER_NAME.cloudflare);
	for (const w of widgets) add(WIDGET_CATEGORY[w.category], w.name);
	return out;
}

/** Something on the site needs consent (a banner with nothing to choose would only be noise). */
export const needsConsent = (s: Services): boolean => CATEGORIES.some((c) => s[c].length > 0);

// ── What the page hands the banner ───────────────────────────────────────────────────────────────────────────

/** JSON in <meta name="site-consent">: identical for every visitor (the page is cached for everyone). */
export interface RuntimeConsent {
	mode: Exclude<Mode, "off">;
	rev: number;
	position: Position;
	text: Record<TextField, string>;
	policy?: string;
	cats: Record<Category | "necessary", { d: string; s: string[] }>;
	/** Consent log endpoint (counts only) when the log is on. */
	log?: string;
	footer: boolean;
}

export const REGION_PATH = "/_consent/region";

export function runtimeConsent(s: ConsentSettings, services: Services, o: { logUrl?: string } = {}): RuntimeConsent | undefined {
	if (s.mode === "off") return undefined;
	return {
		mode: s.mode,
		rev: s.revision,
		position: s.position,
		text: s.text,
		...(s.policy ? { policy: s.policy } : {}),
		cats: {
			necessary: { d: s.descriptions.necessary, s: services.cookieless },
			analytics: { d: s.descriptions.analytics, s: services.analytics },
			marketing: { d: s.descriptions.marketing, s: services.marketing },
			preferences: { d: s.descriptions.preferences, s: services.preferences },
		},
		...(s.stats && o.logUrl ? { log: o.logUrl } : {}),
		footer: s.footerLink,
	};
}
