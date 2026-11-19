import type { FormSnapshot, PageSnapshot } from "./page.js";

export type IntegrationKind =
	| "form"
	| "booking"
	| "analytics"
	| "tag-manager"
	| "pixel"
	| "consent"
	| "chat"
	| "map"
	| "video"
	| "social-feed"
	| "reviews"
	| "newsletter"
	| "popup"
	| "contact-link"
	| "font"
	| "captcha"
	| "payment"
	| "other-script";

export type ProposedAction = "keep" | "rebuild" | "replace" | "drop" | "decide";

export interface Integration {
	id: string;
	kind: IntegrationKind;
	name: string;
	/** Where it appears (path keys), capped. */
	pages: string[];
	pageCount: number;
	evidence: string[];
	proposed: ProposedAction;
	note?: string;
	form?: FormSnapshot & { sensitiveFields: string[] };
}

interface Signature {
	id: string;
	kind: IntegrationKind;
	name: string;
	/** Matched against script src, iframe src, link href and inline script samples. */
	pattern: RegExp;
	proposed: ProposedAction;
	note?: string;
	/** Where to look: "embed" = scripts/iframes/stylesheets only; "link" = outbound links only; default both. */
	in?: "embed" | "link";
}

const SIGNATURES: Signature[] = [
	// Booking & scheduling (keep the provider: it owns the appointment data)
	{ id: "calendly", kind: "booking", name: "Calendly", pattern: /calendly\.com/i, proposed: "keep" },
	{ id: "acuity", kind: "booking", name: "Acuity Scheduling", pattern: /acuityscheduling\.com|as\.me\//i, proposed: "keep" },
	{ id: "janeapp", kind: "booking", name: "Jane App", pattern: /janeapp\.com/i, proposed: "keep" },
	{ id: "simplepractice", kind: "booking", name: "SimplePractice", pattern: /simplepractice\.com/i, proposed: "keep" },
	{ id: "mindbody", kind: "booking", name: "Mindbody", pattern: /mindbodyonline\.com|healcode/i, proposed: "keep" },
	{ id: "square-appointments", kind: "booking", name: "Square Appointments", pattern: /squareup\.com\/appointments|square\.site/i, proposed: "keep" },
	{ id: "setmore", kind: "booking", name: "Setmore", pattern: /setmore\.com/i, proposed: "keep" },
	{ id: "zocdoc", kind: "booking", name: "Zocdoc", pattern: /zocdoc\.com/i, proposed: "keep" },
	{ id: "vagaro", kind: "booking", name: "Vagaro", pattern: /vagaro\.com/i, proposed: "keep" },
	{ id: "fresha", kind: "booking", name: "Fresha", pattern: /fresha\.com/i, proposed: "keep" },
	{ id: "booksy", kind: "booking", name: "Booksy", pattern: /booksy\.com/i, proposed: "keep" },
	{ id: "glofox", kind: "booking", name: "Glofox", pattern: /glofox\.com/i, proposed: "keep" },
	{ id: "momence", kind: "booking", name: "Momence", pattern: /momence\.com/i, proposed: "keep" },
	{ id: "marianatek", kind: "booking", name: "Mariana Tek", pattern: /marianatek\.com|marianaiframes\.com|data-mariana-integrations/i, proposed: "keep", note: "Booking widget (web integrations): keep it as an embed section; the starter loads <tenant>.marianaiframes.com" },
	{ id: "cal-com", kind: "booking", name: "Cal.com", pattern: /cal\.com\//i, proposed: "keep" },
	{ id: "google-calendar-booking", kind: "booking", name: "Google Calendar booking", pattern: /calendar\.app\.google|calendar\.google\.com\/calendar\/appointments/i, proposed: "keep" },
	// Analytics / tags / pixels
	{ id: "ga4", kind: "analytics", name: "Google Analytics 4", pattern: /googletagmanager\.com\/gtag\/js\?id=G-|gtag\(\s*['"]config['"]\s*,\s*['"]G-/i, proposed: "keep" },
	{ id: "ua", kind: "analytics", name: "Universal Analytics (retired)", pattern: /google-analytics\.com\/analytics\.js|UA-\d{4,}-\d+/i, proposed: "drop", note: "UA stopped processing data in 2023/2024" },
	{ id: "gtm", kind: "tag-manager", name: "Google Tag Manager", pattern: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/i, proposed: "keep" },
	{ id: "google-ads", kind: "pixel", name: "Google Ads tag", pattern: /AW-\d{6,}/i, proposed: "keep" },
	{ id: "site-kit", kind: "analytics", name: "Google Site Kit (WP plugin)", pattern: /google-site-kit|googlesitekit/i, proposed: "replace", note: "Plugin goes away; carry its GA4/GTM/AdSense ids into the new site" },
	{ id: "meta-pixel", kind: "pixel", name: "Meta Pixel", pattern: /connect\.facebook\.net\/[^"']*fbevents|fbq\(/i, proposed: "keep" },
	{ id: "linkedin-insight", kind: "pixel", name: "LinkedIn Insight", pattern: /snap\.licdn\.com|_linkedin_partner_id/i, proposed: "keep" },
	{ id: "tiktok-pixel", kind: "pixel", name: "TikTok Pixel", pattern: /analytics\.tiktok\.com/i, proposed: "keep" },
	{ id: "hotjar", kind: "analytics", name: "Hotjar", pattern: /static\.hotjar\.com|hotjar/i, proposed: "keep" },
	{ id: "clarity", kind: "analytics", name: "Microsoft Clarity", pattern: /clarity\.ms/i, proposed: "keep" },
	{ id: "plausible", kind: "analytics", name: "Plausible", pattern: /plausible\.io/i, proposed: "keep" },
	{ id: "matomo", kind: "analytics", name: "Matomo", pattern: /matomo|piwik/i, proposed: "keep" },
	{ id: "cf-web-analytics", kind: "analytics", name: "Cloudflare Web Analytics", pattern: /static\.cloudflareinsights\.com/i, proposed: "keep" },
	// Consent
	{ id: "cookieyes", kind: "consent", name: "CookieYes", pattern: /cookieyes/i, proposed: "decide" },
	{ id: "complianz", kind: "consent", name: "Complianz", pattern: /complianz/i, proposed: "decide" },
	{ id: "cookiebot", kind: "consent", name: "Cookiebot", pattern: /cookiebot/i, proposed: "keep" },
	{ id: "onetrust", kind: "consent", name: "OneTrust", pattern: /onetrust|cookielaw\.org/i, proposed: "keep" },
	{ id: "termly", kind: "consent", name: "Termly", pattern: /termly\.io/i, proposed: "keep" },
	{ id: "cookie-notice", kind: "consent", name: "Cookie Notice (WP plugin)", pattern: /cookie-notice/i, proposed: "rebuild" },
	// Chat
	{ id: "tawk", kind: "chat", name: "Tawk.to", pattern: /tawk\.to/i, proposed: "keep" },
	{ id: "intercom", kind: "chat", name: "Intercom", pattern: /intercom/i, proposed: "keep" },
	{ id: "crisp", kind: "chat", name: "Crisp", pattern: /crisp\.chat/i, proposed: "keep" },
	{ id: "tidio", kind: "chat", name: "Tidio", pattern: /tidio/i, proposed: "keep" },
	{ id: "hubspot", kind: "chat", name: "HubSpot", pattern: /hs-scripts\.com|hsforms|hubspot/i, proposed: "keep" },
	{ id: "whatsapp-widget", kind: "chat", name: "WhatsApp chat widget", pattern: /wa\.me\/|api\.whatsapp\.com|whatsapp/i, proposed: "rebuild", note: "Usually a floating button; rebuild as a static link" },
	// Maps, video, social, reviews
	{ id: "google-maps", kind: "map", name: "Google Maps embed", pattern: /maps\.google\.|google\.com\/maps|maps\.googleapis\.com/i, proposed: "keep", in: "embed" },
	{ id: "google-maps-link", kind: "contact-link", name: "Google Maps directions link", pattern: /maps\.google\.|google\.com\/maps|goo\.gl\/maps|maps\.app\.goo\.gl/i, proposed: "keep", in: "link" },
	{ id: "youtube", kind: "video", name: "YouTube", pattern: /youtube\.com\/embed|youtube-nocookie/i, proposed: "keep", in: "embed" },
	{ id: "vimeo", kind: "video", name: "Vimeo", pattern: /player\.vimeo\.com/i, proposed: "keep", in: "embed" },
	{ id: "instagram-feed", kind: "social-feed", name: "Instagram feed", pattern: /sb_instagram|instagram-feed|elfsight.*instagram|lightwidget/i, proposed: "decide" },
	{ id: "elfsight", kind: "reviews", name: "Elfsight widget", pattern: /elfsight/i, proposed: "keep" },
	{ id: "trustindex", kind: "reviews", name: "Trustindex reviews", pattern: /trustindex/i, proposed: "keep" },
	{ id: "google-reviews-plugin", kind: "reviews", name: "Google reviews plugin", pattern: /grw|google-reviews|wp-google-places-review/i, proposed: "decide" },
	// Newsletter / popup / captcha / payment / fonts
	{ id: "mailchimp", kind: "newsletter", name: "Mailchimp", pattern: /list-manage\.com|mc4wp|chimpstatic/i, proposed: "keep" },
	{ id: "klaviyo", kind: "newsletter", name: "Klaviyo", pattern: /klaviyo/i, proposed: "keep" },
	{ id: "brevo-forms", kind: "newsletter", name: "Brevo / Sendinblue forms", pattern: /sibforms\.com|sendinblue|brevo/i, proposed: "keep" },
	{ id: "popup-maker", kind: "popup", name: "Popup Maker (WP plugin)", pattern: /popup-maker|pum-|popmake/i, proposed: "rebuild", note: "Rebuild needed popups as a dialog section; most can be dropped" },
	{ id: "recaptcha", kind: "captcha", name: "Google reCAPTCHA", pattern: /google\.com\/recaptcha|gstatic\.com\/recaptcha/i, proposed: "replace", note: "Replaced by Cloudflare Turnstile on rebuilt forms" },
	{ id: "hcaptcha", kind: "captcha", name: "hCaptcha", pattern: /hcaptcha\.com/i, proposed: "replace", note: "Replaced by Cloudflare Turnstile on rebuilt forms" },
	{ id: "stripe", kind: "payment", name: "Stripe", pattern: /js\.stripe\.com/i, proposed: "decide" },
	{ id: "paypal", kind: "payment", name: "PayPal", pattern: /paypal\.com\/sdk|paypalobjects/i, proposed: "decide" },
	{ id: "google-fonts", kind: "font", name: "Google Fonts", pattern: /fonts\.googleapis\.com|fonts\.gstatic\.com/i, proposed: "replace", note: "Self-hosted via Astro fonts (privacy + performance)" },
	{ id: "adobe-fonts", kind: "font", name: "Adobe Fonts", pattern: /use\.typekit\.net|p\.typekit\.net/i, proposed: "keep", note: "Licence tied to the kit; keep the embed" },
	{ id: "font-awesome", kind: "font", name: "Font Awesome", pattern: /font-?awesome/i, proposed: "replace", note: "Icons become inline SVG" },
];

/** Field names/labels that suggest sensitive personal data (health, identity, finance). */
const SENSITIVE = /\b(dob|date.?of.?birth|birth|diagnos|medical|medication|condition|symptom|injur|pain|health|insurance|policy.?number|member.?id|ssn|social.?security|passport|national.?id|emirates.?id|allerg|pregnan|surgery|treatment|therapy.?history|doctor|physician|referral|card.?number|cvv|iban)\b/i;

export function sensitiveFields(form: FormSnapshot): string[] {
	return form.fields.filter((f) => SENSITIVE.test(`${f.name} ${f.label ?? ""} ${f.placeholder ?? ""}`)).map((f) => f.label ?? f.name);
}

const pathOf = (url: string) => {
	const u = new URL(url);
	return `${u.pathname}${u.search}`;
};

/** Site-wide integrations inventory from all page snapshots. */
export function scanIntegrations(pages: PageSnapshot[]): Integration[] {
	const found = new Map<string, Integration>();
	const add = (id: string, base: Omit<Integration, "pages" | "pageCount" | "evidence">, page: string, evidence: string) => {
		const cur = found.get(id) ?? { ...base, pages: [], pageCount: 0, evidence: [] };
		if (!cur.pages.includes(page)) {
			cur.pageCount++;
			if (cur.pages.length < 25) cur.pages.push(page);
		}
		if (cur.evidence.length < 5 && !cur.evidence.includes(evidence)) cur.evidence.push(evidence);
		found.set(id, cur);
	};

	for (const p of pages) {
		if (p.status !== 200) continue;
		const page = pathOf(p.url);
		const embeds = [
			...p.scripts.map((s) => s.src ?? s.inlineSample ?? ""),
			...p.iframes,
			...p.stylesheets,
			...p.bodyClasses,
			...p.trackingIds.map((id) => (id.startsWith("GTM-") ? `googletagmanager.com/gtm.js?id=${id}` : id.startsWith("G-") ? `googletagmanager.com/gtag/js?id=${id}` : id)),
		];
		const outbound = p.links.filter((l) => !l.internal).map((l) => l.href);
		for (const sig of SIGNATURES) {
			const haystack = sig.in === "embed" ? embeds : sig.in === "link" ? outbound : [...embeds, ...outbound];
			const hit = haystack.find((h) => sig.pattern.test(h));
			if (hit) add(sig.id, { id: sig.id, kind: sig.kind, name: sig.name, proposed: sig.proposed, note: sig.note }, page, hit.slice(0, 160));
		}
		for (const l of p.links) {
			const scheme = l.href.match(/^(mailto|tel|sms|whatsapp):([^?]*)/i);
			if (scheme) {
				const kind = (scheme[1] as string).toLowerCase();
				const value = decodeURIComponent(scheme[2] as string).trim();
				add(`${kind}:${value}`, { id: `${kind}:${value}`, kind: "contact-link", name: `${kind}: ${value}`, proposed: "keep" }, page, l.text || value);
			}
		}
		for (const f of p.forms) {
			if (f.provider === "wp-search") continue;
			const sens = sensitiveFields(f);
			const id = `form:${f.id}`;
			const proposed: ProposedAction = f.provider === "mailchimp" || f.provider === "hubspot" ? "keep" : sens.length ? "decide" : "rebuild";
			const note = sens.length
				? `Possibly sensitive fields: ${sens.join(", ")} — keep with a compliant provider or remove those fields`
				: `${f.fields.length} field(s); rebuild as a form section → Worker → email provider`;
			add(id, { id, kind: "form", name: `${f.provider} form${f.providerFormId ? ` #${f.providerFormId}` : ""}${f.inPopup ? " (in popup)" : ""}`, proposed, note, form: { ...f, sensitiveFields: sens } }, page, f.fields.map((x) => x.label ?? x.name).join(", ").slice(0, 160));
		}
	}

	const order: IntegrationKind[] = ["form", "booking", "contact-link", "analytics", "tag-manager", "pixel", "consent", "popup", "chat", "map", "video", "reviews", "social-feed", "newsletter", "captcha", "payment", "font", "other-script"];
	const ids = [...new Set(pages.flatMap((p) => p.trackingIds))];
	for (const i of found.values()) {
		const own = ids.filter((id) => (i.id === "gtm" && id.startsWith("GTM-")) || (i.id === "ga4" && id.startsWith("G-")) || (i.id === "google-ads" && id.startsWith("AW-")) || (i.id === "ua" && id.startsWith("UA-")) || (i.id === "site-kit"));
		if (own.length) i.note = [i.note, `IDs: ${own.join(", ")}`].filter(Boolean).join(" — ");
	}
	return [...found.values()].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || b.pageCount - a.pageCount);
}
