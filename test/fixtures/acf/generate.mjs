// Generates test/fixtures/acf/site.json and database.sql (synthetic ACF site, no real data): node test/fixtures/acf/generate.mjs test/fixtures/acf
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const out = process.argv[2];
const ser = (v) => {
	if (v === null || v === undefined) return "N;";
	if (typeof v === "boolean") return `b:${v ? 1 : 0};`;
	if (typeof v === "number") return Number.isInteger(v) ? `i:${v};` : `d:${v};`;
	if (typeof v === "string") return `s:${Buffer.byteLength(v, "utf8")}:"${v}";`;
	const entries = Array.isArray(v) ? v.map((x, i) => [i, x]) : Object.entries(v);
	return `a:${entries.length}:{${entries.map(([k, x]) => `${typeof k === "number" ? `i:${k};` : ser(k)}${ser(x)}`).join("")}}`;
};
const H = "https://acf.example.test";
const up = (f) => `${H}/wp-content/uploads/2024/06/${f}`;
const media = [
	[51, "hero.jpg"], [52, "team-photo.jpg"], [53, "icon-brand.png"], [54, "harbor-cover.jpg"], [55, "harbor-1.jpg"], [56, "harbor-2.jpg"], [57, "city-cover.jpg"], [60, "harbor-brochure.pdf"],
].map(([id, f]) => ({ id, url: up(f), file: `2024/06/${f}`, inLibrary: true, referencedBy: [] }));

const page = (id, slug, title, content, meta, extra = {}) => ({ id, post_type: "page", status: "publish", slug, title, content, excerpt: "", date_gmt: "2024-06-01 10:00:00", modified_gmt: "2024-06-02 10:00:00", parent: null, menu_order: 0, taxonomies: {}, meta, permalink: `${H}/${slug === "home" ? "" : `${slug}/`}`, ...extra });

