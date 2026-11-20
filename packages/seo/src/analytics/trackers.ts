/**
 * Trackers: the services the SEO & Analytics page can add, each identified by an ID that is checked against the
 * service's own format. There is no field for code: the site's loader (public/scripts/site-analytics.js) knows how to
 * start each service from its ID, and the security policy allows exactly that service's addresses (csp.ts).
 * Conversion events and consent mode are switches, not code either (events.ts, the loader).
 *
 * Pure module (no EmDash, no Workers APIs): used by the plugin, the starter (Analytics component, middleware), the
 * kit's scaffold (prefill) and tests.
 */

export const TRACKER_TYPES = ["ga4", "google-tag", "google-ads", "gtm", "cloudflare", "meta", "clarity", "hotjar", "ua"] as const;
export type TrackerType = (typeof TRACKER_TYPES)[number];
/** Types an admin can add (Universal Analytics is retired: listed when the old site had it, never loaded). */
export const ADDABLE_TYPES = TRACKER_TYPES.filter((t) => t !== "ua");

export interface Tracker {
	/** Stable row id, used by the admin page's buttons. */
	id: string;
	type: TrackerType;
	/** The service's ID, normalised (e.g. "G-ABC123DEF4"). */
	value: string;
	enabled: boolean;
	/** ISO time it was added (rows found on the old site: the first admin load). */
	addedAt: string;
	/** "wordpress": found on the old site at migration; "admin": added in the admin page. */
	origin?: "wordpress" | "admin";
}

export interface TrackerSpec {
	type: TrackerType;
	name: string;
	idName: string;
	example: string;
	where: string;
	pattern: RegExp;
	normalize: (raw: string) => string;
	/** Only one can be on at a time (one beacon / one project per page). */
	single?: boolean;
	/** Shut down by the provider: shown, never loaded, cannot be switched on. */
	retired?: string;
	/** Uses cookies / device storage (held back while consent mode waits for consent). */
	storage: boolean;
}

const upper = (s: string) => s.trim().toUpperCase();
const lower = (s: string) => s.trim().toLowerCase();
const digits = (s: string) => s.trim().replace(/\s+/g, "");

export const SPECS: Record<TrackerType, TrackerSpec> = {
	ga4: { type: "ga4", name: "Google Analytics 4", idName: "Measurement ID", example: "G-ABC123DEF4", where: "Google Analytics → Admin → Data streams → your web stream → Measurement ID.", pattern: /^G-[A-Z0-9]{6,12}$/, normalize: upper, storage: true },
	"google-tag": { type: "google-tag", name: "Google tag", idName: "Tag ID", example: "GT-ABCD1234", where: "Google tag settings (tagmanager.google.com → Google tags) → Tag ID starting with GT-.", pattern: /^GT-[A-Z0-9]{6,12}$/, normalize: upper, storage: true },
	"google-ads": { type: "google-ads", name: "Google Ads", idName: "Conversion ID", example: "AW-123456789", where: "Google Ads → Goals → Conversions → Google tag → Tag ID starting with AW-.", pattern: /^AW-\d{6,12}$/, normalize: upper, storage: true },
	gtm: { type: "gtm", name: "Google Tag Manager", idName: "Container ID", example: "GTM-ABC1234", where: "Tag Manager → the container's ID at the top (GTM-…).", pattern: /^GTM-[A-Z0-9]{4,10}$/, normalize: upper, storage: true },
	cloudflare: { type: "cloudflare", name: "Cloudflare Web Analytics", idName: "Beacon token", example: "0123456789abcdef0123456789abcdef", where: "Cloudflare → Web Analytics → the site → Manage site → the token in the JS snippet (32 characters). Not needed when Cloudflare adds the beacon to the domain by itself.", pattern: /^[a-f0-9]{32}$/, normalize: lower, single: true, storage: false },
	meta: { type: "meta", name: "Meta Pixel", idName: "Pixel ID", example: "123456789012345", where: "Meta Events Manager → Data sources → the pixel → Dataset ID / Pixel ID (digits only).", pattern: /^\d{12,20}$/, normalize: digits, storage: true },
	clarity: { type: "clarity", name: "Microsoft Clarity", idName: "Project ID", example: "abcd1234ef", where: "clarity.microsoft.com → the project → Settings → Overview → Project ID.", pattern: /^[a-z0-9]{8,12}$/, normalize: lower, single: true, storage: true },
	hotjar: { type: "hotjar", name: "Hotjar", idName: "Site ID", example: "1234567", where: "Hotjar → Sites & Organizations → the site's ID (digits).", pattern: /^\d{5,10}$/, normalize: digits, single: true, storage: true },
	ua: { type: "ua", name: "Universal Analytics", idName: "Property ID", example: "UA-12345678-1", where: "Google switched Universal Analytics off in July 2023: it collects nothing. Use Google Analytics 4.", pattern: /^UA-\d{4,10}-\d{1,4}$/, normalize: upper, retired: "Google stopped Universal Analytics in 2023: nothing is collected. Use a Google Analytics 4 ID instead.", storage: true },
};

