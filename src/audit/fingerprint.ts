import type { PageSnapshot } from "./page.js";

export type PluginAction = "adapter" | "migrate-data" | "rebuild" | "replace" | "drop" | "out-of-scope" | "review";

export interface PluginInfo {
	slug: string;
	name: string;
	evidence: ("assets" | "rest" | "html")[];
	action: PluginAction;
	replacement: string;
}

export interface Fingerprint {
	themes: string[];
	parentTheme?: string;
	childTheme?: string;
	generator?: string;
	wordpressVersion?: string;
	builders: Record<string, number>;
	plugins: PluginInfo[];
	emdashExporter: boolean;
	/** Uploads base as served on public pages (e.g. a rewritten "/storage"). */
	uploadsBase?: string;
	/** Uploads base WordPress itself reports (REST media source_url), usually "/wp-content/uploads". */
	restUploadsBase?: string;
	/** True when wp-content/wp-includes paths are rewritten by a "hide WordPress" plugin. */
	hiddenWpPaths: boolean;
	rewrittenPaths: string[];
}

/** Known plugins → what happens to them. Keys: plugin folder slug or REST namespace prefix. */
const KNOWN: Record<string, { name: string; action: PluginAction; replacement: string }> = {
	js_composer: { name: "WPBakery Page Builder", action: "adapter", replacement: "WPBakery adapter → section blocks" },
	"js_composer_salient": { name: "WPBakery (Salient bundled)", action: "adapter", replacement: "WPBakery adapter → section blocks" },
	"salient-core": { name: "Salient Core", action: "adapter", replacement: "nectar_* element handlers + Salient design capture" },
	"salient-shortcodes": { name: "Salient Shortcodes", action: "adapter", replacement: "nectar_* element handlers" },
	"salient-portfolio": { name: "Salient Portfolio", action: "migrate-data", replacement: "portfolio collection" },
	"salient-nectar-slider": { name: "Nectar Slider", action: "adapter", replacement: "hero / gallery section" },
	"salient-social": { name: "Salient Social", action: "drop", replacement: "share links in template if needed" },
	"salient-widgets": { name: "Salient Widgets", action: "rebuild", replacement: "widget areas" },
	"salient-demo-importer": { name: "Salient Demo Importer", action: "drop", replacement: "—" },
	elementor: { name: "Elementor", action: "adapter", replacement: "Elementor adapter (src/adapters/elementor)" },
	"elementor-pro": { name: "Elementor Pro", action: "adapter", replacement: "Elementor adapter: Theme Builder parts, popups, forms, Pro widgets" },
	bricks: { name: "Bricks", action: "adapter", replacement: "Bricks adapter (src/adapters/bricks)" },
	divi: { name: "Divi", action: "adapter", replacement: "Divi adapter (src/adapters/divi): Divi 4 modules, Theme Builder header/footer, contact forms; Divi 5 best effort" },
	"seo-by-rank-math": { name: "Rank Math SEO", action: "migrate-data", replacement: "EmDash SEO fields (via exporter) + generated sitemap/JSON-LD" },
	rankmath: { name: "Rank Math SEO", action: "migrate-data", replacement: "EmDash SEO fields (via exporter) + generated sitemap/JSON-LD" },
	"wordpress-seo": { name: "Yoast SEO", action: "migrate-data", replacement: "EmDash SEO fields (via exporter)" },
	yoast: { name: "Yoast SEO", action: "migrate-data", replacement: "EmDash SEO fields (via exporter)" },
	fluentform: { name: "Fluent Forms", action: "rebuild", replacement: "form section → Worker → email provider (+Turnstile)" },
	"fluentform-pro": { name: "Fluent Forms Pro", action: "rebuild", replacement: "form section → Worker → email provider" },
	"fluent-smtp": { name: "FluentSMTP", action: "replace", replacement: "Email provider API (Brevo default) from the Worker" },
	"contact-form-7": { name: "Contact Form 7", action: "rebuild", replacement: "form section → Worker → email provider" },
	contact: { name: "Contact Form 7", action: "rebuild", replacement: "form section → Worker → email provider" },
	wpforms: { name: "WPForms", action: "rebuild", replacement: "form section → Worker → email provider" },
	"wpforms-lite": { name: "WPForms Lite", action: "rebuild", replacement: "form section → Worker → email provider" },
	gravityforms: { name: "Gravity Forms", action: "rebuild", replacement: "form section → Worker → email provider" },
	gf: { name: "Gravity Forms", action: "rebuild", replacement: "form section → Worker → email provider" },
	"wp-mail-smtp": { name: "WP Mail SMTP", action: "replace", replacement: "Email provider API from the Worker" },
	"popup-maker": { name: "Popup Maker", action: "review", replacement: "dialog section for popups still needed; drop the rest" },
	megamenu: { name: "Max Mega Menu", action: "rebuild", replacement: "header menu: mega panels as columns of links (partial: panel widgets/images not carried)" },
	"megamenu-pro": { name: "Max Mega Menu Pro", action: "rebuild", replacement: "header menu: mega panels as columns of links (partial)" },
	"coming-soon": { name: "SeedProd Coming Soon & Maintenance", action: "replace", replacement: "coming-soon mode in Site health → Settings (off after the move; switch on if needed)" },
	"wp-maintenance-mode": { name: "LightStart (WP Maintenance Mode)", action: "replace", replacement: "coming-soon mode in Site health → Settings (off after the move)" },
	maintenance: { name: "Maintenance", action: "replace", replacement: "coming-soon mode in Site health → Settings (off after the move)" },
	"under-construction-page": { name: "UnderConstructionPage", action: "replace", replacement: "coming-soon mode in Site health → Settings (off after the move)" },
	"cmp-coming-soon-maintenance": { name: "CMP Coming Soon & Maintenance", action: "replace", replacement: "coming-soon mode in Site health → Settings (off after the move)" },
	pum: { name: "Popup Maker", action: "review", replacement: "dialog section for popups still needed" },
	"google-site-kit": { name: "Google Site Kit", action: "replace", replacement: "GA4/GTM tags configured in site settings" },
	wordfence: { name: "Wordfence", action: "drop", replacement: "Cloudflare WAF + EmDash auth (passkeys)" },
	"wordfence-login-security": { name: "Wordfence Login Security", action: "drop", replacement: "EmDash passkeys" },
	filebird: { name: "FileBird", action: "drop", replacement: "EmDash media library; folders recreated from a database dump (import-dump)" },
	"webp-converter-for-media": { name: "Converter for Media (WebP)", action: "drop", replacement: "Astro/Cloudflare image transforms" },
	"webp-converter": { name: "Converter for Media (WebP)", action: "drop", replacement: "Astro/Cloudflare image transforms" },
	spc: { name: "Super Page Cache", action: "drop", replacement: "EmDash route caching on Workers" },
	"wp-cloudflare-page-cache": { name: "Super Page Cache", action: "drop", replacement: "EmDash route caching on Workers" },
	"wp-rocket": { name: "WP Rocket", action: "drop", replacement: "EmDash route caching on Workers" },
	"litespeed-cache": { name: "LiteSpeed Cache", action: "drop", replacement: "EmDash route caching on Workers" },
	"w3-total-cache": { name: "W3 Total Cache", action: "drop", replacement: "EmDash route caching on Workers" },
	autoptimize: { name: "Autoptimize", action: "drop", replacement: "Astro build" },
	"wp-abilities": { name: "WordPress Abilities API", action: "drop", replacement: "—" },
	akismet: { name: "Akismet", action: "replace", replacement: "Turnstile on forms" },
	redirection: { name: "Redirection", action: "migrate-data", replacement: "EmDash redirects" },
	"advanced-custom-fields": { name: "ACF", action: "migrate-data", replacement: "EmDash fields (via exporter)" },
	"advanced-custom-fields-pro": { name: "ACF Pro", action: "migrate-data", replacement: "EmDash fields (via exporter)" },
	acf: { name: "ACF", action: "migrate-data", replacement: "EmDash fields (via exporter)" },
	woocommerce: { name: "WooCommerce", action: "out-of-scope", replacement: "catalogue mode by owner decision (kit.config shop: products as pages, external checkout; docs/PLAN.md §8b), else out of scope" },
	wc: { name: "WooCommerce", action: "out-of-scope", replacement: "catalogue mode by owner decision (kit.config shop), else out of scope" },
	"woocommerce-subscriptions": { name: "WooCommerce Subscriptions", action: "out-of-scope", replacement: "Out of scope (recurring billing needs a store; catalogue mode cannot carry it)" },
	"woocommerce-subscriptions-core": { name: "WooCommerce Subscriptions", action: "out-of-scope", replacement: "Out of scope (recurring billing needs a store)" },
	"woocommerce-memberships": { name: "WooCommerce Memberships", action: "out-of-scope", replacement: "Out of scope (members-only content and accounts)" },
	"woocommerce-bookings": { name: "WooCommerce Bookings", action: "review", replacement: "catalogue mode: products shown, bookings not rebuilt (link the Buy button to the booking system)" },
	"woocommerce-gateway-stripe": { name: "WooCommerce Stripe Gateway", action: "drop", replacement: "catalogue mode: Stripe Payment Links per product (shop.checkout)" },
	"woocommerce-payments": { name: "WooPayments", action: "drop", replacement: "catalogue mode: the external checkout takes payments" },
	"woocommerce-paypal-payments": { name: "WooCommerce PayPal Payments", action: "drop", replacement: "catalogue mode: the external checkout takes payments" },
	"sitepress-multilingual-cms": { name: "WPML", action: "migrate-data", replacement: "languages: every entry keeps its address, lang + translation group, hreflang and a language switcher (directory URLs; other URL modes need a decision)" },
	polylang: { name: "Polylang", action: "migrate-data", replacement: "languages: every entry keeps its address, lang + translation group, hreflang and a language switcher (directory URLs; other URL modes need a decision)" },
	"revslider": { name: "Slider Revolution", action: "review", replacement: "hero / gallery section" },
	"instagram-feed": { name: "Smash Balloon Instagram Feed", action: "review", replacement: "decide: embed, static gallery or drop" },
	"cookie-notice": { name: "Cookie Notice", action: "rebuild", replacement: "consent banner component" },
	"complianz-gdpr": { name: "Complianz", action: "rebuild", replacement: "consent banner component" },
	"cookie-law-info": { name: "CookieYes", action: "rebuild", replacement: "consent banner component / CookieYes script" },
	emdash: { name: "EmDash Exporter", action: "migrate-data", replacement: "used by extract phase" },
	jetpack: { name: "Jetpack", action: "replace", replacement: "stats → the kit's analytics settings; CDN/security → Cloudflare; forms → form sections" },
	"jetpack-boost": { name: "Jetpack Boost", action: "drop", replacement: "EmDash route caching + Astro build" },
	gutenberg: { name: "Gutenberg (plugin)", action: "drop", replacement: "Gutenberg adapter reads the saved blocks" },
	"classic-editor": { name: "Classic Editor", action: "drop", replacement: "classic content → Portable Text" },
	"two-factor": { name: "Two Factor", action: "drop", replacement: "EmDash passkeys" },
	"really-simple-ssl": { name: "Really Simple SSL", action: "drop", replacement: "Cloudflare TLS" },
	"wp-super-cache": { name: "WP Super Cache", action: "drop", replacement: "EmDash route caching on Workers" },
	updraftplus: { name: "UpdraftPlus", action: "drop", replacement: "kit Backups & Restore (D1 + R2)" },
	"duplicate-post": { name: "Yoast Duplicate Post", action: "drop", replacement: "—" },
	// Memberships, courses, communities and front-end accounts: out of scope for v1 (docs/PLAN.md §9).
	memberpress: { name: "MemberPress", action: "out-of-scope", replacement: "Out of scope (memberships / paywalled content, PLAN §9)" },
	"paid-memberships-pro": { name: "Paid Memberships Pro", action: "out-of-scope", replacement: "Out of scope (memberships, PLAN §9)" },
	"restrict-content-pro": { name: "Restrict Content Pro", action: "out-of-scope", replacement: "Out of scope (memberships / paywall, PLAN §9)" },
	"restrict-content": { name: "Restrict Content", action: "out-of-scope", replacement: "Out of scope (memberships / paywall, PLAN §9)" },
	"ultimate-member": { name: "Ultimate Member", action: "out-of-scope", replacement: "Out of scope (user accounts / front-end login, PLAN §9)" },
	"profile-builder": { name: "Profile Builder", action: "out-of-scope", replacement: "Out of scope (user accounts / front-end login, PLAN §9)" },
	"sfwd-lms": { name: "LearnDash", action: "out-of-scope", replacement: "Out of scope (LMS, PLAN §9)" },
	learndash: { name: "LearnDash", action: "out-of-scope", replacement: "Out of scope (LMS, PLAN §9)" },
	lifterlms: { name: "LifterLMS", action: "out-of-scope", replacement: "Out of scope (LMS, PLAN §9)" },
	tutor: { name: "Tutor LMS", action: "out-of-scope", replacement: "Out of scope (LMS, PLAN §9)" },
	"sensei-lms": { name: "Sensei LMS", action: "out-of-scope", replacement: "Out of scope (LMS, PLAN §9)" },
	buddypress: { name: "BuddyPress", action: "out-of-scope", replacement: "Out of scope (community / user accounts, PLAN §9)" },
	bbpress: { name: "bbPress", action: "out-of-scope", replacement: "Out of scope (forums / user accounts, PLAN §9)" },
	// Builders without their own adapter: pages rebuilt from rendered HTML by the DOM-fallback adapter (PLAN §7h).
	"bb-plugin": { name: "Beaver Builder", action: "adapter", replacement: "DOM-fallback adapter (rendered HTML → sections; owner review gate)" },
	"beaver-builder-lite-version": { name: "Beaver Builder Lite", action: "adapter", replacement: "DOM-fallback adapter (rendered HTML → sections; owner review gate)" },
	oxygen: { name: "Oxygen", action: "adapter", replacement: "DOM-fallback adapter (rendered HTML → sections; owner review gate)" },
	breakdance: { name: "Breakdance", action: "adapter", replacement: "DOM-fallback adapter (rendered HTML → sections; owner review gate)" },
	brizy: { name: "Brizy", action: "adapter", replacement: "DOM-fallback adapter (rendered HTML → sections; owner review gate)" },
	"thrive-visual-editor": { name: "Thrive Architect", action: "adapter", replacement: "DOM-fallback adapter (rendered HTML → sections; owner review gate)" },
	"siteorigin-panels": { name: "SiteOrigin Page Builder", action: "adapter", replacement: "DOM-fallback adapter (rendered HTML → sections; owner review gate)" },
	"fusion-builder": { name: "Avada Fusion Builder", action: "adapter", replacement: "DOM-fallback adapter (rendered HTML → sections; owner review gate)" },
	// Gutenberg block libraries (handlers in src/adapters/gutenberg/libraries.ts).
	"kadence-blocks": { name: "Kadence Blocks", action: "adapter", replacement: "Gutenberg adapter: Kadence handlers" },
	"ultimate-addons-for-gutenberg": { name: "Spectra (UAG)", action: "adapter", replacement: "Gutenberg adapter: Spectra handlers" },
	generateblocks: { name: "GenerateBlocks", action: "adapter", replacement: "Gutenberg adapter: GenerateBlocks handlers" },
	"stackable-ultimate-gutenberg-blocks": { name: "Stackable", action: "adapter", replacement: "Gutenberg adapter: Stackable handlers" },
	coblocks: { name: "CoBlocks", action: "adapter", replacement: "Gutenberg adapter: CoBlocks handlers" },
};

