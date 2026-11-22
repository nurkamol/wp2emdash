/**
 * The synthetic WordPress site the end-to-end test seeds, as data. Deterministic: the same plan (and the same JSON)
 * every run, so a failure is about the kit or a plugin version, never the content. All of it is made up — a pottery
 * studio that does not exist — and contains no client data.
 *
 * e2e/wordpress/seed.php reads the JSON (`wp eval-file seed.php plan.json`) and creates everything with WordPress,
 * WooCommerce, Polylang, Elementor, Contact Form 7 and Fluent Forms APIs. Placeholders in content are resolved there:
 *   {{site}}               home URL without the trailing slash (http://localhost:8080)
 *   {{image:<key>:id}}     attachment id (a bare number where the placeholder fills a whole JSON string: "…" → 123)
 *   {{image:<key>:url}}    attachment URL (full size)
 *   {{form:fluent}}        Fluent Forms form id
 *   {{form:cf7}}           Contact Form 7 short hash (CF7 5.8+ embeds), else the post id
 *
 * `expected` is what the assertions (e2e/lib/assertions.ts) check the migrated site against.
 */

export type Lang = "en" | "fr";

export interface PlanImage {
	key: string;
	file: string;
	width: number;
	height: number;
	/** #rrggbb */
	color: string;
	alt: string;
	title: string;
}

export interface PlanPage {
	key: string;
	title: string;
	slug: string;
	lang: Lang;
	builder: "gutenberg" | "elementor";
	/** Gutenberg block markup (builder gutenberg). */
	content?: string;
	/** Elementor element tree (builder elementor), stored as `_elementor_data`. */
	elementor?: ElementorNode[];
	translationOf?: string;
	front?: boolean;
	postsPage?: boolean;
	menuOrder: number;
}

export interface PlanPost {
	key: string;
	title: string;
	slug: string;
	lang: Lang;
	/** Local time, `YYYY-MM-DD HH:MM:SS`. */
	date: string;
	content: string;
	excerpt: string;
	categories: string[];
	tags: string[];
	featuredImage: string;
	translationOf?: string;
}

export interface PlanTerm {
	key: string;
	name: string;
	slug: string;
	lang: Lang;
	translationOf?: string;
}

export interface PlanProduct {
	key: string;
	type: "simple" | "variable";
	name: string;
	slug: string;
	sku: string;
	short: string;
	description: string;
	categories: string[];
	image: string;
	/** simple: prices as decimal strings. */
	regularPrice?: string;
	salePrice?: string;
	/** variable: one non-taxonomy attribute and a variation per option. */
	attribute?: { name: string; options: string[] };
	variations?: { option: string; sku: string; regularPrice: string; salePrice?: string }[];
}

export interface PlanMenuItem {
	label: string;
	/** A page key, `woo:shop`, or a URL (may use {{site}}). */
	page?: string;
	url?: string;
}

export interface PlanMenu {
	key: string;
	name: string;
	location: "primary" | "footer";
	lang: Lang;
	items: PlanMenuItem[];
}

export interface FluentField {
	element: "input_text" | "input_email" | "select" | "textarea" | "input_checkbox";
	name: string;
	label: string;
	required?: boolean;
	placeholder?: string;
	options?: string[];
}

export interface SeedPlan {
	version: 1;
	site: { title: string; tagline: string; adminEmail: string; currency: string; logo: string; icon: string };
	languages: { slug: Lang; locale: string; name: string; default: boolean }[];
	images: PlanImage[];
	categories: PlanTerm[];
	tags: PlanTerm[];
	productCategories: { key: string; name: string; slug: string }[];
	forms: {
		fluent: { title: string; fields: FluentField[]; submit: string; confirmation: string; recipient: string };
		cf7: { title: string; template: string; recipient: string; subject: string };
	};
	pages: PlanPage[];
	posts: PlanPost[];
	products: PlanProduct[];
	menus: PlanMenu[];
	expected: SeedExpectations;
}

export interface SeedExpectations {
	/** Live path → language; the seeded pages, posts and products the migrated site must answer at. */
	routes: { path: string; lang: Lang; kind: "page" | "post" | "product"; builder?: "gutenberg" | "elementor" }[];
	/** Translated pairs (default-language path, French path). */
	pairs: { en: string; fr: string }[];
	products: { slug: string; type: "simple" | "variable"; onSale: boolean; variations: number }[];
	elementorSlugs: string[];
	/** Form providers and the pages embedding them. */
	forms: { provider: "fluent-forms" | "contact-form-7"; paths: string[] }[];
	productCategories: string[];
}

// ── Elementor ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface ElementorNode {
	id: string;
	elType: "container" | "section" | "column" | "widget";
	isInner?: boolean;
	widgetType?: string;
	settings: Record<string, unknown>;
	elements: ElementorNode[];
}

