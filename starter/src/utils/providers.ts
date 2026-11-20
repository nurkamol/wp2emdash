/**
 * Third-party provider registry — the ONE table for every widget a WordPress site may embed: how the kit recognises it
 * (content embeds in the adapters, site-wide snippets in transform), which hosts its scripts and iframes may load
 * from (the embed allowlist in utils/embed.ts and the Content-Security-Policy in middleware.ts), and — for site-wide
 * widgets (chat, reviews badge, consent banner) — how the starter loads it from an ID alone (no free-form code).
 *
 * Kit code imports it through src/providers/registry.ts; the starter is copied into every project, so the project
 * gets the same table. No imports here: this file must load in Node (kit, tests) and in the Worker (starter).
 *
 * Adding a provider: add an entry, add a sample to test/providers.test.ts (detection + CSP coverage), and record the
 * host sources in docs/spikes/providers-findings.md. Order matters for `embed` providers: the first match wins, and the
 * first eighteen entries keep the order the adapters used before the registry (goldens depend on it).
 */

export type ProviderCategory = "booking" | "video" | "map" | "reviews" | "forms" | "newsletter" | "audio" | "social" | "chat" | "consent" | "tracker";

/** Extra CSP sources beyond `hosts` (full sources: `https://x`, `wss://x`, wildcards allowed). */
export interface ProviderCsp {
	script?: string[];
	frame?: string[];
	connect?: string[];
	img?: string[];
	style?: string[];
	font?: string[];
	media?: string[];
}

export interface WidgetSpec {
	/** The ID's format, checked again by the starter's loader (public/scripts/site-widgets.js). */
	id: RegExp;
	/** Where the ID sits in the provider's official snippet (first capture group). */
	find: RegExp[];
}

