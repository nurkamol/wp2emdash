/**
 * The handover pack's shared catalogue: one plain-language line per section type (how an owner edits it in the admin)
 * and one entry per kit plugin (what it does, where it lives, who sees it). Owner-facing words only: no field slugs,
 * no Cloudflare terms. Labels come from the section library (src/starter/library.ts) so they match the admin.
 *
 * Facts about EmDash's admin (names, sign-in, roles): docs/spikes/handover-findings.md.
 */
import type { SectionType } from "../ir/schema.js";
import { ALL_BLOCK_TYPES, ANNOUNCEMENT_BLOCK, SECTION_BLOCK_PREFIX } from "../starter/library.js";

/** How to edit each section type, in one sentence. Every IR section type has an entry (checked by the type). */
export const SECTION_HOWTO: Record<SectionType, string> = {
	hero: "The big opening of a page. Change the heading, the short text and the buttons; swap the background picture or video in its image field.",
	rich_text: "Ordinary text. Type straight into it; use the toolbar for headings, bold, lists and links.",
	media_text: "A picture next to text. Replace the picture in its image field and choose which side it sits on.",
	columns: "Two to four columns side by side. Each column has its own text, picture and buttons.",
	feature_grid: "A grid of cards. Add, remove or drag cards in the Items list; each card has a picture or icon, a title, text and a link.",
	cta_banner: "A short message with buttons that invites visitors to act. Edit the heading, text and buttons.",
	faq: "Questions and answers. Add or reorder questions in the list; search engines can show them as FAQs.",
	pricing: "Prices or plans. Edit each plan's name, price, list of what is included and button.",
	testimonials: "Quotes from customers. Add a quote with the person's name, role and an optional photo.",
	team: "People with photo, role and a short bio. Add, remove or reorder people in the list.",
	gallery: "A set of pictures. Add, remove or drag pictures in the list; visitors can open them larger.",
	logo_strip: "A row of logos (clients, partners, press). Add a logo and, if you like, a link for it.",
	stats: "Key numbers. Edit each number and the label under it.",
	steps: "A numbered process. Edit each step's title and text; drag to change the order.",
	tabs: "Content in tabs. Edit each tab's label and its text.",
	video: "A video: upload a video file or paste a YouTube or Vimeo link, and choose a poster picture.",
	audio: "An audio player. Upload the audio file and add a caption.",
	posts_list: "Your newest blog posts. It updates by itself when you publish a post; choose how many to show.",
	product_grid: "Products from your shop. It updates by itself; choose newest, on sale, a category or hand-picked products.",
	form: "A contact form. Edit the heading and the text around it; the form's questions are set up by us — ask us to change them.",
	map: "A map. Paste a new map link or change the address shown.",
	embed: "A booking or other outside tool. The embed code comes from that service; ask us before changing it.",
	legacy_html: "Content carried over as it was from the old site. It still shows correctly; ask us if you want it rebuilt as a normal section.",
	announcement: "The thin bar above the header on every page. Edit the message, buttons, colours and optional start and end dates in Header & footer → announcement.",
};

/** The section's name as the admin shows it (the block type's label), e.g. "Image and text". */
export function sectionLabel(type: SectionType): string {
	const slug = type === "announcement" ? ANNOUNCEMENT_BLOCK : `${SECTION_BLOCK_PREFIX}${type}`;
	return ALL_BLOCK_TYPES.find((b) => b.slug === slug)?.label ?? (type === "announcement" ? "Announcement bar" : type.replace(/_/g, " "));
}

export type PluginId = "forms" | "seo" | "fixit" | "health" | "backups" | "consent" | "comments" | "change-requests" | "media" | "og" | "motion";

export interface PluginEntry {
	id: PluginId;
	/** The tool's name as the owner sees it. */
	name: string;
	/** Where it is in the admin. */
	where: string;
	/** Who can open it. */
	who: "Administrators" | "Editors and administrators";
	/** What it does, in one or two plain sentences. */
	what: string;
}

