/**
 * When does a page go through the DOM fallback (rendered HTML → sections) instead of an adapter?
 * Only pages no adapter claims: detectBuilder said "classic" or "empty", and something shows the page is really built
 * with a builder the kit has no adapter for (its post meta, its shortcode family, its markup in post_content, the live
 * page's body classes), or post_content is empty while the live page renders content. Pages a real adapter handles
 * (WPBakery, Gutenberg blocks, Bricks, Elementor, Divi) never reach this. Facts: docs/spikes/dom-fallback-findings.md.
 */
import { shortcodeAction } from "../shortcodes.js";

export interface FallbackReason {
	/** Builder or theme the evidence points at ("beaver-builder", "avada"…), or "unknown". */
	builder: string;
	/** Human-readable evidence, for the coverage report. */
	why: string;
}

const truthy = (v: unknown) => v !== undefined && v !== null && v !== "" && v !== "0" && v !== 0 && v !== false && !(Array.isArray(v) && !v.length) && !(typeof v === "object" && !Array.isArray(v) && v !== null && !Object.keys(v).length);

/** Post meta keys each builder writes on the pages it builds (value must be set; some must equal a value). */
const META: { builder: string; key: string; equals?: RegExp }[] = [
	{ builder: "beaver-builder", key: "_fl_builder_enabled", equals: /^(1|true)$/ },
	{ builder: "beaver-builder", key: "_fl_builder_data" },
	{ builder: "oxygen", key: "ct_builder_shortcodes" },
	{ builder: "oxygen", key: "_ct_builder_shortcodes" },
	{ builder: "oxygen", key: "ct_builder_json" },
	{ builder: "oxygen", key: "_ct_builder_json" },
	{ builder: "oxygen", key: "_oxygen_data" },
	{ builder: "breakdance", key: "_breakdance_data" },
	{ builder: "breakdance", key: "breakdance_data" },
	{ builder: "brizy", key: "brizy" },
	{ builder: "brizy", key: "brizy_post_uid" },
	{ builder: "thrive-architect", key: "tcb_editor_enabled", equals: /^(1|true)$/ },
	{ builder: "thrive-architect", key: "tve_updated_post" },
	{ builder: "siteorigin", key: "panels_data" },
	{ builder: "visual-composer", key: "vcv-pageContent" },
	{ builder: "zion-builder", key: "_zionbuilder_page_status", equals: /^enabled$/ },
	{ builder: "cornerstone", key: "_cornerstone_data" },
	{ builder: "themify", key: "_themify_builder_settings_json" },
	{ builder: "live-composer", key: "dslc_code" },
	{ builder: "avada", key: "fusion_builder_status", equals: /^active$/ },
	{ builder: "enfold", key: "_aviaLayoutBuilder_active", equals: /^active$/ },
];