/** REST namespaces that belong to WordPress itself. */
const CORE_NAMESPACES = /^(wp\/v2|oembed\/1\.0|wp-site-health\/v1|wp-block-editor\/v1|wp-abilities\/v1)$/;

/** Uploads base from media URLs: the path segment before /YYYY/MM/. */
export function detectUploadsBase(mediaUrls: string[]): string | undefined {
	const counts = new Map<string, number>();
	for (const u of mediaUrls) {
		try {
			const m = new URL(u).pathname.match(/^(.*?)\/\d{4}\/\d{2}\//);
			if (m?.[1] !== undefined) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
		} catch {
			/* ignore */
		}
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function fingerprint(pages: PageSnapshot[], restNamespaces: string[], htmlSamples: string[], mediaUrls: string[] = []): Fingerprint {
	const pluginAssets = new Set<string>();
	const themes = new Set<string>();
	const builders: Record<string, number> = {};
	for (const p of pages) {
		for (const b of p.builders) builders[b] = (builders[b] ?? 0) + 1;
		for (const s of [...p.scripts.map((x) => x.src ?? ""), ...p.stylesheets, ...p.images.map((i) => i.src)]) {
			for (const m of s.matchAll(/wp-content\/plugins\/([a-z0-9_.-]+)\//gi)) pluginAssets.add((m[1] as string).toLowerCase());
			for (const m of s.matchAll(/wp-content\/themes\/([a-z0-9_.-]+)\//gi)) themes.add((m[1] as string).toLowerCase());
		}
	}
	let generator: string | undefined;
	for (const html of htmlSamples) {
		for (const m of html.matchAll(/wp-content\/plugins\/([a-z0-9_.-]+)\//gi)) pluginAssets.add((m[1] as string).toLowerCase());
		for (const m of html.matchAll(/wp-content\/themes\/([a-z0-9_.-]+)\//gi)) themes.add((m[1] as string).toLowerCase());
		generator ??= html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i)?.[1];
	}

	const restPlugins = new Set(
		restNamespaces.filter((n) => !CORE_NAMESPACES.test(n)).map((n) => n.split("/")[0] as string),
	);

	const bySlug = new Map<string, PluginInfo>();
	const addPlugin = (slug: string, ev: PluginInfo["evidence"][number]) => {
		const known = KNOWN[slug];
		const key = known?.name ?? slug;
		const cur = bySlug.get(key) ?? { slug, name: known?.name ?? slug, evidence: [], action: known?.action ?? "review", replacement: known?.replacement ?? "Unknown plugin — review what it does on the site" };
		if (!cur.evidence.includes(ev)) cur.evidence.push(ev);
		bySlug.set(key, cur);
	};
	for (const s of pluginAssets) addPlugin(s, "assets");
	for (const s of restPlugins) addPlugin(s, "rest");
	if ((builders.wpbakery ?? 0) > 0 && ![...bySlug.values()].some((p) => p.name.startsWith("WPBakery"))) addPlugin("js_composer", "html");

	const themeList = [...themes];
	const child = themeList.find((t) => t.endsWith("-child"));
	const parent = child ? themeList.find((t) => t === child.replace(/-child$/, "")) : themeList[0];

	const toUrl = (href: string, base: string) => {
		try {
			return new URL(href, base);
		} catch {
			return undefined;
		}
	};
	const assetUrls = pages.flatMap((p) => [...p.scripts.map((x) => x.src ?? ""), ...p.stylesheets].filter(Boolean).map((a) => toUrl(a, p.url))).filter((u): u is URL => !!u);
	const host = pages[0] ? new URL(pages[0].url).host : "";
	const own = assetUrls.filter((u) => u.host === host);
	const standard = own.filter((u) => /\/wp-(content|includes)\//.test(u.pathname)).length;
	const rewritten = [...new Set(own.filter((u) => !/\/wp-(content|includes)\//.test(u.pathname)).map((u) => u.pathname.split("/").slice(0, 3).join("/")))].slice(0, 8);
	const uploadsBase = detectUploadsBase(pages.flatMap((p) => [...p.images.map((i) => i.src), ...p.backgroundImages]));
	const restUploadsBase = detectUploadsBase(mediaUrls);

	return {
		uploadsBase,
		restUploadsBase,
		hiddenWpPaths: standard === 0 && rewritten.length > 0,
		rewrittenPaths: standard === 0 ? rewritten : [],
		themes: themeList,
		parentTheme: parent,
		childTheme: child,
		generator,
		wordpressVersion: generator?.match(/WordPress\s+([\d.]+)/i)?.[1],
		builders,
		plugins: [...bySlug.values()].sort((a, b) => a.name.localeCompare(b.name)),
		emdashExporter: restNamespaces.some((n) => n.startsWith("emdash/")),
	};
}