/** Deterministic 7-hex element ids (Elementor's own format), unique within the plan. */
export function idFactory(seed: string): () => string {
	let n = 0;
	let h = 0;
	for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return () => (((h + ++n * 2654435761) >>> 0) % 0xfffffff).toString(16).padStart(7, "0");
}

function elementor(seed: string) {
	const id = idFactory(seed);
	const w = (widgetType: string, settings: Record<string, unknown>): ElementorNode => ({ id: id(), elType: "widget", widgetType, settings, elements: [] });
	const box = (settings: Record<string, unknown>, elements: ElementorNode[], isInner = false): ElementorNode => ({ id: id(), elType: "container", isInner, settings: { content_width: "boxed", ...settings }, elements });
	const section = (columns: ElementorNode[][], settings: Record<string, unknown> = {}): ElementorNode => ({
		id: id(),
		elType: "section",
		isInner: false,
		settings,
		elements: columns.map((els) => ({ id: id(), elType: "column", isInner: false, settings: { _column_size: Math.round(100 / columns.length), _inline_size: null }, elements: els })),
	});
	const image = (key: string, alt: string) => ({ url: `{{image:${key}:url}}`, id: `{{image:${key}:id}}`, alt, source: "library" });
	const link = (url: string) => ({ url, is_external: "", nofollow: "" });
	return { w, box, section, image, link };
}

// ── The plan ──────────────────────────────────────────────────────────────────────────────────────────────────

const IMAGES: PlanImage[] = [
	{ key: "logo", file: "harbor-lane-logo.png", width: 480, height: 160, color: "#1f3a5f", alt: "Harbor Lane Pottery", title: "Logo" },
	{ key: "icon", file: "harbor-lane-icon.png", width: 512, height: 512, color: "#c8553d", alt: "", title: "Site icon" },
	{ key: "hero", file: "studio-hero.png", width: 1600, height: 900, color: "#2f4858", alt: "The studio's long workbench", title: "Studio hero" },
	{ key: "studio", file: "wheel-room.png", width: 1200, height: 800, color: "#86bbd8", alt: "Three wheels by the window", title: "Wheel room" },
	{ key: "kiln", file: "kiln.png", width: 1200, height: 800, color: "#f6ae2d", alt: "The electric kiln, door open", title: "Kiln" },
	{ key: "glaze", file: "glaze-shelf.png", width: 1200, height: 800, color: "#33658a", alt: "Glaze buckets on a shelf", title: "Glaze shelf" },
	{ key: "gallery-1", file: "gallery-cups.png", width: 900, height: 600, color: "#758e4f", alt: "A row of cups drying", title: "Cups" },
	{ key: "gallery-2", file: "gallery-bowls.png", width: 900, height: 600, color: "#9a8f97", alt: "Nested bowls", title: "Bowls" },
	{ key: "gallery-3", file: "gallery-plates.png", width: 900, height: 600, color: "#c3baba", alt: "Plates stacked on a cart", title: "Plates" },
	...[1, 2, 3, 4, 5].map((n, i) => ({ key: `post-${n}`, file: `post-${n}.png`, width: 1200, height: 800, color: ["#5b8e7d", "#bc4b51", "#8cb369", "#f4a259", "#3d5a80"][i] as string, alt: `Post illustration ${n}`, title: `Post ${n}` })),
	...[1, 2, 3, 4, 5, 6].map((n, i) => ({ key: `product-${n}`, file: `product-${n}.png`, width: 800, height: 800, color: ["#6d597a", "#b56576", "#e56b6f", "#eaac8b", "#355070", "#2a9d8f"][i] as string, alt: `Product photo ${n}`, title: `Product ${n}` })),
];

function homeEn(): ElementorNode[] {
	const { w, box, image, link } = elementor("home-en");
	return [
		box({ flex_direction: "column", _element_id: "welcome" }, [
			w("heading", { title: "Handmade pottery from Harbor Lane", header_size: "h1", align: "center" }),
			w("text-editor", { editor: "<p>Small-batch stoneware, thrown and glazed in our studio by the harbour. Come for a class, leave with a mug.</p>" }),
			box({ flex_direction: "row", content_width: "full" }, [w("button", { text: "Visit the shop", link: link("{{site}}/shop/"), size: "lg" }), w("button", { text: "Book a class", link: link("{{site}}/classes/") })], true),
			w("image", { image: image("hero", "The studio's long workbench"), image_size: "large" }),
		]),
		box({ flex_direction: "row" }, [
			box({ flex_direction: "column" }, [w("icon-box", { title_text: "Wheel classes", description_text: "Six-week courses for complete beginners and returning potters.", selected_icon: { value: "fas fa-circle", library: "fa-solid" }, link: link("{{site}}/classes/") })], true),
			box({ flex_direction: "column" }, [w("icon-box", { title_text: "Open studio", description_text: "Members get a shelf, clay at cost and firing every week.", selected_icon: { value: "fas fa-key", library: "fa-solid" } })], true),
			box({ flex_direction: "column" }, [w("icon-box", { title_text: "Commissions", description_text: "Dinner sets and wedding gifts, made to order.", selected_icon: { value: "fas fa-gift", library: "fa-solid" }, link: link("{{site}}/enquiry/") })], true),
		]),
		box({ flex_direction: "column" }, [
			w("heading", { title: "What students say", header_size: "h2" }),
			w("testimonial", { testimonial_content: "I came for one evening and stayed for three years. The teachers are patient and the kiln is never full.", testimonial_name: "Robin Example", testimonial_job: "Member since 2023" }),
			w("counter", { starting_number: 0, ending_number: 1200, suffix: "+", title: "Mugs thrown this year" }),
		]),
		box({ flex_direction: "column" }, [
			w("heading", { title: "From the studio", header_size: "h2" }),
			w("image-gallery", { wp_gallery: ["gallery-1", "gallery-2", "gallery-3"].map((k) => ({ id: `{{image:${k}:id}}`, url: `{{image:${k}:url}}` })), gallery_columns: "3" }),
		]),
	];
}