export const isTrackerType = (v: unknown): v is TrackerType => typeof v === "string" && (TRACKER_TYPES as readonly string[]).includes(v);

/** Checks and normalises an ID for a type. The error never echoes the input. */
export function normalizeId(type: TrackerType, raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
	const spec = SPECS[type];
	if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: `Enter the ${spec.idName} (for example ${spec.example}).` };
	if (raw.length > 200 || /[<>"'`;(){}]/.test(raw)) return { ok: false, error: `Enter only the ${spec.idName}, not a code snippet (for example ${spec.example}).` };
	const value = spec.normalize(raw);
	if (!spec.pattern.test(value)) return { ok: false, error: `That is not a ${spec.name} ${spec.idName}: it looks like ${spec.example}.` };
	return { ok: true, value };
}

/** Problems with a list as a whole: the same ID twice, two of a single-only service on, a retired one on. */
export function listProblems(trackers: Tracker[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const t of trackers) {
		const k = `${t.type}:${t.value}`;
		if (seen.has(k)) out.push(`${SPECS[t.type].name} ${t.value} is already in the list.`);
		seen.add(k);
		if (t.enabled && SPECS[t.type].retired) out.push(`${SPECS[t.type].name} cannot be switched on: ${SPECS[t.type].retired}`);
	}
	for (const type of TRACKER_TYPES) {
		if (SPECS[type].single && trackers.filter((t) => t.type === type && t.enabled).length > 1) out.push(`Only one ${SPECS[type].name} can be on at a time: turn the other one off first.`);
	}
	return out;
}

/**
 * What the site carried over from WordPress (site.config.json `analytics`, written by scaffold from the audit, or the
 * kit.config choice). `ua` lists retired Universal Analytics IDs (shown in the admin, never loaded).
 */
export interface LegacyAnalytics {
	google?: string[];
	gtm?: string;
	cloudflareToken?: string;
	meta?: string[];
	clarity?: string;
	hotjar?: string;
	ua?: string[];
}

const googleType = (id: string): TrackerType | undefined => (id.startsWith("GTM-") ? undefined : id.startsWith("GT-") ? "google-tag" : id.startsWith("G-") ? "ga4" : id.startsWith("AW-") ? "google-ads" : undefined);

/** The list the admin page starts from: everything carried over from WordPress, on (retired ones off). */
export function seedTrackers(legacy: LegacyAnalytics | undefined, at = "1970-01-01T00:00:00.000Z"): Tracker[] {
	const rows: Array<[TrackerType, string]> = [];
	for (const id of legacy?.google ?? []) {
		const t = googleType(id);
		if (t) rows.push([t, id]);
	}
	if (legacy?.gtm) rows.push(["gtm", legacy.gtm]);
	if (legacy?.cloudflareToken) rows.push(["cloudflare", legacy.cloudflareToken]);
	for (const id of legacy?.meta ?? []) rows.push(["meta", id]);
	if (legacy?.clarity) rows.push(["clarity", legacy.clarity]);
	if (legacy?.hotjar) rows.push(["hotjar", legacy.hotjar]);
	for (const id of legacy?.ua ?? []) rows.push(["ua", id]);
	const out: Tracker[] = [];
	for (const [type, raw] of rows) {
		const n = normalizeId(type, raw);
		if (n.ok && !out.some((t) => t.type === type && t.value === n.value)) out.push({ id: `wp-${type}-${n.value.toLowerCase()}`, type, value: n.value, enabled: !SPECS[type].retired, addedAt: at, origin: "wordpress" });
	}
	return out;
}

/** A stored list read back: only well-formed rows with valid IDs survive (a damaged row can never inject anything). */
export function parseTrackers(value: unknown): Tracker[] | undefined {
	const list = Array.isArray(value) ? value : value && typeof value === "object" && Array.isArray((value as { trackers?: unknown }).trackers) ? (value as { trackers: unknown[] }).trackers : undefined;
	if (!list) return undefined;
	const out: Tracker[] = [];
	for (const r of list.slice(0, 100)) {
		if (!r || typeof r !== "object") continue;
		const o = r as Record<string, unknown>;
		if (!isTrackerType(o.type) || typeof o.id !== "string" || !/^[\w-]{1,80}$/.test(o.id)) continue;
		const n = normalizeId(o.type, o.value);
		if (!n.ok) continue;
		out.push({ id: o.id, type: o.type, value: n.value, enabled: o.enabled !== false && !SPECS[o.type].retired, addedAt: typeof o.addedAt === "string" ? o.addedAt.slice(0, 40) : "", ...(o.origin === "wordpress" || o.origin === "admin" ? { origin: o.origin } : {}) });
	}
	return out;
}

// ── Conversion events and consent ─────────────────────────────────────────────────────────────────────────────

export const EVENT_KINDS = ["lead", "contact", "booking", "outbound"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export type EventSettings = Record<EventKind, boolean>;
export const DEFAULT_EVENTS: EventSettings = { lead: true, contact: true, booking: true, outbound: false };

/** What each switch sends (shown in the admin; the loader implements it). No form contents, names, emails or numbers. */
export const EVENT_INFO: Record<EventKind, { label: string; sends: string }> = {
	lead: { label: "Form sent", sends: "GA4/Google tag: generate_lead (form name) · Tag Manager: generate_lead · Meta: Lead · Clarity/Hotjar: generate_lead tag" },
	contact: { label: "Phone and email links", sends: "GA4: contact (method phone/email) · Meta: Contact · Clarity/Hotjar: contact tag" },
	booking: { label: "Booking links", sends: "GA4: schedule (booking service) · Meta: Schedule · Clarity/Hotjar: schedule tag — links to Calendly, Acuity, Mindbody, Mariana Tek, Jane, Vagaro and other booking services" },
	outbound: { label: "Other outbound links", sends: "GA4: click (outbound, link domain) · Clarity/Hotjar: outbound tag. Off by default: GA4's enhanced measurement already counts outbound clicks." },
};

export function parseEvents(v: unknown): EventSettings {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	return Object.fromEntries(EVENT_KINDS.map((k) => [k, typeof o[k] === "boolean" ? (o[k] as boolean) : DEFAULT_EVENTS[k]])) as EventSettings;
}

/** What the page hands the loader (JSON in <meta name="site-analytics">): switched-on trackers by service, events, consent. */
export interface RuntimeConfig {
	/** Google tag IDs (G-, GT-, AW-): one gtag.js, one `config` per ID. */
	google: string[];
	gtm: string[];
	cloudflare?: string;
	meta: string[];
	clarity?: string;
	hotjar?: string;
	/** Conversion events switched on. */
	events?: EventKind[];
	/** Consent mode: Google starts with consent denied; Meta, Clarity and Hotjar wait for siteAnalytics.grantConsent(). */
	consent?: true;
}

export function runtimeConfig(trackers: Tracker[], o: { events?: EventSettings; consent?: boolean } = {}): RuntimeConfig {
	const on = trackers.filter((t) => t.enabled && !SPECS[t.type].retired && normalizeId(t.type, t.value).ok);
	const of = (...types: TrackerType[]) => [...new Set(on.filter((t) => types.includes(t.type)).map((t) => t.value))];
	const cloudflare = of("cloudflare")[0];
	const clarity = of("clarity")[0];
	const hotjar = of("hotjar")[0];
	const events = EVENT_KINDS.filter((k) => (o.events ?? DEFAULT_EVENTS)[k]);
	return { google: of("ga4", "google-tag", "google-ads"), gtm: of("gtm"), ...(cloudflare ? { cloudflare } : {}), meta: of("meta"), ...(clarity ? { clarity } : {}), ...(hotjar ? { hotjar } : {}), ...(events.length ? { events } : {}), ...(o.consent ? { consent: true as const } : {}) };
}

export const hasTrackers = (rc: RuntimeConfig): boolean => rc.google.length > 0 || rc.gtm.length > 0 || !!rc.cloudflare || rc.meta.length > 0 || !!rc.clarity || !!rc.hotjar;

/** The tracker types a runtime config uses (for the CSP). */
export function typesOf(rc: RuntimeConfig): TrackerType[] {
	const out = new Set<TrackerType>();
	for (const id of rc.google) {
		const t = googleType(id);
		if (t) out.add(t);
	}
	if (rc.gtm.length) out.add("gtm");
	if (rc.cloudflare) out.add("cloudflare");
	if (rc.meta.length) out.add("meta");
	if (rc.clarity) out.add("clarity");
	if (rc.hotjar) out.add("hotjar");
	return [...out];
}
