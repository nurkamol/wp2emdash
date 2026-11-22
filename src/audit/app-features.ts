/**
 * App features: the WordPress plugins that run an application rather than show content — online courses,
 * memberships, carts and checkout, bookings, ticketed events, forums and visitor accounts. The kit does not migrate
 * them (docs/PLAN.md §9; "Not yet" on the public page), so they are detected as early as possible — in `estimate`
 * and in the `audit` gate — instead of surfacing late as missing pages.
 *
 * One catalogue, used by the audit (gate `no-out-of-scope`, reports/audit/app-features.md) and the estimate
 * (a blocker finding and a scope line per detection). Public HTML only, no credentials: plugin asset folders
 * (/wp-content/plugins/<slug>/), body classes, class and id tokens in the markup, generator / meta tags and REST
 * namespaces from the wp-json index the discovery already read. Page text is never matched, so a theme that talks
 * about "courses" or "bookings" does not count. Address patterns (/courses/, /cart/ …) are supporting evidence only:
 * they never make a detection on their own.
 */
import type { PluginInfo } from "./fingerprint.js";
import type { PageSnapshot } from "./page.js";
import { WOO_EXTENSIONS } from "../transform/shop.js";

export type AppCategory = "lms" | "membership" | "commerce" | "booking" | "events" | "community" | "accounts";

/**
 * What the kit does with it:
 * - out-of-scope: not migrated; the app stays where it is (or moves to a hosted service) and the new site links to it.
 * - external-embed: not migrated; a hosted service's widget or link takes its place on the new site.
 * - catalogue-mode: WooCommerce only — products as pages with a Buy button to an external checkout, by owner
 *   decision (kit.config shop, docs/PLAN.md §8b). Cart, checkout and customer accounts are not rebuilt.
 */
export type AppHandling = "out-of-scope" | "external-embed" | "catalogue-mode";

export interface AppFeatureEntry {
	id: string;
	name: string;
	category: AppCategory;
	/** Plugin folder slugs (/wp-content/plugins/<slug>/, as the fingerprint reports them). */
	plugins: string[];
	/** REST namespace prefixes ("ldlms" matches "ldlms/v2"). */
	rest?: string[];
	/** Body class tokens. */
	bodyClasses?: RegExp[];
	/** Class or id tokens anywhere in the markup (whole tokens, never page text). */
	tokens?: RegExp[];
	/** Custom element tag names (<sc-checkout>). */
	tags?: RegExp[];
	/** <meta name="generator"> contents. */
	generators?: RegExp[];
	/** Other <meta name="…"> names the plugin prints. */
	metas?: RegExp[];
	/** A page with a password field outside WordPress's own and WooCommerce's forms (generic front-end login). */
	passwordForm?: boolean;
	/** Address patterns (page path or internal link path): supporting evidence only. */
	paths?: RegExp[];
	handling: AppHandling;
	/** Where the feature can go instead (generic categories of service, never a vendor). */
	path: string;
	/** For the estimate: what is not estimated and what the kit's share is. */
	effort: string;
}

const CATEGORY_LABEL: Record<AppCategory, string> = {
	lms: "online courses",
	membership: "memberships",
	commerce: "cart and checkout",
	booking: "bookings",
	events: "ticketed events",
	community: "forum / community",
	accounts: "visitor accounts",
};
export const categoryLabel = (c: AppCategory) => CATEGORY_LABEL[c];

const PATH = {
	lms: "Keep the course area on WordPress on a subdomain (for example learn.<domain>) and link to it, or move the courses to a hosted course platform; the marketing pages migrate.",
	membership: "Keep the members' area on WordPress on a subdomain and link to it, or move it to a hosted membership service; the public pages migrate.",
	store: "Keep the store on WordPress on a subdomain (for example shop.<domain>), or move it to a hosted store; the rest of the site migrates and links to it.",
	booking: "Move bookings to a hosted scheduling service and embed its widget or link to it (the kit keeps booking embeds as they are), or keep the booking pages on WordPress on a subdomain.",
	events: "Sell tickets through a hosted ticketing service and embed or link it; the event pages themselves can migrate as content.",
	community: "Keep the forum or community on WordPress on a subdomain and link to it, or move it to a hosted community platform.",
	accounts: "Find out what the login is for: if it only leads to the WordPress admin, nothing to do; visitor accounts stay with the application that needs them (a subdomain or a hosted service).",
} as const;