function homeFr(): ElementorNode[] {
	const { w, box, image, link } = elementor("home-fr");
	return [
		box({ flex_direction: "column" }, [
			w("heading", { title: "Poterie artisanale de Harbor Lane", header_size: "h1", align: "center" }),
			w("text-editor", { editor: "<p>Grès en petites séries, tourné et émaillé dans notre atelier près du port.</p>" }),
			w("button", { text: "Nous écrire", link: link("{{site}}/fr/nous-contacter/") }),
			w("image", { image: image("hero", "Le grand établi de l'atelier"), image_size: "large" }),
		]),
		box({ flex_direction: "column" }, [
			w("heading", { title: "Ce que disent nos élèves", header_size: "h2" }),
			w("testimonial", { testimonial_content: "Je suis venue pour une soirée et je suis restée trois ans.", testimonial_name: "Camille Exemple", testimonial_job: "Membre depuis 2023" }),
		]),
	];
}

function classesEn(): ElementorNode[] {
	const { w, section, image } = elementor("classes-en");
	return [
		section([
			[w("heading", { title: "Classes", header_size: "h1" }), w("text-editor", { editor: "<p>Every course runs for six weeks, two and a half hours each week, eight students at most.</p><p>Clay, glazes and two firings are included.</p>" })],
			[w("image", { image: image("studio", "Three wheels by the window") })],
		]),
		section([
			[
				w("heading", { title: "What you will learn", header_size: "h2" }),
				w("icon-list", {
					icon_list: [
						{ _id: "l1", text: "Wedging and centring", selected_icon: { value: "fas fa-check", library: "fa-solid" } },
						{ _id: "l2", text: "Pulling walls and trimming", selected_icon: { value: "fas fa-check", library: "fa-solid" } },
						{ _id: "l3", text: "Glazing and firing", selected_icon: { value: "fas fa-check", library: "fa-solid" } },
					],
				}),
			],
			[w("image-box", { image: image("kiln", "The electric kiln, door open"), title_text: "Firing day", description_text: "Pieces are bisque fired on Mondays and glaze fired on Thursdays." })],
		]),
		section([
			[
				w("heading", { title: "Course details", header_size: "h2" }),
				w("accordion", {
					tabs: [
						{ _id: "a1", tab_title: "When do courses start?", tab_content: "<p>The first Tuesday of every second month.</p>" },
						{ _id: "a2", tab_title: "Do I need my own tools?", tab_content: "<p>No. A basic tool kit is yours to keep.</p>" },
					],
				}),
				w("divider", { style: "solid" }),
			],
		]),
	];
}

function faqEn(): ElementorNode[] {
	const { w, box } = elementor("faq-en");
	return [
		box({ flex_direction: "column" }, [
			w("heading", { title: "Questions", header_size: "h1" }),
			w("toggle", {
				tabs: [
					{ _id: "t1", tab_title: "Is parking available?", tab_content: "<p>Yes, two spaces behind the studio.</p>" },
					{ _id: "t2", tab_title: "Can I bring a friend?", tab_content: "<p>Book a second place; courses are capped at eight.</p>" },
				],
			}),
			w("tabs", {
				tabs: [
					{ _id: "x1", tab_title: "Members", tab_content: "<p>Shelf space, clay at cost and weekly firing.</p>" },
					{ _id: "x2", tab_title: "Visitors", tab_content: "<p>Drop-in sessions every Saturday morning.</p>" },
				],
			}),
			w("social-icons", {
				social_icon_list: [
					{ _id: "s1", social_icon: { value: "fab fa-instagram", library: "fa-brands" }, link: { url: "https://www.instagram.com/example", is_external: "on" } },
					{ _id: "s2", social_icon: { value: "fab fa-facebook", library: "fa-brands" }, link: { url: "https://www.facebook.com/example", is_external: "on" } },
				],
			}),
		]),
	];
}