/** Shortcode families of builders and theme builders without an adapter (`[fusion_builder_container]`…). */
const SHORTCODE_FAMILIES: { builder: string; re: RegExp }[] = [
	{ builder: "avada", re: /\[fusion_[a-z_]+/ },
	{ builder: "enfold", re: /\[av_[a-z_]+/ },
	{ builder: "flatsome", re: /\[(?:ux_[a-z_]+|section\b[^\]]*\]\s*\[row\b)/ },
	{ builder: "cornerstone", re: /\[cs_[a-z_]+/ },
	{ builder: "x-theme", re: /\[x_[a-z_]+/ },
	{ builder: "themify", re: /\[themify_[a-z_]+/ },
	{ builder: "kingcomposer", re: /\[kc_[a-z_]+/ },
	{ builder: "betheme", re: /\[mfn_[a-z_]+/ },
	{ builder: "jupiter", re: /\[mk_[a-z_]+/ },
	{ builder: "impreza", re: /\[us_[a-z_]+/ },
	{ builder: "tatsu", re: /\[tatsu_[a-z_]+/ },
	{ builder: "qode", re: /\[(?:qode|edgtf|eltd|mkdf|qodef)_[a-z_]+/ },
	{ builder: "themerex", re: /\[trx_[a-z_]+/ },
];

/** Builder markup copied into post_content (some builders save a rendered copy there for search and RSS). */
const CONTENT_MARKUP: { builder: string; re: RegExp }[] = [
	{ builder: "beaver-builder", re: /class="[^"]*\bfl-(?:builder-content|row|module)\b/ },
	{ builder: "siteorigin", re: /class="[^"]*\b(?:panel-grid|so-panel|panel-layout)\b/ },
	{ builder: "thrive-architect", re: /class="[^"]*\b(?:thrv_wrapper|tve_|tcb-)/ },
	{ builder: "brizy", re: /class="[^"]*\bbrz-/ },
	{ builder: "visual-composer", re: /class="[^"]*\bvce-(?:row|col)/ },
	{ builder: "oxygen", re: /class="[^"]*\b(?:ct-section|oxy-)/ },
	{ builder: "breakdance", re: /class="[^"]*\bbde-/ },
];

/** Body classes / markup of the live page that only appear on pages the builder renders. */
const PAGE_MARKERS: { builder: string; body?: RegExp; html?: RegExp; pageOnly: boolean }[] = [
	{ builder: "beaver-builder", body: /^fl-builder$/, pageOnly: true },
	{ builder: "siteorigin", body: /^siteorigin-panels$/, pageOnly: true },
	{ builder: "thrive-architect", html: /id="tve_editor"/, pageOnly: true },
	{ builder: "visual-composer", body: /^vcwb$/, pageOnly: true },
	{ builder: "brizy", body: /^brz$/, html: /class="[^"]*\bbrz-root__container/, pageOnly: true },
	// Site-wide renderers: every page of the site carries them, so they only explain an empty post_content.
	{ builder: "oxygen", body: /^oxygen-body$/, pageOnly: false },
	{ builder: "breakdance", body: /^breakdance$/, pageOnly: false },
	{ builder: "avada", body: /^fusion-body$/, pageOnly: false },
	{ builder: "flatsome", body: /^flatsome$/, pageOnly: false },
];

/** WordPress core shortcodes the classic adapter handles itself. */
const CORE = new Set(["caption", "wp_caption", "gallery", "embed", "video", "audio", "playlist"]);

/** Body classes of a saved page (`<body class="…">`). */
export function bodyClassesOf(html: string): string[] {
	return (/<body\b[^>]*\bclass="([^"]*)"/i.exec(html)?.[1] ?? "").split(/\s+/).filter(Boolean);
}

/**
 * Shortcodes of one unknown family that wrap most of post_content: ≥ 3 opening tags no handler or registry entry knows,
 * and less than a fifth of the visible text outside them. Returns the tag names.
 */
export function unknownShortcodeLayout(content: string): string[] | undefined {
	const tags = [...content.matchAll(/\[([a-zA-Z][\w-]*)(?=[\s\]/])/g)].map((m) => m[1] as string);
	const unknown = tags.filter((t) => !CORE.has(t) && !shortcodeAction(t));
	if (unknown.length < 3) return undefined;
	const text = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, "").length;
	const total = text(content.replace(/\[[^\]]*\]/g, ""));
	// Text outside every shortcode pair: drop [x …]…[/x] spans of the unknown tags, outermost first.
	let outside = content;
	for (const t of [...new Set(unknown)]) outside = outside.replace(new RegExp(`\\[${t}\\b[^\\]]*\\][\\s\\S]*?\\[\\/${t}\\]`, "g"), "");
	outside = outside.replace(/\[[^\]]*\]/g, "");
	if (total > 0 && text(outside) / total >= 0.2) return undefined;
	return [...new Set(unknown)];
}

/**
 * Why this page needs the DOM fallback, or undefined (keep the classic/empty handling).
 * `builder` is what detectBuilder returned; only "classic" and "empty" pages are considered.
 * `live`: the audit snapshot of the page (its HTML and the words in its main content area), when there is one.
 */
export function fallbackReason(builder: string, content: string, meta: Record<string, unknown> | undefined, live?: { html: string; words: number }): FallbackReason | undefined {
	if (builder !== "classic" && builder !== "empty") return undefined;
	for (const m of META) {
		const v = meta?.[m.key];
		if (!truthy(v)) continue;
		if (m.equals && !m.equals.test(String(Array.isArray(v) ? v[0] : v))) continue;
		return { builder: m.builder, why: `post meta ${m.key} (${m.builder}, no adapter)` };
	}
	if (builder === "classic") {
		for (const f of SHORTCODE_FAMILIES) {
			const hit = f.re.exec(content);
			if (hit) return { builder: f.builder, why: `${hit[0].replace(/\s.*$/, "")}… shortcodes in post_content (${f.builder}, no adapter)` };
		}
		for (const f of CONTENT_MARKUP) if (f.re.test(content)) return { builder: f.builder, why: `${f.builder} markup in post_content (a rendered copy; the builder keeps the page elsewhere)` };
		const unknown = unknownShortcodeLayout(content);
		if (unknown) return { builder: "unknown", why: `post_content is mostly shortcodes no handler knows: ${unknown.slice(0, 6).map((t) => `[${t}]`).join(", ")}` };
	}
	if (live) {
		const classes = bodyClassesOf(live.html);
		for (const m of PAGE_MARKERS) {
			if (!m.pageOnly && builder !== "empty") continue;
			const hit = (m.body && classes.some((c) => m.body?.test(c))) || (m.html && m.html.test(live.html));
			if (hit) return { builder: m.builder, why: `the live page is rendered by ${m.builder} (${m.body && classes.some((c) => m.body?.test(c)) ? `body class "${classes.find((c) => m.body?.test(c))}"` : "its markup"})${builder === "empty" ? " and post_content is empty" : ""}` };
		}
		if (builder === "empty" && live.words >= 15) return { builder: "unknown", why: `post_content is empty but the live page shows ${live.words} words of content (a builder or the theme renders it)` };
	}
	return undefined;
}
