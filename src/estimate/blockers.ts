/**
 * Detections → what they mean for a migration with this kit: the adapter each page goes through (and whether that
 * adapter has run on a real site yet), blockers (out of scope, PLAN §9), owner decisions (gates that stop until the
 * owner chooses: shop catalogue mode §8b, sensitive forms, URL modes §8c) and complexity. Pure: no network.
 *
 * Adapter status is the kit's own record (docs/PLAN.md §6–§7h and §13 status, docs/spikes/*-findings.md). Update
 * ADAPTERS when an adapter runs on its first real site.
 */
import { type AppCategory, type AppDetection, categoryLabel, detectAppFeatures } from "../audit/app-features.js";
import { kitConfigSchema } from "../config/schema.js";
import type { AdapterId } from "./rules.js";
import type { AdapterUse, Detections, Finding } from "./types.js";

export const ADAPTERS: Record<AdapterId, { label: string; proven: boolean; status: string; ref: string }> = {
	wpbakery: { label: "WPBakery (incl. Salient)", proven: true, status: "Proven: the pilot WPBakery/Salient site went through every phase and verify", ref: "docs/PLAN.md §6, §13 (M4–M8)" },
	gutenberg: { label: "Gutenberg / classic editor", proven: true, status: "Proven for core blocks and classic content on real sites; block libraries (Kadence, Spectra, GenerateBlocks, Stackable, CoBlocks) fixture-only", ref: "docs/PLAN.md §7, docs/spikes/gutenberg-libraries-findings.md" },
	bricks: { label: "Bricks", proven: true, status: "Proven on one real Bricks site (three visual parity rounds)", ref: "docs/PLAN.md §7b, docs/spikes/bricks-findings.md" },
	elementor: { label: "Elementor (incl. Pro)", proven: false, status: "Built from Elementor's documented format; synthetic fixtures only, no real Elementor site yet (Pro widget keys unverified)", ref: "docs/spikes/elementor-findings.md" },
	divi: { label: "Divi", proven: false, status: "Divi 4 built from the documented shortcodes, Divi 5 best effort; synthetic fixtures only", ref: "docs/PLAN.md §7g, docs/spikes/divi-findings.md" },
	"dom-fallback": { label: "Rendered-HTML fallback (any other builder or theme)", proven: false, status: "Synthetic fixtures only; every page needs the owner's visual review (gate dom-fallback-reviewed)", ref: "docs/PLAN.md §7h, docs/spikes/dom-fallback-findings.md" },
};

/** Builder marker (detectBuilders) → adapter. Salient rides on WPBakery. */
const MARKER: Record<string, AdapterId> = { wpbakery: "wpbakery", salient: "wpbakery", gutenberg: "gutenberg", bricks: "bricks", elementor: "elementor", divi: "divi" };
const GUTENBERG_LIBS = /^(kadence-blocks|ultimate-addons-for-gutenberg|generateblocks|stackable-ultimate-gutenberg-blocks|coblocks)$/;
const FALLBACK_BUILDERS = /^(bb-plugin|beaver-builder-lite-version|oxygen|breakdance|brizy|thrive-visual-editor|siteorigin-panels|fusion-builder)$/;

/**
 * Which adapters the site's pages go through, by share of the sampled pages. A page with a builder marker goes to
 * that builder (Gutenberg markers next to another builder are the theme's, not the content's); a page without one
 * goes to Gutenberg/classic unless a builder without an adapter is installed (→ DOM fallback).
 */
export function adaptersFor(d: Detections): AdapterUse[] {
	const pages = d.sample.filter((p) => p.status === 200);
	const fallbackPlugin = d.plugins.some((p) => FALLBACK_BUILDERS.test(p.slug));
	const counts = new Map<AdapterId, number>();
	for (const p of pages) {
		const own = [...new Set(p.builders.map((b) => MARKER[b]).filter((a): a is AdapterId => !!a))];
		const main = own.find((a) => a !== "gutenberg") ?? (own.includes("gutenberg") ? "gutenberg" : fallbackPlugin ? "dom-fallback" : "gutenberg");
		counts.set(main, (counts.get(main) ?? 0) + 1);
	}
	if (!pages.length) counts.set(fallbackPlugin ? "dom-fallback" : "gutenberg", 1);
	const total = [...counts.values()].reduce((a, b) => a + b, 0);
	return [...counts.entries()]
		.sort((a, b) => b[1] - a[1])
		.map(([adapter, n]) => ({ adapter, ...ADAPTERS[adapter], share: Math.round((n / total) * 100) / 100 }));
}

