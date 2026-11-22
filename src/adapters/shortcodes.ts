/**
 * Registry of common WordPress plugin and theme shortcodes that no builder adapter handles, and what migration does
 * with each (the WPBakery shortcode adapter consults it before reporting an element as unmapped; the blog body pass
 * uses it too). Anything not listed stays an unmapped element (error when it carries content), so the transform gate
 * and the coverage report's "Shortcodes" table list every name, its count and a sample page.
 *
 * Actions:
 * - form: a form section for the provider's form id (definitions come from extract: REST or plugin exports);
 * - breadcrumbs: the SEO plugin's breadcrumb trail; dropped from the content and flagged (ir/shortcodes.json
 *   `breadcrumbs: true`), so the theme's breadcrumbs can replace it;
 * - strip: a layout or styling wrapper (columns, boxes, highlights, page-builder leftovers): the tag goes, its content
 *   stays (a `title` attribute becomes a bold line above it); reported as lossy;
 * - widget: plugin output rendered from outside the content. Share buttons, social feeds, review badges, counters,
 *   sign-up boxes and switchers are reported as warnings (site widgets, the provider registry, can bring them back);
 *   widgets that show the site's own content (tables, galleries, sliders, documents, events, bookings, maps, templates,
 *   snippets) are errors, like an unmapped element, until a section replaces them or the owner decides;
 * - media: WordPress core media shortcodes, handled by the adapters (listed so the report names them);
 * - products: WooCommerce product listings ([products], [sale_products]…), rebuilt as a product grid on catalogue-mode
 *   shops by src/adapters/woocommerce.ts (the listings it cannot rebuild, best sellers and the like, are content widgets).
 */
export type ShortcodeAction =
	| { do: "form"; provider: string }
	| { do: "breadcrumbs" }
	| { do: "strip" }
	/** `content`: it shows the site's own content (a table, gallery, slider, document, events): blocking until rebuilt or decided. */
	| { do: "widget"; what: string; content: boolean }
	| { do: "media" }
	| { do: "products" };

const FORM: Record<string, string> = {
	"contact-form-7": "contact-form-7",
	"contact-form": "contact-form-7",
	fluentform: "fluent-forms",
	wpforms: "wpforms",
	gravityform: "gravity-forms",
	gravityforms: "gravity-forms",
	ninja_form: "ninja-forms",
	ninja_forms: "ninja-forms",
	"ninja_forms_display_form": "ninja-forms",
	formidable: "formidable",
	forminator_form: "forminator",
	"ws_form": "ws-form",
	"ws-form": "ws-form",
};
const BREADCRUMBS = new Set(["rank_math_breadcrumb", "wpseo_breadcrumb", "yoast-breadcrumb", "yoast_breadcrumb", "aioseo_breadcrumbs", "seopress_breadcrumbs", "breadcrumb", "breadcrumbs", "flexy_breadcrumb", "bcn_display", "woocommerce_breadcrumb"]);
const STRIP = new Set([
	// Generic layout shortcodes left by themes and page builders
	"row", "col", "column", "columns", "column_inner", "row_inner", "one_half", "one_half_last", "one_third", "one_third_last", "two_third", "two_third_last", "two_thirds", "one_fourth", "one_fourth_last", "three_fourth", "three_fourth_last", "one_fifth", "two_fifth", "three_fifth", "four_fifth", "one_sixth", "five_sixth", "full_width", "fullwidth", "container", "wrapper", "section", "div", "span", "clear", "clearfix", "center", "left", "right",
	// Shortcodes Ultimate and similar styling packs
	"su_row", "su_column", "su_box", "su_note", "su_highlight", "su_quote", "su_pullquote", "su_dropcap", "su_spacer", "su_divider", "su_spoiler", "su_accordion", "su_list", "su_label", "su_heading", "su_expand",
	"highlight", "dropcap", "pullquote", "blockquote", "quote", "alert", "notice", "note", "box", "info_box", "callout", "panel", "lead", "big", "small", "intro", "spoiler", "accordion", "accordion_item", "expand", "toggle_content", "raw", "nolinks",
]);
const WIDGET: Record<string, string> = {
	addtoany: "share buttons (AddToAny)",
	addthis: "share buttons (AddThis)",
	ssba: "share buttons (Simple Share Buttons)",
	"ssba-buttons": "share buttons (Simple Share Buttons)",
	sharethis: "share buttons (ShareThis)",
	"sharethis-inline-buttons": "share buttons (ShareThis)",
	social_warfare: "share buttons (Social Warfare)",
	shareaholic: "share buttons (Shareaholic)",
	novashare: "share buttons (Novashare)",
	mashshare: "share buttons (MashShare)",
	sharing: "share buttons (Jetpack)",
	jetpack_share_buttons: "share buttons (Jetpack)",
	DISPLAY_ULTIMATE_SOCIAL_ICONS: "social icons (Ultimate Social Media)",
	DISPLAY_ULTIMATE_PLUS: "social icons (Ultimate Social Media)",
	"social-icons": "social icons",
	social_icons: "social icons",
	"instagram-feed": "Instagram feed (Smash Balloon)",
	instagram_feed: "Instagram feed",
	"custom-facebook-feed": "Facebook feed (Smash Balloon)",
	cff: "Facebook feed (Smash Balloon)",
	"custom-twitter-feeds": "X/Twitter feed (Smash Balloon)",
	ctf: "X/Twitter feed (Smash Balloon)",
	"youtube-feed": "YouTube feed (Smash Balloon)",
	"tiktok-feeds": "TikTok feed",
	"wp-social-ninja": "social feed/reviews (WP Social Ninja)",
	trustindex: "reviews widget (Trustindex)",
	"google-reviews": "Google reviews widget",
	grw: "Google reviews widget (Rich Plugins)",
	brb_collection: "reviews widget (Rich Plugins)",
	"elfsight-widget": "Elfsight widget",
	"wpforms_entries": "form entries listing (never migrated: private data)",
	"post-views": "view counter",
	post_views: "view counter",
	"wpp": "popular posts widget",
	"jetpack-related-posts": "related posts (Jetpack)",
	related_posts: "related posts",
	"mc4wp_form": "newsletter sign-up (Mailchimp for WP)",
	mailpoet_form: "newsletter sign-up (MailPoet)",
	"sibwp_form": "newsletter sign-up (Brevo)",
	"newsletter": "newsletter sign-up",
	"cmplz-document": "cookie/privacy policy text generated by Complianz",
	"cookie_audit": "cookie list (CookieYes)",
	"cky_audit_table": "cookie list (CookieYes)",
	"wpml_language_selector_widget": "language switcher (WPML)",
	"language-switcher": "language switcher",
	"gtranslate": "language switcher (GTranslate)",
	"weglot_switcher": "language switcher (Weglot)",
	"wp_google_maps": "map (WP Go Maps)",
	"wpgmza": "map (WP Go Maps)",
	"booking": "booking calendar",
	"calendly": "Calendly booking embed",
	"ameliabooking": "booking (Amelia)",
	"bookly-form": "booking (Bookly)",
	"wpsbc": "booking calendar",
	"tribe_events": "events calendar (The Events Calendar)",
	"events_list": "events list",
	"searchandfilter": "search filter",
	"wpdatatable": "data table (wpDataTables)",
	"table": "table (TablePress)",
	"tablepress": "table (TablePress)",
	"pdf-embedder": "PDF viewer (PDF Embedder)",
	"pdf-viewer": "PDF viewer",
	"embeddoc": "document embed",
	"gdoc": "Google document embed",
	"real3dflipbook": "flipbook",
	"dflip": "flipbook (dFlip)",
	"smartslider3": "slider (Smart Slider 3)",
	rev_slider: "slider (Slider Revolution)",
	layerslider: "slider (LayerSlider)",
	metaslider: "slider (MetaSlider)",
	"soliloquy": "slider (Soliloquy)",
	"envira-gallery": "gallery (Envira)",
	"foogallery": "gallery (FooGallery)",
	"modula": "gallery (Modula)",
	"robo-gallery": "gallery (Robo Gallery)",
	"ngg": "gallery (NextGEN)",
	"ngg_images": "gallery (NextGEN)",
	"nggallery": "gallery (NextGEN)",
	"elementor-template": "Elementor template",
	"wpcode": "code snippet (WPCode)",
	"insert_php": "PHP snippet",
	"xyz-ihs": "HTML snippet (Insert HTML Snippet)",
};
/** WooCommerce listings the product grid cannot rebuild (src/adapters/woocommerce.ts reports them). */
for (const [tag, what] of Object.entries({
	best_selling_products: "WooCommerce best sellers",
	top_rated_products: "WooCommerce top rated products",
	product_attribute: "WooCommerce products by attribute",
	product_categories: "WooCommerce product category list",
	product: "WooCommerce single product",
	product_page: "WooCommerce product page",
	add_to_cart: "WooCommerce add-to-cart button",
	add_to_cart_url: "WooCommerce add-to-cart link",
}))
	WIDGET[tag] = what;