export const PLUGINS: Record<PluginId, PluginEntry> = {
	forms: { id: "forms", name: "Form messages", where: "Plugins → Form messages", who: "Administrators", what: "An inbox for messages sent through the site's forms, with search and export. Under Settings you choose who form messages are emailed to and can turn on a phone notification (Telegram or Slack)." },
	seo: { id: "seo", name: "SEO & Analytics", where: "Plugins → SEO, and the SEO panel at the bottom of the page editor's sidebar", who: "Editors and administrators", what: "A score for every page with what to improve, Google Search Console figures once connected, and your visitor statistics and tracking codes." },
	fixit: { id: "fixit", name: "SEO fix-it", where: "Plugins → SEO fix-it", who: "Editors and administrators", what: "Drafts missing page descriptions and search titles from each page's own text. Nothing changes until you approve a suggestion." },
	health: { id: "health", name: "Site health & monthly report", where: "Plugins → Site health", who: "Administrators", what: "Checks the site around the clock (is it up, can Google find it, do forms arrive, broken links, certificate, speed) and lists what to improve. A short report is emailed on the 1st of every month." },
	backups: { id: "backups", name: "Backups & restore", where: "Plugins → Backups", who: "Administrators", what: "A backup of all content every night. You can download a backup or put back the site settings, the menus or a single page, with a preview before anything changes." },
	consent: { id: "consent", name: "Cookie banner", where: "Plugins → Privacy & consent", who: "Administrators", what: "The cookie banner visitors see and which tools may run before they agree. Change the wording, the position and the privacy policy page here." },
	comments: { id: "comments", name: "Comments", where: "Comments (in the main menu)", who: "Editors and administrators", what: "Approve, answer or remove visitors' comments. New comments wait for approval as set up for your site." },
	"change-requests": { id: "change-requests", name: "Change requests", where: "Plugins → Change requests, and the Request a change panel in the page editor", who: "Editors and administrators", what: "Ask us for a change from inside the admin — pick the page, add a screenshot — and follow its status until it is done." },
	media: { id: "media", name: "Media assistant", where: "Plugins → Media", who: "Editors and administrators", what: "Finds pictures that are too large, missing descriptions (alt text) or unused, shrinks large files and suggests descriptions you review. Nothing is deleted without you." },
	og: { id: "og", name: "Sharing images", where: "Plugins → Sharing images", who: "Administrators", what: "The picture shown when a page is shared on social media or in messengers: your logo, the page title and your colours, made for each page automatically." },
	motion: { id: "motion", name: "Motion", where: "Plugins → Motion", who: "Administrators", what: "Optional effects such as page transitions, gentle entrance animations and a scroll progress bar. Everything starts off; turn on only what you like." },
};

/** What each EmDash role can do, in owner words (docs/spikes/handover-findings.md). */
export const ROLES: { role: "ADMIN" | "EDITOR" | "AUTHOR" | "CONTRIBUTOR"; label: string; can: string }[] = [
	{ role: "ADMIN", label: "Administrator", can: "Everything: content, menus, settings, people and the tools under Plugins." },
	{ role: "EDITOR", label: "Editor", can: "Edit and publish every page, post and picture; menus, widgets, sections and comments. Not site settings or people." },
	{ role: "AUTHOR", label: "Author", can: "Write, edit and publish their own pages and posts, and upload pictures." },
	{ role: "CONTRIBUTOR", label: "Contributor", can: "Write drafts; an editor or administrator publishes them." },
];

/** Cookie banner modes in owner words. */
export const CONSENT_MODES: Record<"off" | "notice" | "opt-in" | "auto", string> = {
	off: "The built-in banner is off (your site uses another cookie tool, or needs none).",
	notice: "Visitors see a notice; tools run unless they say no.",
	"opt-in": "Nothing that stores data runs until a visitor agrees.",
	auto: "Visitors from Europe, the UK, Switzerland and Québec are asked first; elsewhere they see a notice and can say no.",
};
