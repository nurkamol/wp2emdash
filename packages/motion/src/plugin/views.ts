/** Motion admin page (Block Kit): pure functions of the page data (unit-tested). */
import { ENTRANCES, type Entrance, type MotionSettings, PRELOADER_BG_LABEL, PRELOADER_BGS, PRELOADER_MIN_MAX, type SiteEntrance, speedNote, TRANSITION_LABEL, TRANSITION_MS, TRANSITIONS } from "../settings.js";

type Block = Record<string, unknown>;
export const PAGE = "/";

export interface PageData {
	settings: MotionSettings;
	siteEntrance: SiteEntrance;
	/** Link to the site with the saved settings (always offered). */
	savedUrl: string;
	/** Link to the site with the settings the admin typed but did not save ("Preview only"). */
	previewUrl?: string;
	/** Settings shown in the form instead of the saved ones (after "Preview only" or an error). */
	draft?: MotionSettings;
	errors?: string[];
}

export const adminsOnly: Block[] = [{ type: "empty", title: "Administrators only", description: "Motion settings can be changed by administrators.", size: "base" }];

const ENTRANCE_LABEL = (site: SiteEntrance): Record<Entrance, string> => ({ site: `As the site was built (${site === "calm" ? "calm" : "standard"})`, off: "Off", calm: "Calm (gentle rise, cards follow one by one)", standard: "Standard (sections rise into view)" });

const on = (b: boolean) => (b ? "On" : "Off");

export function page(d: PageData): Block[] {
	const s = d.draft ?? d.settings;
	const saved = d.settings;
	const entranceNow = saved.entrance === "site" ? d.siteEntrance : saved.entrance;
	return [
		...(d.errors?.length ? [{ type: "banner", title: "Not saved", description: d.errors.join(" "), variant: "error" }] : []),
		...(d.previewUrl ? [{ type: "banner", title: "Preview ready (not saved)", description: "Open the preview below to see these settings on the site; only you see them. Switch off “Preview only” and press Save to publish them.", variant: "default" }] : []),
		{ type: "stats", items: [{ label: "Preloader", value: saved.preloader === "logo" ? "Logo, first visit" : "Off" }, { label: "Page transitions", value: TRANSITION_LABEL[saved.transition] }, { label: "Entrance", value: entranceNow === "off" ? "Off" : entranceNow === "calm" ? "Calm" : "Standard" }] },
		{ type: "context", text: speedNote(saved) },
		{ type: "header", text: "Motion on the public site" },
		{
			type: "form",
			block_id: "motion-settings",
			fields: [
				{ type: "select", action_id: "preloader", label: "First-visit preloader", options: [{ label: "Off", value: "off" }, { label: "Logo (first page of a visit only)", value: "logo" }], initial_value: s.preloader },
				{ type: "select", action_id: "preloaderBg", label: "Preloader background", options: PRELOADER_BGS.map((b) => ({ label: PRELOADER_BG_LABEL[b], value: b })), initial_value: s.preloaderBg, condition: { field: "preloader", eq: "logo" } },
				{ type: "number_input", action_id: "preloaderMinMs", label: `Show the logo at least (ms, 0–${PRELOADER_MIN_MAX})`, initial_value: s.preloaderMinMs, min: 0, max: PRELOADER_MIN_MAX, condition: { field: "preloader", eq: "logo" } },
				{ type: "select", action_id: "transition", label: "Page transitions", options: TRANSITIONS.map((t) => ({ label: TRANSITION_LABEL[t], value: t })), initial_value: s.transition },
				{ type: "select", action_id: "transitionMs", label: "Transition duration", options: TRANSITION_MS.map((ms) => ({ label: `${ms} ms${ms === 250 ? " (recommended)" : ""}`, value: String(ms) })), initial_value: String(s.transitionMs), condition: { field: "transition", neq: "off" } },
				{ type: "select", action_id: "entrance", label: "Element entrance animations", options: ENTRANCES.map((e) => ({ label: ENTRANCE_LABEL(d.siteEntrance)[e], value: e })), initial_value: s.entrance },
				{ type: "toggle", action_id: "hoverLift", label: "Hover lift on cards and buttons", description: "Cards and buttons rise slightly under the mouse. Not on touch screens.", initial_value: s.hoverLift },
				{ type: "toggle", action_id: "smoothScroll", label: "Smooth scrolling for anchor links", description: "Links to a part of the page (#contact) glide there instead of jumping.", initial_value: s.smoothScroll },
				{ type: "toggle", action_id: "imageFade", label: "Images fade in when they load", description: "Pictures further down the page appear softly instead of popping in.", initial_value: s.imageFade },
				{ type: "toggle", action_id: "parallax", label: "Parallax pictures and drifting columns (from the old site)", description: "Only where the old site had them. Switch off to keep those pictures and columns still.", initial_value: s.parallax },
				{ type: "toggle", action_id: "progress", label: "Scroll progress bar", description: "A thin bar along the top shows how far down the page the visitor is. Shown in browsers that support it (Chrome, Edge, recent Safari).", initial_value: s.progress },
				{ type: "toggle", action_id: "previewOnly", label: "Preview only (do not publish yet)", description: "Press Save to get a preview link with these settings; nothing changes for visitors.", initial_value: !!d.previewUrl },
			],
			submit: { label: "Save", action_id: "save" },
		},
		{
			type: "context",
			text: `Visitors who ask their device for reduced motion never see any of this (always respected; it cannot be switched off). The preloader shows at most once per visit, never longer than 1.2 seconds, never to search engines. Page transitions work in Chrome, Edge and Safari 18.2+; other browsers simply change pages as before. Saving updates the live pages within seconds.${saved.updatedBy ? ` Last change ${saved.updatedAt.slice(0, 16).replace("T", " ")} UTC by ${saved.updatedBy}.` : ""}`,
		},
		{
			type: "actions",
			elements: [
				...(d.previewUrl ? [{ type: "link", label: "Open the preview", target: { kind: "external", url: d.previewUrl }, appearance: "primary" }] : []),
				{ type: "link", label: "Preview the saved settings", target: { kind: "external", url: d.savedUrl }, appearance: "secondary" },
				{ type: "button", action_id: "reset", label: "Turn all motion off", style: "secondary", confirm: { title: "Turn all motion off?", text: "Preloader, transitions and extras off; entrances and parallax back to how the site was built.", confirm: "Turn off", deny: "Cancel" } },
			],
		},
		{ type: "context", text: `Now: preloader ${saved.preloader === "logo" ? "on" : "off"}; transitions ${saved.transition === "off" ? "off" : `${TRANSITION_LABEL[saved.transition].toLowerCase()}, ${saved.transitionMs} ms`}; hover lift ${on(saved.hoverLift).toLowerCase()}; smooth scrolling ${on(saved.smoothScroll).toLowerCase()}; image fade-in ${on(saved.imageFade).toLowerCase()}; parallax ${saved.parallax ? "as built" : "off"}; progress bar ${on(saved.progress).toLowerCase()}. The preloader uses the site's logo (Settings → General, else the migrated logo); without a logo there is no preloader.` },
	];
}