function enquiryEn(): ElementorNode[] {
	const { w, box } = elementor("enquiry-en");
	return [
		box({ flex_direction: "column" }, [
			w("heading", { title: "Private commissions", header_size: "h1" }),
			w("text-editor", { editor: "<p>Tell us what you have in mind. We reply within three working days with a sketch and a price.</p>" }),
			w("shortcode", { shortcode: '[contact-form-7 id="{{form:cf7}}" title="Commission enquiry"]' }),
		]),
	];
}

const g = {
	h2: (t: string) => `<!-- wp:heading -->\n<h2 class="wp-block-heading">${t}</h2>\n<!-- /wp:heading -->`,
	p: (t: string) => `<!-- wp:paragraph -->\n<p>${t}</p>\n<!-- /wp:paragraph -->`,
	image: (key: string, alt: string) => `<!-- wp:image {"id":{{image:${key}:id}},"sizeSlug":"large","linkDestination":"none"} -->\n<figure class="wp-block-image size-large"><img src="{{image:${key}:url}}" alt="${alt}" class="wp-image-{{image:${key}:id}}"/></figure>\n<!-- /wp:image -->`,
	list: (items: string[]) => `<!-- wp:list -->\n<ul class="wp-block-list">${items.map((i) => `<!-- wp:list-item -->\n<li>${i}</li>\n<!-- /wp:list-item -->`).join("\n")}</ul>\n<!-- /wp:list -->`,
	quote: (t: string, cite: string) => `<!-- wp:quote -->\n<blockquote class="wp-block-quote"><!-- wp:paragraph -->\n<p>${t}</p>\n<!-- /wp:paragraph --><cite>${cite}</cite></blockquote>\n<!-- /wp:quote -->`,
	columns: (cols: string[][]) => `<!-- wp:columns -->\n<div class="wp-block-columns">${cols.map((c) => `<!-- wp:column -->\n<div class="wp-block-column">${c.join("\n")}</div>\n<!-- /wp:column -->`).join("\n")}</div>\n<!-- /wp:columns -->`,
	button: (text: string, href: string) => `<!-- wp:buttons -->\n<div class="wp-block-buttons"><!-- wp:button -->\n<div class="wp-block-button"><a class="wp-block-button__link wp-element-button" href="${href}">${text}</a></div>\n<!-- /wp:button --></div>\n<!-- /wp:buttons -->`,
	shortcode: (s: string) => `<!-- wp:shortcode -->\n${s}\n<!-- /wp:shortcode -->`,
};
const blocks = (...b: string[]) => b.join("\n\n");

const PAGES: PlanPage[] = [
	{ key: "home", title: "Home", slug: "home", lang: "en", builder: "elementor", elementor: homeEn(), front: true, menuOrder: 0 },
	{
		key: "about",
		title: "About",
		slug: "about",
		lang: "en",
		builder: "gutenberg",
		menuOrder: 1,
		content: blocks(
			g.p("Harbor Lane Pottery started in 2019 in a former net store by the water. Today six potters share the wheels, the glaze room and one very hard-working kiln."),
			g.h2("Our kiln"),
			g.image("kiln", "The electric kiln, door open"),
			g.p("We fire to cone 6 in oxidation. Every glaze on our shelves is mixed in the studio from a recipe we can share."),
			g.list(["Stoneware and porcelain bodies", "Twelve house glazes", "Weekly bisque and glaze firings"]),
			g.quote("Make the same bowl a hundred times and the hundred-and-first will surprise you.", "Studio saying"),
			g.columns([[g.h2("Visit"), g.p("Open Tuesday to Saturday, ten until six.")], [g.h2("Teach"), g.p("We are always looking for guest teachers for weekend workshops.")]]),
			g.button("Get in touch", "{{site}}/contact/"),
		),
	},
	{ key: "classes", title: "Classes", slug: "classes", lang: "en", builder: "elementor", elementor: classesEn(), menuOrder: 2 },
	{ key: "faq", title: "FAQ", slug: "faq", lang: "en", builder: "elementor", elementor: faqEn(), menuOrder: 3 },
	{
		key: "contact",
		title: "Contact",
		slug: "contact",
		lang: "en",
		builder: "gutenberg",
		menuOrder: 4,
		content: blocks(g.p("Questions about classes, orders or the studio? Write to us and we will answer within two working days."), g.shortcode('[fluentform id="{{form:fluent}}"]'), g.p('Prefer the phone? Call <a href="tel:+15550100200">+1 555 0100 200</a> or email <a href="mailto:hello@example.test">hello@example.test</a>.')),
	},
	{ key: "enquiry", title: "Private commissions", slug: "enquiry", lang: "en", builder: "elementor", elementor: enquiryEn(), menuOrder: 5 },
	{ key: "news", title: "News", slug: "news", lang: "en", builder: "gutenberg", content: "", postsPage: true, menuOrder: 6 },
	{ key: "home-fr", title: "Accueil", slug: "accueil", lang: "fr", builder: "elementor", elementor: homeFr(), translationOf: "home", menuOrder: 0 },
	{
		key: "about-fr",
		title: "À propos",
		slug: "a-propos",
		lang: "fr",
		builder: "gutenberg",
		translationOf: "about",
		menuOrder: 1,
		content: blocks(
			g.p("Harbor Lane Pottery a ouvert en 2019 dans un ancien hangar à filets au bord de l'eau. Six potiers partagent aujourd'hui les tours, la salle d'émaillage et un four qui ne chôme jamais."),
			g.h2("Notre four"),
			g.image("kiln", "Le four électrique, porte ouverte"),
			g.p("Nous cuisons au cône 6 en oxydation."),
			g.button("Nous écrire", "{{site}}/fr/nous-contacter/"),
		),
	},
	{
		key: "contact-fr",
		title: "Nous contacter",
		slug: "nous-contacter",
		lang: "fr",
		builder: "gutenberg",
		translationOf: "contact",
		menuOrder: 2,
		content: blocks(g.p("Une question sur les cours, une commande ou l'atelier ? Écrivez-nous."), g.shortcode('[fluentform id="{{form:fluent}}"]')),
	},
];