/** WooCommerce product listings rebuilt as a product grid (catalogue mode). */
const PRODUCTS = new Set(["products", "featured_products", "sale_products", "recent_products", "product_category"]);
/** Widgets whose output is the site's own content (blocking), by their description. */
const CONTENT_WIDGET = /table|gallery|slider|flipbook|PDF|document|events|booking|map|template|snippet|policy text|cookie list|calendar|Calendly|entries|WooCommerce/i;
const MEDIA = new Set(["caption", "wp_caption", "gallery", "embed", "video", "audio", "playlist"]);

/** What to do with a shortcode tag no adapter handled; undefined = unknown (reported as unmapped). */
export function shortcodeAction(tag: string): ShortcodeAction | undefined {
	const t = tag.trim();
	if (FORM[t]) return { do: "form", provider: FORM[t] };
	if (BREADCRUMBS.has(t)) return { do: "breadcrumbs" };
	if (STRIP.has(t)) return { do: "strip" };
	const w = WIDGET[t];
	if (w) return { do: "widget", what: w, content: CONTENT_WIDGET.test(w) };
	if (MEDIA.has(t)) return { do: "media" };
	if (PRODUCTS.has(t)) return { do: "products" };
	return undefined;
}

/** The form id a form shortcode names (`id`, Gravity `id`, Fluent `id`, Ninja `id`, a bare first argument). */
export function formIdOf(attrs: Record<string, string>, args: string[] = []): string {
	return (attrs.id ?? attrs.form ?? attrs.form_id ?? attrs.key ?? args[0] ?? "").trim();
}

/** Every registry entry, for the docs and the coverage report. */
export function shortcodeRegistry(): { tag: string; action: ShortcodeAction }[] {
	return [
		...Object.entries(FORM).map(([tag, provider]) => ({ tag, action: { do: "form" as const, provider } })),
		...[...BREADCRUMBS].map((tag) => ({ tag, action: { do: "breadcrumbs" as const } })),
		...[...STRIP].map((tag) => ({ tag, action: { do: "strip" as const } })),
		...Object.entries(WIDGET).map(([tag, what]) => ({ tag, action: { do: "widget" as const, what, content: CONTENT_WIDGET.test(what) } })),
		...[...MEDIA].map((tag) => ({ tag, action: { do: "media" as const } })),
		...[...PRODUCTS].map((tag) => ({ tag, action: { do: "products" as const } })),
	];
}