// ── Field definitions as ACF's own configuration posts (acf-field-group / acf-field, settings PHP-serialized) ──
let nextId = 920;
const fieldPost = (parent, menu_order, key, name, label, settings) => ({ id: nextId++, post_type: "acf-field", status: "publish", slug: key, title: label, excerpt: name, content: ser(settings), parent, menu_order, meta: {}, taxonomies: {} });
const groups = [
	{ id: 900, post_type: "acf-field-group", status: "publish", slug: "group_page_sections", title: "Page sections", content: ser({ location: [[{ param: "post_type", operator: "==", value: "page" }]], position: "normal" }), excerpt: "page-sections", parent: null, menu_order: 0, meta: {}, taxonomies: {} },
	{ id: 910, post_type: "acf-field-group", status: "publish", slug: "group_home_extras", title: "Home extras", content: ser({ location: [[{ param: "page_type", operator: "==", value: "front_page" }]] }), excerpt: "home-extras", parent: null, menu_order: 0, meta: {}, taxonomies: {} },
];
const layouts = {
	layout_hero: { key: "layout_hero", name: "hero", label: "Hero", display: "block" },
	layout_ti: { key: "layout_ti", name: "text_image", label: "Text and image", display: "block" },
	layout_feat: { key: "layout_feat", name: "features", label: "Features", display: "block" },
	layout_faq: { key: "layout_faq", name: "faq", label: "FAQ", display: "block" },
	layout_tst: { key: "layout_tst", name: "testimonials", label: "Testimonials", display: "block" },
	layout_text: { key: "layout_text", name: "text_block", label: "Text", display: "block" },
	layout_work: { key: "layout_work", name: "latest_work", label: "Latest work", display: "block" },
};
const flex = { id: 901, post_type: "acf-field", status: "publish", slug: "field_sections", title: "Page sections", excerpt: "page_sections", content: ser({ type: "flexible_content", layouts, button_label: "Add section" }), parent: 900, menu_order: 0, meta: {}, taxonomies: {} };
const fields = [flex];
const sub = (layout, order, key, name, label, settings) => {
	const f = fieldPost(901, order, key, name, label, { ...settings, parent_layout: layout });
	fields.push(f);
	return f;
};
sub("layout_hero", 0, "field_hero_title", "title", "Title", { type: "text" });
sub("layout_hero", 1, "field_hero_sub", "subtitle", "Subtitle", { type: "text" });
sub("layout_hero", 2, "field_hero_img", "image", "Image", { type: "image", return_format: "array" });
sub("layout_hero", 3, "field_hero_btn", "button", "Button", { type: "link" });
sub("layout_ti", 0, "field_ti_heading", "heading", "Heading", { type: "text" });
sub("layout_ti", 1, "field_ti_content", "content", "Content", { type: "wysiwyg" });
sub("layout_ti", 2, "field_ti_image", "image", "Image", { type: "image" });
sub("layout_ti", 3, "field_ti_pos", "image_position", "Image position", { type: "select", choices: { left: "Left", right: "Right" } });
sub("layout_feat", 0, "field_feat_heading", "heading", "Heading", { type: "text" });
const cards = sub("layout_feat", 1, "field_feat_cards", "cards", "Cards", { type: "repeater" });
fields.push(fieldPost(cards.id, 0, "field_card_title", "title", "Title", { type: "text" }), fieldPost(cards.id, 1, "field_card_text", "text", "Text", { type: "textarea" }), fieldPost(cards.id, 2, "field_card_icon", "icon", "Icon", { type: "image" }), fieldPost(cards.id, 3, "field_card_link", "link", "Link", { type: "link" }));
sub("layout_faq", 0, "field_faq_heading", "heading", "Heading", { type: "text" });
const items = sub("layout_faq", 1, "field_faq_items", "items", "Questions", { type: "repeater" });
fields.push(fieldPost(items.id, 0, "field_faq_q", "question", "Question", { type: "text" }), fieldPost(items.id, 1, "field_faq_a", "answer", "Answer", { type: "wysiwyg" }));
sub("layout_tst", 0, "field_tst_heading", "heading", "Heading", { type: "text" });
const quotes = sub("layout_tst", 1, "field_tst_quotes", "quotes", "Quotes", { type: "repeater" });
fields.push(fieldPost(quotes.id, 0, "field_tst_quote", "quote", "Quote", { type: "textarea" }), fieldPost(quotes.id, 1, "field_tst_name", "name", "Name", { type: "text" }), fieldPost(quotes.id, 2, "field_tst_role", "role", "Role", { type: "text" }));
sub("layout_text", 0, "field_text_content", "content", "Content", { type: "wysiwyg" });
sub("layout_work", 0, "field_work_projects", "projects", "Projects", { type: "relationship", post_type: ["project"] });
sub("layout_work", 1, "field_work_style", "style", "Style", { type: "select", choices: { light: "Light", dark: "Dark" } });
fields.push(fieldPost(910, 0, "field_hero_note", "hero_note", "Note above the footer", { type: "text" }));

// ── Pages ──
const home = page(10, "home", "Home", "", {
	page_sections: ser(["hero", "text_image", "features", "faq", "testimonials", "hero"]),
	_page_sections: "field_sections",
	_page_sections_layout_meta: { disabled: [5], renamed: [] },
	page_sections_0_title: "Design that works",
	page_sections_0_subtitle: "A small studio for brave brands",
	page_sections_0_image: "51",
	page_sections_0_button: { title: "See our work", url: `${H}/work/`, target: "" },
	page_sections_1_heading: "Who we are",
	page_sections_1_content: "<p>We are a <strong>small team</strong>.</p>\n<p>Second paragraph.</p>",
	page_sections_1_image: "52",
	page_sections_1_image_position: "left",
	page_sections_2_heading: "What we do",
	page_sections_2_cards: "3",
	page_sections_2_cards_0_title: "Brand",
	page_sections_2_cards_0_text: "Identity and voice.",
	page_sections_2_cards_0_icon: "53",
	page_sections_2_cards_0_link: ser({ title: "Read more", url: "/brand/", target: "" }),
	page_sections_2_cards_1_title: "Web",
	page_sections_2_cards_1_text: "Sites that load fast.",
	page_sections_2_cards_2_title: "Print",
	page_sections_2_cards_2_text: "Things you can hold.",
	page_sections_3_heading: "Questions",
	page_sections_3_items: "2",
	page_sections_3_items_0_question: "How long does a site take?",
	page_sections_3_items_0_answer: "<p>Six to ten weeks.</p>",
	page_sections_3_items_1_question: "Do you host?",
	page_sections_3_items_1_answer: "<p>Yes, on Cloudflare.</p>",
	page_sections_4_heading: "Kind words",
	page_sections_4_quotes: "1",
	page_sections_4_quotes_0_quote: "They listened.\n\nThen they delivered.",
	page_sections_4_quotes_0_name: "A. Client",
	page_sections_4_quotes_0_role: "Founder, Example Co",
	page_sections_5_title: "Old hero (disabled)",
	hero_note: "Shown above the footer",
	_hero_note: "field_hero_note",
});
const about = page(11, "about", "About", "<!-- wp:paragraph --><p>About us.</p><!-- /wp:paragraph -->", {}, {
	acf: { page_sections: [{ acf_fc_layout: "text_block", content: "<p>Our story began in a garage.</p>" }, { acf_fc_layout: "latest_work", projects: [201], style: "dark" }] },
});