export interface Provider {
	id: string;
	name: string;
	category: ProviderCategory;
	/** Markup or URL that identifies the provider (page content or a site-wide snippet). */
	detect: RegExp;
	/** Kept as an `embed` section (section_embed's provider list). */
	embed: boolean;
	/** Domains (subdomains included) its scripts and iframes load from: script-src, frame-src, connect-src, embed allowlist. */
	hosts: string[];
	csp?: ProviderCsp;
	/** Site-wide widget the starter can load from an ID (kit.config `siteWidgets`). */
	widget?: WidgetSpec;
	/** "verified": hosts from the provider's own CSP/allowlist page; "snippet": derived from its official snippet. */
	source: "verified" | "snippet";
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PROVIDERS: Provider[] = [
	// ── Content embeds kept since the first adapters (order and hosts unchanged) ──
	// Mariana Tek web integrations: `data-mariana-integrations="/path"` mount points, filled by <tenant>.marianaiframes.com scripts.
	{ id: "marianatek", name: "Mariana Tek", category: "booking", detect: /marianaiframes\.com|marianatek\.com|\sdata-mariana-[\w-]+/i, embed: true, hosts: ["marianaiframes.com"], source: "snippet" },
	{ id: "momence", name: "Momence", category: "booking", detect: /momence\.com/i, embed: true, hosts: ["momence.com"], source: "snippet" },
	{ id: "janeapp", name: "Jane", category: "booking", detect: /janeapp\.com/i, embed: true, hosts: ["janeapp.com"], source: "snippet" },
	{ id: "calendly", name: "Calendly", category: "booking", detect: /calendly\.com/i, embed: true, hosts: ["calendly.com"], source: "snippet" },
	{ id: "acuity", name: "Acuity Scheduling", category: "booking", detect: /acuityscheduling\.com|as\.me\//i, embed: true, hosts: ["acuityscheduling.com", "as.me"], source: "snippet" },
	{ id: "simplepractice", name: "SimplePractice", category: "booking", detect: /simplepractice\.com/i, embed: true, hosts: ["simplepractice.com"], source: "snippet" },
	{ id: "mindbody", name: "Mindbody", category: "booking", detect: /mindbodyonline\.com|healcode/i, embed: true, hosts: ["mindbodyonline.com", "healcode.com", "brandedweb.mindbodyonline.com"], source: "snippet" },
	{ id: "google-maps", name: "Google Maps", category: "map", detect: /google\.com\/maps|maps\.google\./i, embed: true, hosts: ["google.com", "maps.google.com"], source: "snippet" },
	{ id: "youtube", name: "YouTube", category: "video", detect: /youtube(-nocookie)?\.com|youtu\.be/i, embed: true, hosts: ["youtube.com", "youtube-nocookie.com"], source: "snippet" },
	{ id: "vimeo", name: "Vimeo", category: "video", detect: /player\.vimeo\.com|vimeo\.com/i, embed: true, hosts: ["player.vimeo.com"], source: "snippet" },
	{ id: "instagram", name: "Instagram", category: "social", detect: /instagram\.com/i, embed: true, hosts: ["instagram.com"], source: "snippet" },
	{ id: "reviews-widget", name: "Reviews widget (Elfsight, Trustindex, Trustpilot)", category: "reviews", detect: /elfsight|trustindex|widget\.trustpilot/i, embed: true, hosts: ["elfsight.com", "trustindex.io", "trustpilot.com"], source: "snippet" },
	{ id: "typeform", name: "Typeform", category: "forms", detect: /typeform\.com/i, embed: true, hosts: ["typeform.com"], source: "snippet" },
	{ id: "jotform", name: "Jotform", category: "forms", detect: /jotform\.com/i, embed: true, hosts: ["jotform.com"], source: "snippet" },
	{ id: "hubspot", name: "HubSpot forms", category: "forms", detect: /hubspot|hsforms/i, embed: true, hosts: ["hsforms.net", "hubspot.com", "hs-scripts.com"], source: "snippet" },
	{ id: "mailchimp", name: "Mailchimp", category: "newsletter", detect: /mailchimp|list-manage\.com/i, embed: true, hosts: ["list-manage.com", "mailchimp.com"], source: "snippet" },
	{ id: "spotify", name: "Spotify", category: "audio", detect: /spotify\.com/i, embed: true, hosts: ["open.spotify.com"], source: "snippet" },
	{ id: "soundcloud", name: "SoundCloud", category: "audio", detect: /soundcloud\.com/i, embed: true, hosts: ["w.soundcloud.com"], source: "snippet" },

	// ── Content embeds added with the registry (were legacy_html before) ──
	{ id: "google-calendar", name: "Google Calendar", category: "booking", detect: /calendar\.google\.com\/calendar\/(?:u\/\d+\/)?embed/i, embed: true, hosts: ["calendar.google.com"], source: "snippet" },
	{ id: "google-forms", name: "Google Forms", category: "forms", detect: /docs\.google\.com\/forms\//i, embed: true, hosts: ["docs.google.com"], source: "snippet" },
	{ id: "wistia", name: "Wistia", category: "video", detect: /fast\.wistia\.(?:com|net)|wistia_embed|<wistia-player\b/i, embed: true, hosts: ["wistia.com", "wistia.net"], csp: { media: ["https://*.wistia.com", "https://*.wistia.net"] }, source: "snippet" },
	{ id: "loom", name: "Loom", category: "video", detect: /loom\.com\/(?:embed|share)\//i, embed: true, hosts: ["loom.com"], source: "snippet" },
	{ id: "tiktok", name: "TikTok", category: "social", detect: /tiktok\.com\/(?:embed|@[\w.-]+\/video)|class=["'][^"']*\btiktok-embed\b/i, embed: true, hosts: ["tiktok.com"], csp: { img: ["https://*.tiktokcdn.com"] }, source: "snippet" },
	{ id: "facebook", name: "Facebook page / video", category: "social", detect: /facebook\.com\/plugins\/|connect\.facebook\.net\/[\w-]+\/sdk\.js|class=["'][^"']*\bfb-(?:page|video|post)\b/i, embed: true, hosts: ["facebook.com", "connect.facebook.net"], source: "snippet" },
	{ id: "x-twitter", name: "X (Twitter)", category: "social", detect: /platform\.twitter\.com|class=["'][^"']*\btwitter-(?:tweet|timeline)\b/i, embed: true, hosts: ["platform.twitter.com", "syndication.twitter.com"], source: "snippet" },
	{ id: "vagaro", name: "Vagaro", category: "booking", detect: /vagaro\.com/i, embed: true, hosts: ["vagaro.com"], source: "snippet" },
	{ id: "glofox", name: "Glofox", category: "booking", detect: /glofox\.com/i, embed: true, hosts: ["glofox.com"], source: "snippet" },
	{ id: "zenoti", name: "Zenoti", category: "booking", detect: /zenoti\.com/i, embed: true, hosts: ["zenoti.com"], source: "snippet" },
	{ id: "square-appointments", name: "Square Appointments", category: "booking", detect: /squareup\.com\/appointments|book\.squareup\.com|square\.site\/(?:appointments|book)/i, embed: true, hosts: ["squareup.com", "square.site"], source: "snippet" },
	{ id: "booksy", name: "Booksy", category: "booking", detect: /booksy\.com/i, embed: true, hosts: ["booksy.com"], source: "snippet" },
	{ id: "fresha", name: "Fresha", category: "booking", detect: /fresha\.com/i, embed: true, hosts: ["fresha.com"], source: "snippet" },
	{ id: "opentable", name: "OpenTable", category: "booking", detect: /opentable\.(?:com|co\.uk|ca|de|com\.au|jp|ie|com\.mx)|otstatic\.com/i, embed: true, hosts: ["opentable.com", "otstatic.com"], source: "snippet" },
	{ id: "resy", name: "Resy", category: "booking", detect: /resy\.com/i, embed: true, hosts: ["resy.com"], source: "snippet" },
	{ id: "tock", name: "Tock", category: "booking", detect: /exploretock\.com/i, embed: true, hosts: ["exploretock.com"], source: "snippet" },
	{ id: "arketa", name: "Arketa", category: "booking", detect: /arketa\.co\b/i, embed: true, hosts: ["arketa.co"], source: "snippet" },
	{ id: "classpass", name: "ClassPass", category: "booking", detect: /classpass\.com/i, embed: true, hosts: ["classpass.com"], source: "snippet" },

	// ── Site-wide widgets: loaded by the starter from an ID (components/SiteWidgets.astro) ──
	{
		id: "tawkto",
		name: "Tawk.to chat",
		category: "chat",
		detect: /embed\.tawk\.to/i,
		embed: false,
		hosts: ["tawk.to"],
		csp: { connect: ["wss://*.tawk.to"], style: ["https://*.tawk.to"], font: ["https://*.tawk.to"] },
		widget: { id: /^[0-9a-f]{24}\/[a-z0-9]{6,12}$/i, find: [/embed\.tawk\.to\/([0-9a-f]{24}\/[a-z0-9]{6,12})\b/i] },
		source: "verified",
	},
	{
		id: "crisp",
		name: "Crisp chat",
		category: "chat",
		detect: /client\.crisp\.chat|CRISP_WEBSITE_ID/,
		embed: false,
		hosts: ["crisp.chat"],
		csp: { connect: ["wss://client.relay.crisp.chat", "wss://stream.relay.crisp.chat"], style: ["https://client.crisp.chat"], font: ["https://client.crisp.chat"] },
		widget: { id: UUID, find: [/CRISP_WEBSITE_ID\s*=\s*["']([0-9a-f-]{36})["']/i] },
		source: "verified",
	},
	{
		id: "intercom",
		name: "Intercom Messenger",
		category: "chat",
		detect: /widget\.intercom\.io|intercomSettings|js\.intercomcdn\.com/,
		embed: false,
		hosts: ["intercom.io", "intercomcdn.com"],
		csp: {
			connect: ["https://*.intercom-messenger.com", "wss://*.intercom-messenger.com", "wss://nexus-websocket-a.intercom.io", "wss://nexus-websocket-b.intercom.io", "https://uploads.intercomusercontent.com"],
			frame: ["https://intercom-sheets.com", "https://www.intercom-reporting.com"],
			font: ["https://js.intercomcdn.com", "https://fonts.intercomcdn.com"],
			media: ["https://js.intercomcdn.com", "https://downloads.intercomcdn.com"],
		},
		widget: { id: /^[a-z0-9]{8}$/, find: [/widget\.intercom\.io\/widget\/([a-z0-9]{8})\b/, /app_id\s*:\s*["']([a-z0-9]{8})["']/] },
		source: "verified",
	},
	{
		id: "hubspot-chat",
		name: "HubSpot tracking code & chat",
		category: "chat",
		detect: /js(?:-[a-z0-9]+)?\.hs-scripts\.com\/\d+\.js|id=["']hs-script-loader/i,
		embed: false,
		hosts: ["hs-scripts.com", "hs-analytics.net", "usemessages.com", "hubspot.com", "hubapi.com", "hs-banner.com", "hscollectedforms.net"],
		widget: { id: /^\d{5,10}$/, find: [/hs-scripts\.com\/(\d{5,10})\.js/i] },
		source: "verified",
	},
	{
		id: "elfsight",
		name: "Elfsight widget",
		category: "reviews",
		detect: /elfsightcdn\.com\/platform|apps\.elfsight\.com\/p\/platform|static\.elfsight\.com\/platform|elfsight-app-[0-9a-f-]{36}/i,
		embed: false,
		hosts: ["elfsight.com", "elfsightcdn.com"],
		widget: { id: UUID, find: [/elfsight-app-([0-9a-f-]{36})/i] },
		source: "snippet",
	},
	{
		id: "trustindex",
		name: "Trustindex reviews",
		category: "reviews",
		detect: /cdn\.trustindex\.io\/loader(?:-cert|-feed)?\.js/i,
		embed: false,
		hosts: ["trustindex.io"],
		csp: { style: ["https://cdn.trustindex.io"] },
		widget: { id: /^[0-9a-f]{10,40}$/i, find: [/cdn\.trustindex\.io\/loader\.js\?([0-9a-f]{10,40})\b/i] },
		source: "snippet",
	},

	// ── Consent tools (category consent): carried as site widgets ──
	{
		id: "cookieyes",
		name: "CookieYes",
		category: "consent",
		detect: /cdn-cookieyes\.com/i,
		embed: false,
		hosts: ["cdn-cookieyes.com", "cookieyes.com"],
		widget: { id: /^[0-9a-f]{20,40}$/i, find: [/cdn-cookieyes\.com\/client_data\/([0-9a-f]{20,40})\/script\.js/i] },
		source: "verified",
	},
	{
		id: "cookiebot",
		name: "Cookiebot",
		category: "consent",
		detect: /consent\.cookiebot\.(?:com|eu)\/uc\.js/i,
		embed: false,
		hosts: ["cookiebot.com", "cookiebot.eu"],
		widget: { id: UUID, find: [/data-cbid=["']([0-9a-f-]{36})["']/i, /uc\.js\?cbid=([0-9a-f-]{36})/i] },
		source: "verified",
	},
	{
		id: "termly",
		name: "Termly",
		category: "consent",
		detect: /app\.termly\.io\/(?:resource-blocker|embed)/i,
		embed: false,
		hosts: ["termly.io"],
		widget: { id: UUID, find: [/app\.termly\.io\/resource-blocker\/([0-9a-f-]{36})/i, /data-website-uuid=["']([0-9a-f-]{36})["']/i] },
		source: "verified",
	},
	{
		id: "iubenda",
		name: "iubenda Cookie Solution",
		category: "consent",
		detect: /iubenda\.com|_iub\.csConfiguration/i,
		embed: false,
		hosts: ["iubenda.com"],
		// The newer one-line widget only; the legacy inline `_iub.csConfiguration` setup needs code → a decision.
		widget: { id: UUID, find: [/embeds\.iubenda\.com\/widgets\/([0-9a-f-]{36})\.js/i] },
		source: "verified",
	},
];

export const PROVIDER_BY_ID: Record<string, Provider> = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

/** Providers an `embed` section may select (section_embed), in detection order. */
export const EMBED_PROVIDER_IDS: string[] = PROVIDERS.filter((p) => p.embed).map((p) => p.id);

/** Embed allowlist per provider (utils/embed.ts): the domains its scripts/iframes may load from. */
export const PROVIDER_HOSTS: Record<string, string[]> = Object.fromEntries(PROVIDERS.filter((p) => p.embed).map((p) => [p.id, p.hosts]));

/** The known embed provider of a piece of page content (first match in registry order). */
export function embedProviderOf(html: string): string | undefined {
	return PROVIDERS.find((p) => p.embed && p.detect.test(html))?.id;
}

/** True when `host` is one of the provider's domains or a subdomain of one. */
export function hostAllowed(host: string, providerId: string): boolean {
	const h = host.toLowerCase();
	return (PROVIDER_BY_ID[providerId]?.hosts ?? []).some((d) => h === d || h.endsWith(`.${d}`));
}

export interface CspSources {
	script: string[];
	frame: string[];
	connect: string[];
	img: string[];
	style: string[];
	font: string[];
	media: string[];
}

/** CSP sources for the given providers: each domain as `https://d https://*.d` for script/frame/connect, plus extras. */
export function providerCsp(ids: Iterable<string>): CspSources {
	const out: CspSources = { script: [], frame: [], connect: [], img: [], style: [], font: [], media: [] };
	for (const id of ids) {
		const p = PROVIDER_BY_ID[id];
		if (!p) continue;
		const base = p.hosts.flatMap((h) => [`https://${h}`, `https://*.${h}`]);
		out.script.push(...base, ...(p.csp?.script ?? []));
		out.frame.push(...base, ...(p.csp?.frame ?? []));
		out.connect.push(...base, ...(p.csp?.connect ?? []));
		for (const k of ["img", "style", "font", "media"] as const) out[k].push(...(p.csp?.[k] ?? []));
	}
	for (const k of Object.keys(out) as (keyof CspSources)[]) out[k] = [...new Set(out[k])];
	return out;
}

/** Every embed provider: allowed on every page, so an embed an editor adds later is not blocked. */
export const embedCsp = (): CspSources => providerCsp(EMBED_PROVIDER_IDS);

export interface SiteWidget {
	provider: string;
	id: string;
}

/** A site widget with a known provider and a well-formed ID (anything else is ignored by the starter). */
export function validWidget(w: { provider?: unknown; id?: unknown }): w is SiteWidget {
	const spec = typeof w.provider === "string" ? PROVIDER_BY_ID[w.provider]?.widget : undefined;
	return !!spec && typeof w.id === "string" && spec.id.test(w.id);
}

/** The widget ID in a site-wide snippet of this provider, if its official form carries one. */
export function widgetIdIn(providerId: string, html: string): string | undefined {
	const spec = PROVIDER_BY_ID[providerId]?.widget;
	if (!spec) return undefined;
	for (const re of spec.find) {
		const id = re.exec(html)?.[1];
		if (id && spec.id.test(id)) return id;
	}
	return undefined;
}