const CATEGORIES: PlanTerm[] = [
	{ key: "news", name: "Studio news", slug: "studio-news", lang: "en" },
	{ key: "guides", name: "Guides", slug: "guides", lang: "en" },
	{ key: "news-fr", name: "Actualités", slug: "actualites", lang: "fr", translationOf: "news" },
	{ key: "guides-fr", name: "Conseils", slug: "conseils", lang: "fr", translationOf: "guides" },
];
const TAGS: PlanTerm[] = [
	{ key: "clay", name: "Clay", slug: "clay", lang: "en" },
	{ key: "kiln", name: "Kiln", slug: "kiln", lang: "en" },
	{ key: "glaze", name: "Glaze", slug: "glaze", lang: "en" },
	{ key: "events", name: "Events", slug: "events", lang: "en" },
	{ key: "argile", name: "Argile", slug: "argile", lang: "fr" },
];

const post = (key: string, title: string, slug: string, date: string, cats: string[], tags: string[], img: string, paras: string[], extra: Partial<PlanPost> = {}): PlanPost => ({
	key,
	title,
	slug,
	lang: "en",
	date,
	content: blocks(...paras.map((p, i) => (i === 1 ? `${g.h2(title.split(" ").slice(0, 3).join(" "))}\n\n${g.p(p)}` : g.p(p)))),
	excerpt: paras[0]?.slice(0, 120) ?? "",
	categories: cats,
	tags,
	featuredImage: img,
	...extra,
});

const POSTS: PlanPost[] = [
	post("clay-body", "Choosing your first clay body", "choosing-your-first-clay-body", "2026-03-04 10:00:00", ["guides"], ["clay"], "post-1", ["Smooth stoneware forgives a lot. Start there, then try a groggy body once you can centre without thinking.", "Porcelain is beautiful and unforgiving: wait until your walls are even.", "Whatever you pick, wedge it well."]),
	post("open-studio", "Spring open studio", "spring-open-studio", "2026-04-11 09:30:00", ["news"], ["events"], "post-2", ["On the last Saturday of April the doors are open from ten until four.", "Try the wheel, watch a firing and take home a seconds mug.", "Entry is free."]),
	post("kiln-firing", "How we fire our kiln", "how-we-fire-our-kiln", "2026-05-20 14:00:00", ["guides"], ["kiln"], "post-3", ["A bisque firing takes about eight hours, a glaze firing ten.", "We load on Monday mornings and unload once the kiln is below one hundred degrees.", "Never open it early."]),
	post("glaze-day", "Glaze day recap", "glaze-day-recap", "2026-06-15 16:00:00", ["news"], ["glaze", "events"], "post-4", ["Twenty members mixed four new test glazes on Saturday.", "The celadon was the favourite; the tenmoku needs another try.", "Recipes are on the board by the sink."]),
	post("mug-care", "Caring for handmade mugs", "caring-for-handmade-mugs", "2026-07-02 08:00:00", ["guides"], ["glaze"], "post-5", ["All our mugs are dishwasher safe, but hand washing keeps the glaze bright for longer.", "Avoid sudden temperature changes.", "A chipped foot ring can be sanded smooth."]),
	{
		key: "clay-body-fr",
		title: "Choisir sa première argile",
		slug: "choisir-sa-premiere-argile",
		lang: "fr",
		date: "2026-03-05 10:00:00",
		content: blocks(g.p("Un grès lisse pardonne beaucoup. Commencez par là."), g.h2("Et la porcelaine ?"), g.p("La porcelaine est belle mais exigeante.")),
		excerpt: "Un grès lisse pardonne beaucoup.",
		categories: ["guides-fr"],
		tags: ["argile"],
		featuredImage: "post-1",
		translationOf: "clay-body",
	},
	{
		key: "open-studio-fr",
		title: "Portes ouvertes de printemps",
		slug: "portes-ouvertes-de-printemps",
		lang: "fr",
		date: "2026-04-12 09:30:00",
		content: blocks(g.p("Le dernier samedi d'avril, l'atelier est ouvert de dix heures à seize heures."), g.p("L'entrée est libre.")),
		excerpt: "Le dernier samedi d'avril, l'atelier est ouvert.",
		categories: ["news-fr"],
		tags: [],
		featuredImage: "post-2",
		translationOf: "open-studio",
	},
];