// ── Posts ──
const post = { id: 30, post_type: "post", status: "publish", slug: "hello", title: "Hello", content: "Hello from the studio.", excerpt: "", date_gmt: "2024-06-03 10:00:00", modified_gmt: "2024-06-03 10:00:00", parent: null, menu_order: 0, taxonomies: { category: [{ id: 1, name: "News", slug: "news" }] }, meta: { reading_time: "4", _reading_time: "field_reading_time" }, permalink: `${H}/hello/` };

// ── Custom post type `project` (definitions from an ACF export file) ──
const projectGroup = {
	key: "group_project",
	title: "Project",
	location: [[{ param: "post_type", operator: "==", value: "project" }]],
	fields: [
		{ key: "field_cover", label: "Cover", name: "cover", type: "image" },
		{ key: "field_summary", label: "Summary", name: "summary", type: "wysiwyg" },
		{ key: "field_status", label: "Status", name: "status", type: "select", choices: { planning: "Planning", live: "Live" } },
		{ key: "field_featured", label: "Featured", name: "featured", type: "true_false" },
		{ key: "field_services", label: "Services", name: "services", type: "checkbox", choices: { brand: "Brand", web: "Web", print: "Print" } },
		{ key: "field_launched", label: "Launched", name: "launched_at", type: "date_time_picker", return_format: "d/m/Y g:i a" },
		{ key: "field_opening", label: "Office opens", name: "opening_time", type: "time_picker" },
		{ key: "field_website", label: "Website", name: "website", type: "link" },
		{ key: "field_brochure", label: "Brochure", name: "brochure", type: "file" },
		{ key: "field_lead_page", label: "Landing page", name: "lead_page", type: "post_object", post_type: ["page"] },
		{ key: "field_related", label: "Related projects", name: "related_projects", type: "relationship", post_type: ["project"] },
		{ key: "field_contact", label: "Contact", name: "contact", type: "group", sub_fields: [{ key: "field_c_email", label: "E-mail", name: "email", type: "email" }, { key: "field_c_phone", label: "Phone", name: "phone", type: "text" }] },
		{
			key: "field_milestones",
			label: "Milestones",
			name: "milestones",
			type: "repeater",
			sub_fields: [
				{ key: "field_m_title", label: "Title", name: "title", type: "text" },
				{ key: "field_m_due", label: "Due", name: "due", type: "date_picker", return_format: "d/m/Y" },
				{ key: "field_m_link", label: "Link", name: "link", type: "link" },
				{ key: "field_m_details", label: "Details", name: "details", type: "group", sub_fields: [{ key: "field_m_budget", label: "Budget", name: "budget", type: "number" }, { key: "field_m_owner", label: "Owner", name: "owner", type: "text" }] },
			],
		},
		{
			key: "field_blocks",
			label: "Blocks",
			name: "blocks",
			type: "flexible_content",
			layouts: {
				layout_gal: { key: "layout_gal", name: "gallery_block", label: "Gallery", sub_fields: [{ key: "field_b_images", label: "Images", name: "images", type: "gallery" }] },
				layout_quote: { key: "layout_quote", name: "quote", label: "Quote", sub_fields: [{ key: "field_b_quote", label: "Quote", name: "quote", type: "textarea" }, { key: "field_b_author", label: "Author", name: "author", type: "text" }] },
				layout_map: { key: "layout_map", name: "map_block", label: "Map", sub_fields: [{ key: "field_b_loc", label: "Location", name: "location", type: "google_map" }] },
			},
		},
	],
};
const optionsGroup = {
	key: "group_site_settings",
	title: "Site settings",
	location: [[{ param: "options_page", operator: "==", value: "site-settings" }]],
	fields: [
		{ key: "field_o_phone", label: "Phone", name: "phone", type: "text" },
		{ key: "field_o_footer", label: "Footer text", name: "footer_text", type: "textarea" },
		{ key: "field_o_social", label: "Social links", name: "social_links", type: "repeater", sub_fields: [{ key: "field_o_net", label: "Network", name: "network", type: "select", choices: { instagram: "Instagram", linkedin: "LinkedIn" } }, { key: "field_o_url", label: "URL", name: "url", type: "url" }] },
		{ key: "field_o_smtp", label: "SMTP password", name: "smtp_password", type: "password" },
	],
};
const postGroup = { key: "group_post", title: "Post extras", location: [[{ param: "post_type", operator: "==", value: "post" }]], fields: [{ key: "field_reading_time", label: "Reading time", name: "reading_time", type: "number" }] };

