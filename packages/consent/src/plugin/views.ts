/** Privacy & consent admin page (Block Kit): pure functions of the page data (unit-tested). */
import type { DayCounts } from "../store.js";
import { CATEGORIES, CATEGORY_LABEL, type ConsentSettings, DESCRIPTION_MAX, MODE_INFO, MODES, needsConsent, type Services, TEXT_FIELDS, TEXT_LABEL, TEXT_MAX } from "../settings.js";

type Block = Record<string, unknown>;
export const PAGE = "/";

export interface PageData {
	settings: ConsentSettings;
	services: Services;
	/** Policy picker: published pages (label, path). */
	pages: { label: string; path: string }[];
	keptTools: string[];
	oldSite?: string;
	stats?: { day: string; counts: DayCounts }[];
	previewUrl: string;
	errors?: string[];
	/** Values the admin typed, shown again with the errors. */
	values?: Record<string, unknown>;
}

export const adminsOnly: Block[] = [{ type: "empty", title: "Administrators only", description: "Privacy & consent settings can be changed by administrators.", size: "base" }];

const str = (v: unknown, fallback: string) => (typeof v === "string" ? v : fallback);

function categoryRows(s: Services): Record<string, unknown>[] {
	return [
		{ category: "Necessary (always on)", services: [...s.cookieless.map((x) => `${x} (cookieless)`), "This choice (site_consent)"].join(", ") },
		...CATEGORIES.map((c) => ({ category: CATEGORY_LABEL[c], services: s[c].join(", ") || "—" })),
	];
}

