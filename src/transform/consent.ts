/**
 * Consent banner on the old site: which WordPress consent plugin or consent service it ran (from the audit's raw HTML
 * of the saved pages and the site widgets recognised in transform), and what the new site starts with:
 *
 * - a consent service carried as a site widget (CookieYes, Cookiebot, Termly, iubenda): keep it, built-in banner off
 *   (two banners would ask twice); the admin can switch to the built-in banner in Privacy & consent.
 * - a WordPress consent plugin (Complianz, CookieYes plugin, GDPR Cookie Consent, Cookie Notice, Borlabs, Real Cookie
 *   Banner, Moove GDPR…) or an uncarried service (OneTrust, Usercentrics): the plugin does not exist on EmDash → the
 *   built-in banner, with the old banner's wording when it is in the HTML and the mode the plugin evidently used.
 * - nothing: the built-in banner in "auto" (opt-in for EU/EEA/UK/CH/Québec visitors, a notice elsewhere).
 *
 * Pure function of the HTML: ir/consent.json is reproduced by a rerun. Reported in coverage.md (## Consent banner).
 */
import * as cheerio from "cheerio";
import { DEFAULT_TEXT, type Mode, plain, TEXT_MAX, type TextField } from "../../packages/consent/src/settings.js";
import type { SiteWidget } from "../providers/registry.js";

export interface ConsentTool {
	id: string;
	name: string;
	kind: "wp-plugin" | "service";
	/** A built-in-banner mode this tool's own configuration shows (Complianz opt-in / opt-out; EU-only plugins). */
	mode?: Mode;
}

export interface ConsentPlan {
	found: ConsentTool[];
	/** Consent services carried as site widgets (kept; the built-in banner starts off). */
	keptWidgets: string[];
	/** What the built-in banner starts with. */
	mode: Mode;
	text: Partial<Record<TextField, string>>;
	/** Why, for the coverage report. */
	reason: string;
}

interface Signature {
	id: string;
	name: string;
	kind: ConsentTool["kind"];
	detect: RegExp;
	/** Selectors of the banner's own text in server-rendered HTML (plugins that render the banner in PHP). */
	text?: Partial<Record<TextField, string>>;
	mode?: (html: string) => Mode | undefined;
	/** Site-widget provider id when the service can be carried by ID. */
	widget?: string;
}