const project = (id, slug, title, meta, extra = {}) => ({ id, post_type: "project", status: "publish", slug, title, content: "", excerpt: "", date_gmt: "2024-06-05 10:00:00", modified_gmt: "2024-06-05 10:00:00", parent: null, menu_order: 0, taxonomies: {}, meta, permalink: `${H}/project/${slug}/`, ...extra });
const projects = [
	project(201, "harbor-rebrand", "Harbor rebrand", {
		cover: "54",
		summary: "<p>A rebrand for a harbour.</p>",
		status: "live",
		featured: "1",
		services: ser(["brand", "web"]),
		launched_at: "2024-06-01 09:30:00",
		opening_time: "09:00:00",
		website: ser({ title: "Visit the site", url: "https://harbor.example.org/", target: "_blank" }),
		brochure: "60",
		lead_page: "11",
		related_projects: ["202"],
		contact: "",
		contact_email: "hi@harbor.example.org",
		contact_phone: "+1 555 0101",
		milestones: "2",
		milestones_0_title: "Kickoff",
		milestones_0_due: "20240105",
		milestones_0_link: { title: "Notes", url: `${H}/notes/`, target: "" },
		milestones_0_details: "",
		milestones_0_details_budget: "1000",
		milestones_0_details_owner: "Sam",
		milestones_1_title: "Launch",
		milestones_1_due: "20240601",
		milestones_1_details_budget: "5000",
		milestones_1_details_owner: "Alex",
		blocks: ser(["gallery_block", "quote", "map_block"]),
		blocks_0_images: ["55", "56"],
		blocks_1_quote: "Best harbour ever.",
		blocks_1_author: "Harbour master",
		blocks_2_location: { address: "1 Pier Road, Example City", lat: "51.5", lng: "-0.1" },
	}),
	project(202, "city-site", "City site", { milestones: "1", milestones_0_title: "Discovery", milestones_0_due: "20250110", status: "planning" }, {
		acf: {
			cover: { type: "image", id: 57, url: up("city-cover.jpg"), alt: "City skyline" },
			status: "planning",
			featured: false,
			services: ["web"],
			website: { title: "", url: "https://city.example.org/", target: "" },
			related_projects: [201],
			milestones: [{ title: "Discovery", due: "10/01/2025", link: null, details: { budget: "", owner: "" } }],
			blocks: [{ acf_fc_layout: "quote", quote: "Fast and calm.", author: "City CTO" }, { acf_fc_layout: "poll_widget", question: "Which colour?" }],
		},
	}),
];