/** Catalogue mode's default product limit (kit.config shop.maxProducts). */
const SHOP_MAX_PRODUCTS = kitConfigSchema.shape.shop.unwrap().shape.maxProducts.parse(undefined);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const APP_IMPACT: Record<AppCategory, string> = {
	lms: "Courses, lessons, enrolments and progress tracking are application logic, not website content.",
	membership: "Members-only pages need logins, payments and access rules, which sites built by the kit do not have.",
	commerce: "A cart, checkout and customer accounts are a store, not website content.",
	booking: "Appointments, staff schedules and payments run inside the plugin on WordPress, which the new site replaces.",
	events: "Ticket sales, orders and attendee lists run inside the plugin on WordPress, which the new site replaces.",
	community: "Member profiles, forums and activity need visitor accounts, which sites built by the kit do not have.",
	accounts: "Visitor sign-up, profiles and login are not part of a migrated site (only editors sign in, with passkeys).",
};

/** The estimate's app features: detected from the sampled pages, else from the plugin list and REST namespaces. */
export function appFeaturesOf(d: Detections): AppDetection[] {
	return d.appFeatures ?? detectAppFeatures({ pages: [], plugins: d.plugins, restNamespaces: d.restNamespaces });
}

/** All findings, most serious first. */
export function findingsFor(d: Detections, adapters: AdapterUse[]): Finding[] {
	const out: Finding[] = [];
	const has = (re: RegExp) => d.plugins.filter((p) => re.test(p.slug));

	if (!d.isWordPress) {
		out.push({ id: "not-wordpress", level: "blocker", title: "This does not look like a WordPress site", what: "No WordPress markers (wp-content paths, generator tag, REST API) were found on the public pages.", impact: "The kit migrates WordPress sites; a different platform needs a separate assessment.", handling: "Not estimated. Confirm the platform with the owner.", excluded: true });
	}
	if (d.homeStatus !== 200) {
		out.push({ id: "home-unreachable", level: "blocker", title: "The home page did not load", what: `The home page answered ${d.homeStatus === 0 ? "with a network error" : `HTTP ${d.homeStatus}`}.`, impact: "The estimate below is based on very little and may be far off.", handling: "Check the address (or a firewall blocking automated requests) and run the estimate again." });
	}

	// --- App features (PLAN §9; one catalogue with the audit, src/audit/app-features.ts): a blocker each, not estimated.
	const apps = appFeaturesOf(d);
	const woo = d.plugins.some((p) => p.slug === "woocommerce" || p.slug === "wc") || apps.some((a) => a.id === "woocommerce");
	const subsShop = woo && (!!d.shop?.plugins.subscriptions || d.plugins.some((p) => /subscriptions/.test(p.slug)) || Object.keys(d.shop?.types ?? {}).some((t) => /subscription/.test(t)));
	for (const a of apps) {
		if (a.handling === "catalogue-mode") continue; // WooCommerce: the shop findings below
		if (a.id === "woocommerce-subscriptions" && subsShop) continue; // "Shop with subscriptions" below says it
		out.push({ id: `app-${a.id}`, level: "blocker", title: `${a.name} (${categoryLabel(a.category)})`, what: `${a.name} found on the site: ${a.evidence.slice(0, 2).join("; ")}.`, impact: APP_IMPACT[a.category], handling: `${a.handling === "external-embed" ? "Out of scope as a WordPress plugin (PLAN §9); a hosted service's widget or link takes its place." : "Out of scope for the kit (PLAN §9)."} ${a.path}`, ref: "docs/PLAN.md §9, src/audit/app-features.ts", excluded: true });
	}
	const accountApps = apps.filter((a) => ["membership", "community", "accounts", "lms"].includes(a.category) && a.id !== "front-end-login");
	if (!accountApps.length && (d.accounts.loginForms > 0 || d.accounts.accountLinks.length > 0)) {
		const what = [d.accounts.loginForms ? `${plural(d.accounts.loginForms, "page")} with a password field` : "", d.accounts.accountLinks.length ? `links to ${d.accounts.accountLinks.slice(0, 3).join(", ")}` : ""].filter(Boolean).join("; ");
		const shopOnly = !d.accounts.loginForms && !!d.shop && d.accounts.accountLinks.every((l) => /my-account|cart|checkout/.test(l));
		// A generic login form is already a blocker above (app-front-end-login); links alone are a question for the owner.
		if (!shopOnly && !apps.some((a) => a.id === "front-end-login")) out.push({ id: "user-accounts", level: "decision", title: "Visitor accounts or front-end login", what: `${what}.`, impact: "Visitor sign-up, profiles and login are not part of a migrated site (only editors sign in, with passkeys).", handling: "Confirm with the owner what the login is for; if it is only the WordPress admin link, nothing to do.", ref: "docs/PLAN.md §9" });
	}
	if (d.multisite) out.push({ id: "multisite", level: "blocker", title: "WordPress multisite", what: "Media addresses use /wp-content/uploads/sites/<n>/, the multisite layout.", impact: "A network of sites shares users, plugins and settings; each sub-site is its own migration.", handling: "Out of scope as a network (PLAN §9); each sub-site can be estimated and migrated on its own.", ref: "docs/PLAN.md §9", excluded: true });

	// --- Shop (PLAN §8b)
	if (woo) {
		const s = d.shop;
		const subs = s?.plugins.subscriptions || d.plugins.some((p) => /subscriptions/.test(p.slug)) || Object.keys(s?.types ?? {}).some((t) => /subscription/.test(t));
		const tooMany = (s?.products ?? 0) > SHOP_MAX_PRODUCTS;
		if (subs || tooMany) {
			out.push({ id: "shop-out-of-scope", level: "blocker", title: subs ? "Shop with subscriptions" : "Large shop", what: `WooCommerce${s ? ` with ${plural(s.products, "product")}` : ""}${subs ? ", recurring subscriptions" : ""}.`, impact: subs ? "Recurring billing needs a real store; catalogue mode cannot carry it." : `More products than catalogue mode is built for (${SHOP_MAX_PRODUCTS} by default).`, handling: "Out of scope (PLAN §8b/§9): keep the store on WooCommerce or move it to a hosted store; the rest of the site can migrate.", ref: "docs/PLAN.md §8b", excluded: true });
		} else {
			out.push({ id: "shop", level: "decision", title: "Online shop (WooCommerce)", what: `WooCommerce${s && s.source !== "none" ? ` with ${plural(s.products, "product")}${s.variations ? ` (${plural(s.variations, "variation")})` : ""}${s.currency ? ` in ${s.currency}` : ""}` : " (product list not public)"}.`, impact: "There is no cart or checkout on the new site. Products become pages with a Buy button that goes to an external checkout (Stripe Payment Links, a hosted store) or to the contact form.", handling: "Catalogue mode, once the owner chooses it (kit.config shop); orders, customers and coupons are not migrated and are listed in the report.", ref: "docs/PLAN.md §8b, docs/spikes/shop-findings.md" });
		}
	}

	// --- Multilingual (PLAN §8c)
	if (d.multilingual.plugin || d.multilingual.languages.length > 1) {
		const langs = d.multilingual.languages;
		const shown = langs.length > 12 ? `${langs.slice(0, 12).join(", ")} and ${langs.length - 12} more` : langs.join(", ");
		out.push({ id: "multilingual", level: "complexity", title: "Several languages", what: `${d.multilingual.plugin ?? "Language alternates (hreflang)"}${langs.length ? `: ${shown}` : ""}.`, impact: "Every language keeps its addresses; menus, the language switcher and hreflang are rebuilt. Subdomain, separate-domain or ?lang= addresses need an owner decision first.", handling: "Supported (PLAN §8c), built but not yet run on a real multilingual site; string translations are not carried and are listed.", ref: "docs/PLAN.md §8c, docs/spikes/multilingual-findings.md" });
	}
	if (d.multilingual.otherHosts > 0) {
		out.push({ id: "language-hosts", level: "decision", title: "Languages on other addresses", what: `${plural(d.multilingual.otherHosts, "language")} served from other domains or subdomains (hreflang).`, impact: "Each of those addresses is a site of its own; the kit's multilingual support covers languages in folders of one site.", handling: "Not included here: each language site is estimated and migrated on its own, or the owner decides to merge them into folders (PLAN §8c URL modes).", ref: "docs/PLAN.md §8c", excluded: true });
	}

	// --- Sensitive forms
	const sensitive = d.integrations.filter((i) => i.form && i.form.sensitiveFields.length);
	if (sensitive.length) out.push({ id: "sensitive-forms", level: "decision", title: "Forms that may collect sensitive data", what: `${plural(sensitive.length, "form")} with fields such as ${[...new Set(sensitive.flatMap((i) => i.form?.sensitiveFields ?? []))].slice(0, 4).join(", ")}.`, impact: "Health, legal or financial details must not pass through the website's own email or storage.", handling: "The kit's sensitive-data mode keeps such forms with a compliant provider (or removes those fields); the owner decides per form.", ref: "CLAUDE.md (sensitiveData), src/audit/integrations.ts" });

	// --- Payments embedded outside a shop
	const pay = d.integrations.filter((i) => i.kind === "payment");
	if (pay.length && !woo) out.push({ id: "payments", level: "decision", title: "Payments on the site", what: `${pay.map((i) => i.name).join(", ")} scripts on ${plural(Math.max(...pay.map((i) => i.pageCount)), "page")}.`, impact: "Payment buttons or forms need the provider's hosted checkout on the new site.", handling: "Replaced by the provider's hosted checkout or payment links; decided with the owner.", ref: "src/audit/integrations.ts" });

	// --- Adapters
	for (const a of adapters) {
		if (!a.proven) out.push({ id: `adapter-${a.adapter}`, level: "complexity", title: `${a.label}: first real site for this adapter`, what: `About ${Math.round(a.share * 100)} % of the sampled pages are built with ${a.label}.`, impact: "The converter exists but has only run on test fixtures, so the first real site takes extra checking and visual polish.", handling: `${a.status}. Extra time is included for it.`, ref: a.ref });
	}
	const libs = has(GUTENBERG_LIBS);
	if (libs.length) out.push({ id: "gutenberg-libraries", level: "complexity", title: "Gutenberg block libraries", what: `${libs.map((p) => p.name).join(", ")}.`, impact: "Their blocks are converted by dedicated handlers that have only run on test fixtures.", handling: "Handled by the Gutenberg adapter's library handlers; checked visually.", ref: "docs/spikes/gutenberg-libraries-findings.md" });

	// --- Plugins the kit does not know (possible custom logic)
	const unknown = d.plugins.filter((p) => p.action === "review" && p.replacement.startsWith("Unknown"));
	if (unknown.length) out.push({ id: "unknown-plugins", level: "complexity", title: "Plugins to review", what: `${plural(unknown.length, "plugin")} the kit does not recognise: ${unknown.slice(0, 8).map((p) => p.slug).join(", ")}${unknown.length > 8 ? ", …" : ""}.`, impact: "Most add a widget or styling; a custom plugin with business logic (calculators, portals, integrations) is out of scope.", handling: "Each is reviewed in the audit; custom business logic is scoped separately (PLAN §9).", ref: "docs/PLAN.md §9" });

	// --- Info
	if (d.hiddenWpPaths) out.push({ id: "hidden-wp", level: "info", title: "WordPress paths are disguised", what: "A security plugin rewrites the usual /wp-content/ addresses.", impact: "Detection here is less complete; the full audit reads the site with the owner's access.", handling: "The audit detects the rewritten uploads path; media still migrate." });
	if (!d.restAvailable && d.isWordPress) out.push({ id: "rest-closed", level: "info", title: "Public content API is closed", what: "The WordPress REST API did not answer publicly.", impact: "Page and post counts here are estimated from the sitemap and links.", handling: "Content is exported with the EmDash Exporter plugin and an application password during the migration; nothing changes for the owner." });
	const booking = d.integrations.filter((i) => i.kind === "booking");
	if (booking.length) out.push({ id: "booking", level: "info", title: "Booking system", what: `${booking.map((i) => i.name).join(", ")}.`, impact: "Appointments stay in the booking provider.", handling: "The booking widget or links are kept as they are." });
	if (d.discoveredCapped) out.push({ id: "large-site", level: "info", title: "Large site", what: `More than ${d.discovered} addresses were found; only the first ones were looked at.`, impact: "Counts come from the content API where it answers; the sample may miss rarer page types.", handling: "The full audit crawls every address." });

	const order = { blocker: 0, decision: 1, complexity: 2, info: 3 } as const;
	return out.sort((a, b) => order[a.level] - order[b.level]);
}