const PRODUCT_CATEGORIES = [
	{ key: "mugs", name: "Mugs", slug: "mugs" },
	{ key: "bowls", name: "Bowls", slug: "bowls" },
	{ key: "home-goods", name: "Home", slug: "home-goods" },
];

const PRODUCTS: PlanProduct[] = [
	{ key: "harbor-mug", type: "simple", name: "Harbor mug", slug: "harbor-mug", sku: "HL-MUG-01", short: "A 350 ml mug in our sea-glass celadon.", description: "Thrown on the wheel, trimmed by hand and glazed inside and out. Dishwasher safe.", categories: ["mugs"], image: "product-1", regularPrice: "28.00", salePrice: "24.00" },
	{ key: "tide-bowl", type: "simple", name: "Tide bowl", slug: "tide-bowl", sku: "HL-BWL-01", short: "A cereal bowl with a rolled rim.", description: "Speckled stoneware with a satin white glaze.", categories: ["bowls"], image: "product-2", regularPrice: "36.00" },
	{ key: "speckled-plate", type: "simple", name: "Speckled plate", slug: "speckled-plate", sku: "HL-PLT-01", short: "A 26 cm dinner plate.", description: "Flat, sturdy and made to be used every day.", categories: ["home-goods"], image: "product-3", regularPrice: "32.00" },
	{ key: "espresso-cup", type: "simple", name: "Espresso cup", slug: "espresso-cup", sku: "HL-MUG-02", short: "A 90 ml cup without a handle.", description: "Fits in the palm; sold singly.", categories: ["mugs"], image: "product-4", regularPrice: "18.00", salePrice: "15.00" },
	{
		key: "serving-bowl",
		type: "variable",
		name: "Serving bowl",
		slug: "serving-bowl",
		sku: "HL-BWL-02",
		short: "A wide serving bowl in three sizes.",
		description: "For salads, fruit or bread. Each one is a little different.",
		categories: ["bowls"],
		image: "product-5",
		attribute: { name: "Size", options: ["Small", "Medium", "Large"] },
		variations: [
			{ option: "Small", sku: "HL-BWL-02-S", regularPrice: "40.00" },
			{ option: "Medium", sku: "HL-BWL-02-M", regularPrice: "55.00" },
			{ option: "Large", sku: "HL-BWL-02-L", regularPrice: "70.00", salePrice: "62.00" },
		],
	},
	{
		key: "planter",
		type: "variable",
		name: "Planter",
		slug: "planter",
		sku: "HL-HOM-01",
		short: "A planter with a drainage hole and saucer.",
		description: "Unglazed outside, glazed inside.",
		categories: ["home-goods"],
		image: "product-6",
		attribute: { name: "Size", options: ["Small", "Large"] },
		variations: [
			{ option: "Small", sku: "HL-HOM-01-S", regularPrice: "30.00" },
			{ option: "Large", sku: "HL-HOM-01-L", regularPrice: "45.00" },
		],
	},
];

const MENUS: PlanMenu[] = [
	{
		key: "primary-en",
		name: "Primary",
		location: "primary",
		lang: "en",
		items: [{ label: "Home", page: "home" }, { label: "About", page: "about" }, { label: "Classes", page: "classes" }, { label: "Shop", page: "woo:shop" }, { label: "FAQ", page: "faq" }, { label: "News", page: "news" }, { label: "Contact", page: "contact" }],
	},
	{
		key: "footer-en",
		name: "Footer",
		location: "footer",
		lang: "en",
		items: [{ label: "Private commissions", page: "enquiry" }, { label: "Contact", page: "contact" }, { label: "Instagram", url: "https://www.instagram.com/example" }],
	},
	{ key: "primary-fr", name: "Principal", location: "primary", lang: "fr", items: [{ label: "Accueil", page: "home-fr" }, { label: "À propos", page: "about-fr" }, { label: "Nous contacter", page: "contact-fr" }] },
];