const site = {
	$comment: "Synthetic WordPress site with Advanced Custom Fields: a page built from a flexible content field (field definitions as ACF's acf-field posts, values in post meta, one row disabled), a page with get_fields() values and an unmapped layout, a post with an ACF field, a custom post type `project` (repeater with link and group sub-fields, flexible content, group, link, true/false, checkbox, select, date/time pickers, image, file, relationship, post object) defined by an ACF export file, and an options page. Generated; no real data.",
	options: { blogname: "Example Agency", show_on_front: "page", page_on_front: 10, posts_per_page: 10, permalink_structure: "/%postname%/" },
	pages: [home, about],
	posts: [post],
	project: projects,
	acfFieldGroups: groups,
	acfFields: fields,
	taxonomies: [{ name: "category", label: "Categories", label_singular: "Category", hierarchical: true, post_types: ["post"], terms: [{ id: 1, name: "News", slug: "news", description: "", parent: null, count: 1 }] }],
	analyze: {
		post_types: [
			{ name: "page", label: "Pages", label_singular: "Page", total: 2, supports: { title: true, editor: true }, taxonomies: [], hierarchical: true, has_archive: false, custom_fields: [] },
			{ name: "post", label: "Posts", label_singular: "Post", total: 1, supports: { title: true, editor: true }, taxonomies: ["category"], hierarchical: false, has_archive: false, custom_fields: [] },
			{ name: "project", label: "Projects", label_singular: "Project", total: 2, supports: { title: true, editor: true }, taxonomies: [], hierarchical: false, has_archive: true, custom_fields: [] },
		],
		acf: [],
		authors: [],
		attachments: media.length,
	},
	types: {
		page: { slug: "page", name: "Pages", rest_base: "pages", hierarchical: true, has_archive: false, viewable: true },
		post: { slug: "post", name: "Posts", rest_base: "posts", hierarchical: false, has_archive: false, viewable: true },
		project: { slug: "project", name: "Projects", rest_base: "project", hierarchical: false, has_archive: true, viewable: true },
	},
	fieldDefinitions: {
		"acf-project.json": { provider: "acf", file: "acf-export-2024-06-01.json", data: [projectGroup, optionsGroup, postGroup] },
	},
	acfOptions: {
		values: {
			options_phone: "+1 555 0100",
			options_footer_text: "Made in Example City",
			options_social_links: "2",
			options_social_links_0_network: "instagram",
			options_social_links_0_url: "https://instagram.com/example",
			options_social_links_1_network: "linkedin",
			options_social_links_1_url: "https://linkedin.com/company/example",
			options_legacy_banner: "Summer sale",
		},
	},
	media,
	urls: [
		{ url: `${H}/`, path: "/", status: 200, kind: "page", wp: { id: 10, type: "page" } },
		{ url: `${H}/about/`, path: "/about/", status: 200, kind: "page", wp: { id: 11, type: "page" } },
		{ url: `${H}/project/harbor-rebrand/`, path: "/project/harbor-rebrand/", status: 200, kind: "page", wp: { id: 201, type: "project" } },
	],
	discovery: { items: [{ id: 201, type: "project", link: `${H}/project/harbor-rebrand/` }, { id: 202, type: "project", link: `${H}/project/city-site/` }], terms: [], authors: [], media: [] },
};
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "site.json"), `${JSON.stringify(site, null, "\t")}\n`);

// A database dump with ACF options rows (and rows that must not be read).
const q = (s) => `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
const rows = [
	["blogname", "Example Agency"],
	["options_phone", "+1 555 0100"],
	["_options_phone", "field_o_phone"],
	["options_footer_text", "Made in Example City"],
	["options_social_links", "1"],
	["options_social_links_0_network", "instagram"],
	["options_social_links_0_url", "https://instagram.com/example"],
	["options_maps_api_key", "not-read"],
	["options_smtp_password", "not-read"],
	["mailserver_pass", "not-read"],
];
const sql = `-- Synthetic dump for test/acf.test.ts: ACF options page values (options_*), a credential-like option that must be left out. No real site data.
CREATE TABLE \`wp_options\` (
  \`option_id\` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  \`option_name\` varchar(191) NOT NULL DEFAULT '',
  \`option_value\` longtext NOT NULL,
  \`autoload\` varchar(20) NOT NULL DEFAULT 'yes',
  PRIMARY KEY (\`option_id\`)
) ENGINE=InnoDB;
INSERT INTO \`wp_options\` VALUES ${rows.map(([n, v], i) => `(${i + 1},${q(n)},${q(v)},'yes')`).join(",")};
`;
writeFileSync(join(out, "database.sql"), sql);