const SIGNATURES: Signature[] = [
	{
		id: "complianz",
		name: "Complianz",
		kind: "wp-plugin",
		detect: /complianz|\bcmplz[-_]/i,
		text: { title: ".cmplz-cookiebanner .cmplz-title", body: ".cmplz-cookiebanner .cmplz-message", accept: ".cmplz-cookiebanner .cmplz-accept", reject: ".cmplz-cookiebanner .cmplz-deny", choose: ".cmplz-cookiebanner .cmplz-view-preferences", save: ".cmplz-cookiebanner .cmplz-save-preferences" },
		// Complianz prints the consent type of the banner it shows: "optin" (EU) or "optout" (US).
		mode: (html) => {
			const t = /"consenttype"\s*:\s*"(optin|optout)"/i.exec(html)?.[1] ?? /\bcmplz-(optin|optout)\b/i.exec(html)?.[1];
			return t ? (t.toLowerCase() === "optin" ? "opt-in" : "notice") : undefined;
		},
	},
	{ id: "cookieyes", name: "CookieYes", kind: "service", detect: /cdn-cookieyes\.com|\bcky-consent|\bcookieyes\b/i, widget: "cookieyes", text: { title: ".cky-title", body: ".cky-notice-des", accept: ".cky-btn-accept", reject: ".cky-btn-reject", choose: ".cky-btn-customize" } },
	{ id: "gdpr-cookie-consent", name: "GDPR Cookie Consent (CookieLawInfo)", kind: "wp-plugin", detect: /cookie-law-info|cli_action_button|\bCLI_ACCEPT/i, text: { body: "#cookie-law-info-bar .cli-bar-message", accept: "#cookie_action_close_header", reject: "#cookie_action_close_header_reject", choose: ".cli_settings_button" } },
	{ id: "cookie-notice", name: "Cookie Notice & Compliance", kind: "wp-plugin", detect: /\bcookie-notice-container\b|cn-accept-cookie|cookie-notice-front/i, text: { body: "#cn-notice-text", accept: "#cn-accept-cookie", reject: "#cn-refuse-cookie" }, mode: (html) => (/id=["']cn-refuse-cookie/i.test(html) ? undefined : "notice") },
	{ id: "borlabs", name: "Borlabs Cookie", kind: "wp-plugin", detect: /borlabs-cookie|BorlabsCookie/i, mode: () => "opt-in" },
	{ id: "real-cookie-banner", name: "Real Cookie Banner", kind: "wp-plugin", detect: /real-cookie-banner|realCookieBanner/i, mode: () => "opt-in" },
	{ id: "moove-gdpr", name: "GDPR Cookie Compliance (Moove)", kind: "wp-plugin", detect: /moove[-_]gdpr/i, text: { body: ".moove-gdpr-info-bar-content .moove-gdpr-cookie-notice p" } },
	{ id: "cookie-script", name: "Cookie-Script", kind: "service", detect: /cdn\.cookie-script\.com/i },
	{ id: "cookiebot", name: "Cookiebot", kind: "service", detect: /consent\.cookiebot\.com|\bCookiebot\b/, widget: "cookiebot" },
	{ id: "termly", name: "Termly", kind: "service", detect: /app\.termly\.io/i, widget: "termly" },
	{ id: "iubenda", name: "iubenda", kind: "service", detect: /iubenda\.com/i, widget: "iubenda" },
	{ id: "onetrust", name: "OneTrust", kind: "service", detect: /cdn\.cookielaw\.org|optanon|onetrust/i },
	{ id: "usercentrics", name: "Usercentrics", kind: "service", detect: /usercentrics\.eu|usercentrics/i },
];

function textOf(html: string, sel: string): string | undefined {
	try {
		const $ = cheerio.load(html);
		const el = $(sel).first();
		if (!el.length) return undefined;
		el.find("script, style, noscript, a").remove();
		const t = plain(el.text());
		return t || undefined;
	} catch {
		return undefined;
	}
}

export function planConsent(pages: { html: string }[], widgets: SiteWidget[]): ConsentPlan {
	const found: ConsentTool[] = [];
	const text: Partial<Record<TextField, string>> = {};
	for (const sig of SIGNATURES) {
		const hits = pages.filter((p) => sig.detect.test(p.html));
		if (!hits.length) continue;
		const mode = hits.map((p) => sig.mode?.(p.html)).find((m) => m);
		found.push({ id: sig.id, name: sig.name, kind: sig.kind, ...(mode ? { mode } : {}) });
		for (const [k, sel] of Object.entries(sig.text ?? {}) as [TextField, string][]) {
			if (text[k]) continue;
			const t = hits.map((p) => textOf(p.html, sel)).find((x) => x);
			// Only wording that fits the banner's limits; longer copy stays in the report, never cut.
			if (t && t.length <= TEXT_MAX[k] && t !== DEFAULT_TEXT[k]) text[k] = t;
		}
	}
	const keptWidgets = [...new Set(widgets.filter((w) => SIGNATURES.some((s) => s.widget === w.provider)).map((w) => w.provider))];
	if (keptWidgets.length) {
		const names = keptWidgets.map((p) => SIGNATURES.find((s) => s.widget === p)?.name ?? p);
		return { found, keptWidgets, mode: "off", text, reason: `${names.join(", ")} carried as a site widget: kept, built-in banner off (switch in Privacy & consent)` };
	}
	const tool = found[0];
	if (tool) {
		const mode = found.map((f) => f.mode).find((m) => m) ?? "auto";
		const words = Object.keys(text).length;
		return { found, keptWidgets, mode, text, reason: `${found.map((f) => f.name).join(", ")} on the old site (not available on EmDash): built-in banner in "${mode}"${mode === "auto" ? "" : " as the old banner was set up"}${words ? `, its wording carried (${Object.keys(text).join(", ")})` : ", default wording (the old banner's text was not in the saved HTML)"}` };
	}
	return { found, keptWidgets, mode: "auto", text, reason: "no consent banner on the old site: built-in banner in \"auto\" (opt-in in the EU/EEA, UK, Switzerland and Québec; a notice elsewhere)" };
}

/** coverage.md section. */
export function consentReport(p: ConsentPlan, configured?: Mode | false): string[] {
	const L = ["", "## Consent banner", ""];
	L.push(`- Old site: ${p.found.length ? p.found.map((f) => `${f.name} (${f.kind === "wp-plugin" ? "WordPress plugin" : "service"}${f.mode ? `, ${f.mode}` : ""})`).join(", ") : "no consent banner recognised"}`);
	L.push(`- New site: ${configured === false ? "Privacy & consent off (kit.config consent: false)" : configured ? `"${configured}" (kit.config consent.mode)` : p.reason}`);
	const words = Object.entries(p.text);
	if (words.length && configured !== false) L.push(`- Carried wording: ${words.map(([k, v]) => `${k} “${v.replace(/\|/g, "\\|")}”`).join("; ")}`);
	L.push("- Admins change the mode, wording and privacy policy link in Plugins → Privacy & consent.");
	return L;
}