/** Live path of a page, post or product, as WordPress serves it with these settings (pretty permalinks, Polylang directory, default hidden). */
export function livePath(item: { slug: string; lang: Lang; front?: boolean }, kind: "page" | "post" | "product"): string {
	const prefix = item.lang === "en" ? "" : `/${item.lang}`;
	if (kind === "page" && item.front) return `${prefix}/`;
	if (kind === "product") return `/product/${item.slug}/`;
	return `${prefix}/${item.slug}/`;
}

export function buildSeedPlan(): SeedPlan {
	const pageByKey = new Map(PAGES.map((p) => [p.key, p]));
	const postByKey = new Map(POSTS.map((p) => [p.key, p]));
	const frontKeys = new Set(PAGES.filter((p) => p.front || (p.translationOf && pageByKey.get(p.translationOf)?.front)).map((p) => p.key));
	const pagePath = (p: PlanPage) => livePath({ ...p, front: frontKeys.has(p.key) }, "page");
	const routes: SeedExpectations["routes"] = [
		...PAGES.map((p) => ({ path: pagePath(p), lang: p.lang, kind: "page" as const, builder: p.builder })),
		...POSTS.map((p) => ({ path: livePath(p, "post"), lang: p.lang, kind: "post" as const })),
		...PRODUCTS.map((p) => ({ path: livePath({ slug: p.slug, lang: "en" }, "product"), lang: "en" as const, kind: "product" as const })),
	];
	const pairs = [
		...PAGES.filter((p) => p.translationOf).map((p) => ({ en: pagePath(pageByKey.get(p.translationOf as string) as PlanPage), fr: pagePath(p) })),
		...POSTS.filter((p) => p.translationOf).map((p) => ({ en: livePath(postByKey.get(p.translationOf as string) as PlanPost, "post"), fr: livePath(p, "post") })),
	];
	const embeds = (needle: string) => PAGES.filter((p) => (p.content ?? JSON.stringify(p.elementor ?? [])).includes(needle)).map(pagePath);
	return {
		version: 1,
		site: { title: "Harbor Lane Pottery", tagline: "Handmade stoneware by the water", adminEmail: "admin@example.test", currency: "USD", logo: "logo", icon: "icon" },
		languages: [
			{ slug: "en", locale: "en_US", name: "English", default: true },
			{ slug: "fr", locale: "fr_FR", name: "Français", default: false },
		],
		images: IMAGES,
		categories: CATEGORIES,
		tags: TAGS,
		productCategories: PRODUCT_CATEGORIES,
		forms: {
			fluent: {
				title: "Contact us",
				fields: [
					{ element: "input_text", name: "full_name", label: "Your name", required: true, placeholder: "Jane Example" },
					{ element: "input_email", name: "email", label: "Email", required: true },
					{ element: "select", name: "topic", label: "Topic", options: ["Classes", "An order", "Something else"] },
					{ element: "textarea", name: "message", label: "Message", required: true },
					{ element: "input_checkbox", name: "newsletter", label: "Newsletter", options: ["Send me studio news"] },
				],
				submit: "Send message",
				confirmation: "Thank you, we will be in touch within two working days.",
				recipient: "forms@example.test",
			},
			cf7: {
				title: "Commission enquiry",
				template: [
					"<label> Your name\n    [text* your-name autocomplete:name] </label>",
					"<label> Your email\n    [email* your-email autocomplete:email] </label>",
					"<label> Phone\n    [tel your-phone] </label>",
					'<label> What would you like made?\n    [select piece "Dinner set" "Mugs" "Something else"] </label>',
					"<label> Details\n    [textarea* your-message] </label>",
					'[submit "Send enquiry"]',
				].join("\n\n"),
				recipient: "commissions@example.test",
				subject: "Commission enquiry from [your-name]",
			},
		},
		pages: PAGES,
		posts: POSTS,
		products: PRODUCTS,
		menus: MENUS,
		expected: {
			routes,
			pairs,
			products: PRODUCTS.map((p) => ({ slug: p.slug, type: p.type, onSale: !!p.salePrice || !!p.variations?.some((v) => v.salePrice), variations: p.variations?.length ?? 0 })),
			elementorSlugs: PAGES.filter((p) => p.builder === "elementor").map((p) => p.slug),
			forms: [
				{ provider: "fluent-forms", paths: embeds("[fluentform") },
				{ provider: "contact-form-7", paths: embeds("[contact-form-7") },
			],
			productCategories: PRODUCT_CATEGORIES.map((c) => c.slug),
		},
	};
}

/**
 * The same placeholder rules as e2e_resolve() in e2e/wordpress/seed.php, for tests that run the kit's adapters on
 * exactly what the seed stores (a quoted "{{image:<key>:id}}" becomes a bare number).
 */