const EFFORT = {
	lms: "Not estimated: moving a course platform (courses, lessons, enrolments, progress, quizzes, certificates) is a project of its own. Included: linking the new site to where the courses live.",
	membership: "Not estimated: members, levels, payments and access rules are application data. Included: linking the new site to the members' area.",
	store: "Not estimated: carts, orders, customers and payments are application data. Included: linking the new site to the store.",
	booking: "Not estimated: services, staff, schedules and existing appointments move with the booking service. Included: embedding or linking that service's widget.",
	events: "Not estimated: ticket types, orders and attendees move with the ticketing service. Included: embedding or linking it on the event pages.",
	community: "Not estimated: members, threads and replies are application data. Included: linking the new site to the community.",
	accounts: "Not estimated: visitor accounts are application data. Included: confirming with the owner what the login is for and linking it.",
} as const;

const OOS = "out-of-scope" as const;
const EMBED = "external-embed" as const;

export const APP_FEATURES: AppFeatureEntry[] = [
	// --- Online courses (LMS)
	{ id: "learndash", name: "LearnDash", category: "lms", plugins: ["sfwd-lms", "learndash"], rest: ["ldlms"], bodyClasses: [/^learndash-cpt/, /^single-sfwd-(courses|lessons|topic|quiz)$/, /^post-type-archive-sfwd-courses$/], tokens: [/^learndash-wrapper$/, /^learndash_(course_content|post_)/, /^ld-(course-list|focus|item-list)/], paths: [/^\/courses?\//, /^\/lessons?\//, /^\/topics?\//, /^\/quizzes\//], handling: OOS, path: PATH.lms, effort: EFFORT.lms },
	{ id: "lifterlms", name: "LifterLMS", category: "lms", plugins: ["lifterlms"], rest: ["llms"], bodyClasses: [/^llms-/], tokens: [/^llms-(syllabus-wrapper|course-progress|student-dashboard|access-plans?|lesson-preview|course-navigation)/], paths: [/^\/course\//, /^\/lesson\//, /^\/dashboard\//], handling: OOS, path: PATH.lms, effort: EFFORT.lms },
	{ id: "tutor-lms", name: "Tutor LMS", category: "lms", plugins: ["tutor", "tutor-pro"], rest: ["tutor"], bodyClasses: [/^tutor-lms$/], tokens: [/^tutor-(wrap|container|course-|dashboard|single-course|lms)/], paths: [/^\/courses\//, /^\/dashboard\//], handling: OOS, path: PATH.lms, effort: EFFORT.lms },
	{ id: "sensei-lms", name: "Sensei LMS", category: "lms", plugins: ["sensei-lms", "sensei", "woothemes-sensei", "sensei-pro"], rest: ["sensei-internal"], bodyClasses: [/^sensei(-|$)/], tokens: [/^wp-block-sensei-lms-/, /^sensei-course-/], paths: [/^\/courses?\//, /^\/lessons?\//], handling: OOS, path: PATH.lms, effort: EFFORT.lms },
	{ id: "masterstudy-lms", name: "MasterStudy LMS", category: "lms", plugins: ["masterstudy-lms-learning-management-system", "masterstudy-lms-learning-management-system-pro"], bodyClasses: [/^stm[-_]lms/], tokens: [/^stm[-_]lms/, /^masterstudy-/], paths: [/^\/courses\//], handling: OOS, path: PATH.lms, effort: EFFORT.lms },

	// --- Memberships and paywalls
	{ id: "memberpress", name: "MemberPress", category: "membership", plugins: ["memberpress"], rest: ["mp"], tokens: [/^mepr-/, /^mp_wrapper$/], paths: [/^\/(register|login|account)\//], handling: OOS, path: PATH.membership, effort: EFFORT.membership },
	{ id: "paid-memberships-pro", name: "Paid Memberships Pro", category: "membership", plugins: ["paid-memberships-pro"], rest: ["pmpro"], bodyClasses: [/^pmpro-/], tokens: [/^pmpro(_|-)/], paths: [/^\/membership-(account|checkout|levels)\//], handling: OOS, path: PATH.membership, effort: EFFORT.membership },
	{ id: "restrict-content-pro", name: "Restrict Content Pro", category: "membership", plugins: ["restrict-content-pro", "restrict-content"], rest: ["rcp"], tokens: [/^rcp_(form|registration_form|login_form|level)/, /^rcp-/], paths: [/^\/(register|login|account)\//], handling: OOS, path: PATH.membership, effort: EFFORT.membership },
	{ id: "woocommerce-memberships", name: "WooCommerce Memberships", category: "membership", plugins: WOO_EXTENSIONS.memberships, tokens: [/^wc-memberships/], paths: [/^\/my-account\/members-area\//], handling: OOS, path: PATH.membership, effort: EFFORT.membership },
	{ id: "woocommerce-subscriptions", name: "WooCommerce Subscriptions", category: "membership", plugins: WOO_EXTENSIONS.subscriptions, tokens: [/^product-type-(variable-)?subscription$/, /^wcs-(switch|cancel|subscription)/], paths: [/^\/my-account\/subscriptions\//], handling: OOS, path: PATH.store, effort: EFFORT.store },
	{ id: "ultimate-member", name: "Ultimate Member", category: "membership", plugins: ["ultimate-member"], bodyClasses: [/^um-page/], tokens: [/^um-(form|login|register|profile|account|members|directory)\b/], paths: [/^\/(user|members|account|login|register)\//], handling: OOS, path: PATH.membership, effort: EFFORT.membership },
	{ id: "s2member", name: "s2Member", category: "membership", plugins: ["s2member", "s2member-pro"], tokens: [/^ws-plugin--s2member/, /^s2member-/], handling: OOS, path: PATH.membership, effort: EFFORT.membership },

	// --- Carts and checkout
	{ id: "woocommerce", name: "WooCommerce (cart and checkout)", category: "commerce", plugins: ["woocommerce"], rest: ["wc"], generators: [/^WooCommerce\b/i], bodyClasses: [/^woocommerce-(cart|checkout|account)$/], tokens: [/^woocommerce-(cart-form|checkout)$/], paths: [/^\/(cart|basket|checkout|my-account)\//], handling: "catalogue-mode", path: "Catalogue mode when the owner chooses it (kit.config shop): products as pages, the Buy button goes to an external checkout, payment links or the contact form. Otherwise keep the store on WordPress on a subdomain or move it to a hosted store.", effort: "Catalogue mode is estimated by the shop rule (products, Buy links). Carts, orders, customers and coupons are not migrated." },
	{ id: "easy-digital-downloads", name: "Easy Digital Downloads", category: "commerce", plugins: ["easy-digital-downloads", "easy-digital-downloads-pro"], rest: ["edd"], generators: [/Easy Digital Downloads/i], bodyClasses: [/^edd-(checkout|page|test-mode)/], tokens: [/^edd[-_](checkout|submit|cart|purchase|download)/, /^edd_download/], paths: [/^\/downloads?\//, /^\/checkout\//], handling: OOS, path: PATH.store, effort: EFFORT.store },
	{ id: "surecart", name: "SureCart", category: "commerce", plugins: ["surecart"], rest: ["surecart"], tokens: [/^wp-block-surecart-/], tags: [/^sc-(checkout|buy-button|cart|order-|line-items|form)/], paths: [/^\/(checkout|shop|customer-dashboard)\//], handling: OOS, path: PATH.store, effort: EFFORT.store },

	// --- Bookings
	{ id: "amelia", name: "Amelia", category: "booking", plugins: ["ameliabooking"], tokens: [/^amelia-(app|v2|booking|step-booking|catalog|events)/], handling: EMBED, path: PATH.booking, effort: EFFORT.booking },
	{ id: "bookly", name: "Bookly", category: "booking", plugins: ["bookly-responsive-appointment-booking-tool", "appointment-booking"], tokens: [/^bookly-(form|css-root|js-)/], handling: EMBED, path: PATH.booking, effort: EFFORT.booking },
	{ id: "woocommerce-bookings", name: "WooCommerce Bookings", category: "booking", plugins: WOO_EXTENSIONS.bookings, rest: ["wc-bookings"], tokens: [/^wc-bookings-(booking-form|date-picker)/, /^product-type-booking$/], handling: EMBED, path: PATH.booking, effort: EFFORT.booking },
	{ id: "birchpress", name: "BirchPress Scheduler", category: "booking", plugins: ["birchschedule", "birchpress-scheduler"], tokens: [/^birs[_-]/, /^birchschedule/], handling: EMBED, path: PATH.booking, effort: EFFORT.booking },
	{ id: "simply-schedule-appointments", name: "Simply Schedule Appointments", category: "booking", plugins: ["simply-schedule-appointments"], rest: ["ssa"], tokens: [/^ssa[_-](booking|iframe)/], handling: EMBED, path: PATH.booking, effort: EFFORT.booking },

	// --- Events with tickets (an events calendar alone is content, not an app)
	{ id: "event-tickets", name: "Event Tickets (The Events Calendar)", category: "events", plugins: ["event-tickets", "event-tickets-plus"], rest: ["tribe/tickets"], tokens: [/^tribe-tickets/, /^tribe-block__tickets/], handling: EMBED, path: PATH.events, effort: EFFORT.events },
	{ id: "event-espresso", name: "Event Espresso", category: "events", plugins: ["event-espresso-core-reg", "event-espresso-core", "event-espresso-decaf"], rest: ["ee"], bodyClasses: [/^espresso/], tokens: [/^espresso-/, /^event-espresso/, /^tkt-slctr/], handling: EMBED, path: PATH.events, effort: EFFORT.events },

	// --- Forums and communities
	{ id: "bbpress", name: "bbPress", category: "community", plugins: ["bbpress"], bodyClasses: [/^bbpress$/], tokens: [/^bbp-(forums|topics|replies|forum-|topic-|reply-|template-notice)/], paths: [/^\/forums?\//, /^\/topics?\//], handling: OOS, path: PATH.community, effort: EFFORT.community },
	{ id: "buddypress", name: "BuddyPress", category: "community", plugins: ["buddypress"], rest: ["buddypress"], bodyClasses: [/^buddypress$/, /^bp-(nouveau|legacy)$/], paths: [/^\/(members|groups|activity)\//], handling: OOS, path: PATH.community, effort: EFFORT.community },
	{ id: "buddyboss", name: "BuddyBoss", category: "community", plugins: ["buddyboss-platform", "buddyboss-platform-pro"], rest: ["buddyboss"], bodyClasses: [/^buddyboss-theme$/, /^bb-buddypanel$/], paths: [/^\/(members|groups|activity)\//], handling: OOS, path: PATH.community, effort: EFFORT.community },

	// --- Visitor accounts and front-end login
	{ id: "profile-builder", name: "Profile Builder", category: "accounts", plugins: ["profile-builder", "profile-builder-pro"], tokens: [/^wppb-(user-forms|register-user|login-wrap|edit-user)/], paths: [/^\/(login|register|edit-profile)\//], handling: OOS, path: PATH.accounts, effort: EFFORT.accounts },
	{ id: "front-end-login", name: "Front-end login form", category: "accounts", plugins: [], passwordForm: true, paths: [/^\/(login|log-in|sign-in|register|account|members?-area)\//], handling: OOS, path: PATH.accounts, effort: EFFORT.accounts },
];

const BY_ID = new Map(APP_FEATURES.map((e) => [e.id, e]));
export const appFeature = (id: string) => BY_ID.get(id);

/** Every plugin folder slug the catalogue knows, with its entry (the fingerprint's plugin matrix reads these). */
export const APP_PLUGIN_SLUGS: ReadonlyMap<string, AppFeatureEntry> = new Map(APP_FEATURES.flatMap((e) => e.plugins.map((s) => [s, e] as const)));

/** One signal on one page. strong: enough on its own; weak (addresses): supporting evidence only. */
export interface AppSignal {
	feature: string;
	kind: "asset" | "body-class" | "markup" | "tag" | "generator" | "meta" | "password-form" | "address";
	value: string;
	strong: boolean;
}

export interface PageAppSignals {
	/** Page path. */
	page: string;
	signals: AppSignal[];
}

type PageInput = Pick<PageSnapshot, "url" | "bodyClasses" | "forms" | "links">;

const pathOf = (u: string) => {
	try {
		const p = new URL(u).pathname;
		return p.endsWith("/") ? p : `${p}/`;
	} catch {
		return "";
	}
};

/**
 * Scan one fetched page (its raw HTML and its parsed snapshot) for app signals. Pure. Only markup is read: class and
 * id tokens, tag names, meta tags, asset paths, forms and addresses — never the visible text.
 */
export function scanAppSignals(html: string, page: PageInput): PageAppSignals {
	const out: AppSignal[] = [];
	const seen = new Set<string>();
	const add = (s: AppSignal) => {
		const k = `${s.feature}|${s.kind}|${s.value}`;
		if (seen.has(k)) return;
		seen.add(k);
		out.push(s);
	};
	const assets = new Set<string>();
	for (const m of html.matchAll(/wp-content\/plugins\/([a-z0-9_.-]+)\//gi)) assets.add((m[1] as string).toLowerCase());
	const tokens = new Set<string>();
	for (const m of html.matchAll(/\s(?:class|id)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) for (const t of (m[1] ?? m[2] ?? "").split(/\s+/)) if (t) tokens.add(t);
	const tags = new Set<string>();
	for (const m of html.matchAll(/<([a-z][a-z0-9]*-[a-z0-9-]+)[\s>/]/gi)) tags.add((m[1] as string).toLowerCase());
	const generators: string[] = [];
	const metaNames = new Set<string>();
	for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
		const tag = m[0];
		const name = tag.match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1];
		if (!name) continue;
		if (name.toLowerCase() === "generator") {
			const c = tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1];
			if (c) generators.push(c);
		} else metaNames.add(name.toLowerCase());
	}
	// A password field outside WordPress's protected-post form, WooCommerce's account forms and the search form.
	const passwordForm = page.forms.some((f) => f.fields.some((x) => x.type === "password") && f.provider !== "woocommerce" && f.provider !== "wp-search" && !/action=postpass/.test(f.action ?? ""));
	const paths = [pathOf(page.url), ...page.links.filter((l) => l.internal).map((l) => pathOf(l.href))].filter(Boolean);

	for (const e of APP_FEATURES) {
		for (const p of e.plugins) if (assets.has(p)) add({ feature: e.id, kind: "asset", value: `/wp-content/plugins/${p}/`, strong: true });
		for (const re of e.bodyClasses ?? []) for (const c of page.bodyClasses) if (re.test(c)) add({ feature: e.id, kind: "body-class", value: c, strong: true });
		for (const re of e.tokens ?? []) for (const t of tokens) if (re.test(t)) add({ feature: e.id, kind: "markup", value: t, strong: true });
		for (const re of e.tags ?? []) for (const t of tags) if (re.test(t)) add({ feature: e.id, kind: "tag", value: `<${t}>`, strong: true });
		for (const re of e.generators ?? []) for (const g of generators) if (re.test(g)) add({ feature: e.id, kind: "generator", value: g, strong: true });
		for (const re of e.metas ?? []) for (const n of metaNames) if (re.test(n)) add({ feature: e.id, kind: "meta", value: n, strong: true });
		if (e.passwordForm && passwordForm) add({ feature: e.id, kind: "password-form", value: "password field", strong: true });
		for (const re of e.paths ?? []) for (const p of paths) if (re.test(p)) add({ feature: e.id, kind: "address", value: p, strong: false });
	}
	// Keep the address list short: a menu repeats the same links on every page.
	const capped: AppSignal[] = [];
	const perFeature = new Map<string, number>();
	for (const s of out) {
		if (s.kind === "address") {
			const n = perFeature.get(s.feature) ?? 0;
			if (n >= 5) continue;
			perFeature.set(s.feature, n + 1);
		}
		capped.push(s);
	}
	return { page: pathOf(page.url) || page.url, signals: capped };
}

export interface AppDetection {
	id: string;
	name: string;
	category: AppCategory;
	handling: AppHandling;
	path: string;
	effort: string;
	/** Human-readable evidence, strongest first ("plugin assets /wp-content/plugins/sfwd-lms/", "REST namespace ldlms/v2" …). */
	evidence: string[];
	/** Pages where it was seen (paths, at most 10). */
	pages: string[];
	/** WooCommerce: cart or checkout pages are active on the site. */
	cartActive?: boolean;
}

const KIND_LABEL: Record<AppSignal["kind"], string> = {
	asset: "plugin assets",
	"body-class": "body class",
	markup: "markup class/id",
	tag: "element",
	generator: "generator tag",
	meta: "meta tag",
	"password-form": "form with a",
	address: "address",
};

const restMatches = (ns: string, prefix: string) => ns === prefix || ns.startsWith(`${prefix}/`);

export interface DetectInput {
	pages: PageAppSignals[];
	/** The fingerprint's plugins (asset folders from all pages, REST prefixes). */
	plugins?: Pick<PluginInfo, "slug" | "evidence">[];
	restNamespaces?: string[];
}

/**
 * Detections from the page signals, the fingerprint's plugin list and the REST namespaces. A feature is detected
 * only with a strong signal (asset folder, body class, markup token, generator/meta tag, REST namespace, password
 * field); addresses are added as evidence once it is. The generic front-end login is left out when another app
 * that is not migrated already explains the login (a membership or course plugin). Pure.
 */
export function detectAppFeatures(input: DetectInput): AppDetection[] {
	const ev = new Map<string, { strong: Set<string>; weak: Set<string>; pages: Set<string>; cart: boolean }>();
	const slot = (id: string) => {
		let s = ev.get(id);
		if (!s) ev.set(id, (s = { strong: new Set(), weak: new Set(), pages: new Set(), cart: false }));
		return s;
	};
	for (const p of input.pages) {
		for (const sig of p.signals) {
			const s = slot(sig.feature);
			const text = `${KIND_LABEL[sig.kind]} ${sig.value}`;
			(sig.strong ? s.strong : s.weak).add(text);
			if (sig.strong) s.pages.add(p.page);
			if (sig.feature === "woocommerce" && ((sig.kind === "body-class" && /cart|checkout/.test(sig.value)) || (sig.kind === "markup" && /cart-form|checkout/.test(sig.value)))) s.cart = true;
		}
	}
	for (const pl of input.plugins ?? []) {
		const e = APP_PLUGIN_SLUGS.get(pl.slug);
		if (e && pl.evidence.includes("assets")) slot(e.id).strong.add(`plugin assets /wp-content/plugins/${pl.slug}/`);
	}
	for (const ns of input.restNamespaces ?? []) {
		for (const e of APP_FEATURES) if (e.rest?.some((r) => restMatches(ns, r))) slot(e.id).strong.add(`REST namespace ${ns}`);
	}
	const out: AppDetection[] = [];
	for (const e of APP_FEATURES) {
		const s = ev.get(e.id);
		if (!s?.strong.size) continue;
		out.push({
			id: e.id,
			name: e.name,
			category: e.category,
			handling: e.handling,
			path: e.path,
			effort: e.effort,
			evidence: [...s.strong].slice(0, 6).concat([...s.weak].slice(0, 3)),
			pages: [...s.pages].sort().slice(0, 10),
			...(e.id === "woocommerce" ? { cartActive: s.cart || [...s.weak].some((w) => /\/(cart|basket|checkout)\//.test(w)) } : {}),
		});
	}
	const explained = out.some((d) => d.id !== "front-end-login" && d.handling !== "catalogue-mode" && ["lms", "membership", "community", "accounts"].includes(d.category));
	return explained ? out.filter((d) => d.id !== "front-end-login") : out;
}

/**
 * The detections that stop the audit gate. Every out-of-scope and external-embed feature does, until the owner
 * decides and records it with `wp2emdash accept <slug> audit --reason "…"` (never automatic). WooCommerce itself
 * does not once the owner has chosen catalogue mode (kit.config shop); its own `shop` gate checks what it holds.
 */
export function blockingAppFeatures(detections: AppDetection[], o: { shopDecided: boolean }): AppDetection[] {
	return detections.filter((d) => d.handling !== "catalogue-mode" || !o.shopDecided);
}

const HANDLING_LABEL: Record<AppHandling, string> = {
	"out-of-scope": "out of scope",
	"external-embed": "out of scope — embed a hosted service instead",
	"catalogue-mode": "catalogue mode by owner decision",
};
export const handlingLabel = (h: AppHandling) => HANDLING_LABEL[h];

/** The audit gate's detail line. */
export function appGateDetail(blocking: AppDetection[], slug: string): string | undefined {
	if (!blocking.length) return undefined;
	const list = blocking.map((d) => `${d.name} (${categoryLabel(d.category)}; ${handlingLabel(d.handling)}: ${d.evidence[0] ?? "detected"})`).join("; ");
	return `${list}. The kit does not migrate these; see reports/audit/app-features.md for the evidence and the suggested path. Once the owner has decided where each one goes, record it: wp2emdash accept ${slug} audit --reason "<the owner's decision>" --by "<owner>".`;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** reports/audit/app-features.md */
export function appFeaturesReport(detections: AppDetection[], o: { title: string; shopDecided: boolean; slug: string }): string {
	const L = [o.title, "", "WordPress plugins that run an application (courses, memberships, cart and checkout, bookings, ticketed events, forums, visitor accounts). The kit migrates the website around them, not the application (docs/PLAN.md §9). Detected from the public pages only: plugin asset folders, body classes, markup class/id tokens, generator tags and REST namespaces; page text is never matched.", ""];
	if (!detections.length) {
		L.push("None detected.");
		return `${L.join("\n")}\n`;
	}
	const blocking = new Set(blockingAppFeatures(detections, { shopDecided: o.shopDecided }).map((d) => d.id));
	L.push("| Feature | Kind | What the kit does | Gate | Evidence |", "|---|---|---|---|---|");
	for (const d of detections) L.push(`| ${esc(d.name)} | ${categoryLabel(d.category)} | ${handlingLabel(d.handling)} | ${blocking.has(d.id) ? "stops the audit" : "passes (shop decided)"} | ${esc(d.evidence.join("; "))} |`);
	L.push("");
	for (const d of detections) {
		L.push(`## ${d.name}`, "", `- **Kind:** ${categoryLabel(d.category)}${d.cartActive ? " (cart / checkout pages active)" : ""}`, `- **What the kit does:** ${handlingLabel(d.handling)}`, `- **Suggested path:** ${d.path}`, `- **Effort:** ${d.effort}`, `- **Seen on:** ${d.pages.length ? d.pages.join(", ") : "site-wide (plugin list / REST)"}`, `- **Evidence:** ${d.evidence.join("; ")}`, "");
	}
	if (blocking.size) L.push(`The audit gate stays failed until the owner decides. Record the owner's decision with \`wp2emdash accept ${o.slug} audit --reason "…" --by "…"\`; the kit never accepts it on its own.`, "");
	return `${L.join("\n")}\n`;
}