export function page(d: PageData): Block[] {
	const s = d.settings;
	const v = d.values ?? {};
	const active = s.mode !== "off" && needsConsent(d.services);
	const total = (d.stats ?? []).reduce((a, r) => ({ accept: a.accept + r.counts.accept, reject: a.reject + r.counts.reject, custom: a.custom + r.counts.custom }), { accept: 0, reject: 0, custom: 0 });
	return [
		...(d.errors?.length ? [{ type: "banner", title: "Not saved", description: d.errors.join(" "), variant: "error" }] : []),
		...(d.keptTools.length && s.mode === "off"
			? [{ type: "banner", title: `${d.keptTools.join(", ")} handles consent`, description: `The old site's consent tool was kept, so the built-in banner is off (two banners would ask twice). Choose a mode below to use the built-in banner instead: ${d.keptTools.join(", ")} then stops loading.`, variant: "default" }]
			: []),
		...(d.keptTools.length && s.mode !== "off" ? [{ type: "banner", title: "Built-in banner in use", description: `${d.keptTools.join(", ")} from the old site no longer loads while the built-in banner is on. Set the mode to Off to go back to it.`, variant: "default" }] : []),
		...(s.mode !== "off" && !needsConsent(d.services) ? [{ type: "banner", title: "Nothing to ask about yet", description: "No tracking code or widget that stores data on visitors' devices is switched on, so the banner stays hidden. It appears by itself once one is added (SEO & Analytics → Analytics).", variant: "default" }] : []),
		{ type: "stats", items: [{ label: "Banner", value: s.mode === "off" ? "Off" : active ? "Shown" : "Hidden (nothing to ask)" }, { label: "Mode", value: MODE_INFO[s.mode].label }, { label: "Consent log", value: s.stats ? "On (counts only)" : "Off" }] },
		...(d.oldSite ? [{ type: "context", text: `Old site: ${d.oldSite}` }] : []),
		{ type: "header", text: "Banner" },
		{
			type: "form",
			block_id: "consent-settings",
			fields: [
				{ type: "select", action_id: "mode", label: "Mode", options: MODES.map((m) => ({ label: MODE_INFO[m].label, value: m })), initial_value: str(v.mode, s.mode) },
				{ type: "select", action_id: "position", label: "Position", options: [{ label: "Bar along the bottom", value: "bar" }, { label: "Card in the bottom corner", value: "card" }], initial_value: str(v.position, s.position) },
				...TEXT_FIELDS.map((k) => ({ type: "text_input", action_id: `text:${k}`, label: `${TEXT_LABEL[k]} (up to ${TEXT_MAX[k]} characters)`, initial_value: str(v[`text:${k}`], s.text[k]), ...(k === "body" ? { multiline: true } : {}) })),
				{ type: "select", action_id: "policy", label: "Privacy policy page", options: [{ label: "None", value: "none" }, ...d.pages.map((p) => ({ label: `${p.label} (${p.path})`, value: p.path })), ...(s.policy && !d.pages.some((p) => p.path === s.policy) ? [{ label: s.policy, value: s.policy }] : [])], initial_value: str(v.policy, s.policy || "none") },
				...(["necessary", ...CATEGORIES] as const).map((k) => ({ type: "text_input", action_id: `desc:${k}`, label: `${CATEGORY_LABEL[k]}: description (up to ${DESCRIPTION_MAX} characters)`, initial_value: str(v[`desc:${k}`], s.descriptions[k]), multiline: true })),
				{ type: "toggle", action_id: "footerLink", label: "Cookie settings link in the footer", description: "Lets visitors change their choice at any time. Any link or button with the data-consent-open attribute does the same.", initial_value: v.footerLink !== undefined ? v.footerLink === true : s.footerLink },
				{ type: "toggle", action_id: "stats", label: "Consent log (counts only)", description: "Counts per day how many visitors accepted, rejected or chose. No IP address, no identifier, nothing about the visitor. Off by default.", initial_value: v.stats !== undefined ? v.stats === true : s.stats },
			],
			submit: { label: "Save", action_id: "save" },
		},
		{ type: "context", text: `Plain text only. ${Object.values(MODE_INFO).map((m) => `${m.label}: ${m.description}`).join(" ")} Saving updates the live pages within seconds.${s.updatedBy ? ` Last change ${s.updatedAt.slice(0, 16).replace("T", " ")} UTC by ${s.updatedBy}.` : ""}` },
		{
			type: "actions",
			elements: [
				{ type: "link", label: "Preview the banner", target: { kind: "external", url: d.previewUrl }, appearance: "secondary" },
				{ type: "button", action_id: "ask-again", label: "Ask every visitor again", style: "secondary", confirm: { title: "Ask every visitor again?", text: "Visitors who already chose see the banner again on their next page. Use this after adding a new kind of tracking.", confirm: "Ask again", deny: "Cancel" } },
			],
		},
		{ type: "context", text: `The preview opens the saved banner on this site whatever the visitor chose before. Visitors were last asked again at revision ${s.revision}.` },
		{ type: "divider" },
		{ type: "header", text: "What each category covers" },
		{ type: "table", block_id: "categories", page_action_id: "noop", columns: [{ key: "category", label: "Category" }, { key: "services", label: "Services on this site" }], rows: categoryRows(d.services) },
		{ type: "context", text: "From the tracking codes switched on in SEO & Analytics → Analytics and the site's widgets. Google Analytics and Tag Manager: analytics (Google consent mode: analytics_storage); Google Ads and Meta Pixel: marketing (ad_storage, ad_user_data, ad_personalization); Clarity and Hotjar: analytics; chat and review widgets: preferences. Cloudflare Web Analytics stores nothing on the device and always runs. Videos and maps inside pages are not covered by the banner." },
		{ type: "divider" },
		{ type: "header", text: "Consent log" },
		...(s.stats && d.stats
			? [
					{ type: "stats", items: [{ label: "Accepted all, 30 days", value: total.accept }, { label: "Rejected", value: total.reject }, { label: "Chose", value: total.custom }] },
					{ type: "chart", config: { chart_type: "timeseries", style: "bar", height: 200, y_axis_name: "Per day", series: (["accept", "reject", "custom"] as const).map((k) => ({ name: k === "accept" ? "Accepted" : k === "reject" ? "Rejected" : "Chose", data: (d.stats ?? []).map((r) => [Date.parse(`${r.day}T12:00:00Z`), r.counts[k]]) })) } },
					{ type: "context", text: "Counts of choices made in the banner, per day (UTC), kept 90 days. Visitors with an ad blocker or without JavaScript are not counted; counts are indicative." },
					{ type: "actions", elements: [{ type: "button", action_id: "stats-clear", label: "Delete all counts", style: "danger", confirm: { title: "Delete all counts?", text: "The consent log starts again from zero.", confirm: "Delete", deny: "Keep" } }] },
				]
			: [{ type: "context", text: "Off. Switch on “Consent log” above to count choices per day (no personal data)." }]),
	];
}