export function resolvePlaceholders(text: string, ctx: { site: string; images: Record<string, { id: number; url: string }>; fluent: number; cf7: string }): string {
	const value = (key: string): string => {
		if (key === "site") return ctx.site;
		if (key === "form:fluent") return String(ctx.fluent);
		if (key === "form:cf7") return ctx.cf7;
		const [kind, k, field] = key.split(":");
		const img = kind === "image" && k ? ctx.images[k] : undefined;
		if (!img) throw new Error(`unknown placeholder {{${key}}}`);
		return field === "id" ? String(img.id) : img.url;
	};
	return text.replace(/"\{\{(image:[a-z0-9-]+:id)\}\}"/g, (_m, k: string) => value(k)).replace(/\{\{([a-z0-9:-]+)\}\}/g, (_m, k: string) => value(k));
}

/** Problems with a plan (dangling keys, duplicate slugs, unresolvable placeholders); empty when it is consistent. */
export function planProblems(plan: SeedPlan): string[] {
	const out: string[] = [];
	const images = new Set(plan.images.map((i) => i.key));
	const pages = new Set(plan.pages.map((p) => p.key));
	const posts = new Set(plan.posts.map((p) => p.key));
	const cats = new Set(plan.categories.map((c) => c.key));
	const tags = new Set(plan.tags.map((t) => t.key));
	const pcats = new Set(plan.productCategories.map((c) => c.key));
	const dup = (label: string, list: string[]) => {
		const seen = new Set<string>();
		for (const x of list) {
			if (seen.has(x)) out.push(`duplicate ${label}: ${x}`);
			seen.add(x);
		}
	};
	dup("image key", plan.images.map((i) => i.key));
	dup("image file", plan.images.map((i) => i.file));
	dup("page key", plan.pages.map((p) => p.key));
	dup("page/post slug", [...plan.pages, ...plan.posts].map((p) => p.slug));
	dup("product slug", plan.products.map((p) => p.slug));
	dup("product sku", plan.products.flatMap((p) => [p.sku, ...(p.variations ?? []).map((v) => v.sku)]));
	dup("term slug", [...plan.categories, ...plan.tags].map((t) => t.slug));
	for (const k of [plan.site.logo, plan.site.icon]) if (!images.has(k)) out.push(`site image ${k} not in images`);
	const text = JSON.stringify({ pages: plan.pages, posts: plan.posts });
	for (const m of text.matchAll(/\{\{([^}]+)\}\}/g)) {
		const [kind, key, field] = (m[1] as string).split(":");
		if (kind === "site" && key === undefined) continue;
		if (kind === "image" && key && images.has(key) && (field === "id" || field === "url")) continue;
		if (kind === "form" && (key === "fluent" || key === "cf7")) continue;
		out.push(`unresolvable placeholder {{${m[1]}}}`);
	}
	for (const p of plan.pages) {
		if (p.translationOf && !pages.has(p.translationOf)) out.push(`page ${p.key}: translationOf ${p.translationOf} unknown`);
		if (p.builder === "elementor" && !p.elementor?.length) out.push(`page ${p.key}: elementor page without elements`);
		if (p.builder === "gutenberg" && p.content === undefined) out.push(`page ${p.key}: gutenberg page without content`);
	}
	if (plan.pages.filter((p) => p.front).length !== 1) out.push("exactly one front page expected");
	for (const p of plan.posts) {
		if (!images.has(p.featuredImage)) out.push(`post ${p.key}: image ${p.featuredImage} unknown`);
		for (const c of p.categories) if (!cats.has(c)) out.push(`post ${p.key}: category ${c} unknown`);
		for (const t of p.tags) if (!tags.has(t)) out.push(`post ${p.key}: tag ${t} unknown`);
		if (p.translationOf && !posts.has(p.translationOf)) out.push(`post ${p.key}: translationOf ${p.translationOf} unknown`);
		for (const c of p.categories) if (plan.categories.find((x) => x.key === c)?.lang !== p.lang) out.push(`post ${p.key}: category ${c} is in another language`);
	}
	for (const p of plan.products) {
		if (!images.has(p.image)) out.push(`product ${p.key}: image ${p.image} unknown`);
		for (const c of p.categories) if (!pcats.has(c)) out.push(`product ${p.key}: category ${c} unknown`);
		if (p.type === "simple" && !p.regularPrice) out.push(`product ${p.key}: simple product without a price`);
		if (p.type === "variable" && (!p.attribute || !p.variations?.length || p.variations.some((v) => !p.attribute?.options.includes(v.option)))) out.push(`product ${p.key}: variations do not match the attribute`);
	}
	for (const m of plan.menus) for (const i of m.items) if (i.page && i.page !== "woo:shop" && !pages.has(i.page)) out.push(`menu ${m.key}: page ${i.page} unknown`);
	const ids = JSON.stringify(plan.pages.map((p) => p.elementor ?? [])).match(/"id":"[0-9a-f]{7}"/g) ?? [];
	dup("elementor element id", ids);
	return out;
}
