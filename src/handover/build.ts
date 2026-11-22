/**
 * The client handover pack: from what one site actually has (gathered by src/commands/handover.ts from kit.config, the
 * IR and the generated forms) to an owner-facing document, rendered as Markdown and as one self-contained, printable
 * HTML page (inline CSS, no scripts, no external requests).
 *
 * Pure: no file or network access here. Only what the owner may read goes in: role names and counts (never people),
 * the owner's own form recipients, never the agency's alert addresses, never form messages, never secrets.
 */
import type { SectionType } from "../ir/schema.js";
import { CONSENT_MODES, PLUGINS, type PluginEntry, ROLES, SECTION_HOWTO, sectionLabel } from "./catalogue.js";

export interface HandoverForm {
	id: string;
	title: string;
	/** Pages the form is on (paths). */
	pages: string[];
	/** The form has a file upload field. */
	uploads?: boolean;
}

export interface HandoverInput {
	name: string;
	slug: string;
	generatedAt: string;
	productionUrl: string;
	/** Traffic is on the new site (cutover recorded production.live). */
	live: boolean;
	/** Production's temporary workers.dev address (before go-live). */
	workersDevUrl?: string;
	/** The workers.dev address stays on after go-live. */
	keepWorkersDev?: boolean;
	/** Opt-in staging (a separate test copy) and its address. */
	staging?: { url?: string };
	aliasDomains: string[];
	sessionDays: number;
	/** kit.config email.provider ("emdash" = EmDash's own email, so email sign-in links work). */
	emailProvider: string;
	/** The owner's own form recipients (kit.config email.to). */
	emailTo: string[];
	/** Section types used anywhere on the site, with how often. */
	sections: { type: SectionType; count: number }[];
	pages: number;
	posts: number;
	/** Custom content collections (labels, e.g. "Classes"). */
	collections: string[];
	menus: { name: string; role: string; items: number; lang?: string }[];
	siteParts: { header: boolean; footer: boolean; announcement: boolean };
	popups: number;
	reusableSections: number;
	widgetAreas: number;
	protectedPages: number;
	multilingual?: string[];
	forms: HandoverForm[];
	/** Form messages inbox (kit.config forms.outbox): kept days; keepSent = every message, not only unsent ones. */
	formsInbox?: { days: number; keepSent: boolean };
	formChat: boolean;
	spamProtection: boolean;
	/** sensitiveData site: the note shown on forms. */
	sensitiveNotice?: string;
	plugins: {
		seo: boolean;
		fixit: boolean;
		health?: { reportTo: string[]; monthlyReport: boolean };
		backups?: { daily: number; monthly: number; restoreTestDays?: number; offsite: boolean };
		consent?: { mode: keyof typeof CONSENT_MODES };
		comments: boolean;
		changeRequests: boolean;
		media: boolean;
		og: boolean;
		motion: boolean;
	};
	/** People to invite from the old site, per EmDash role (counts only). */
	invites: Partial<Record<"ADMIN" | "EDITOR" | "AUTHOR" | "CONTRIBUTOR" | "SUBSCRIBER", number>>;
	/** The agency also watches the site from outside Cloudflare (the kit's outside-in monitor is set up). */
	outsideMonitor: boolean;
	monitorDays: number;
	keepWordPressDays: number;
	agency: { name: string; url: string; contact?: string };
}

export type Block = { p: string } | { list: string[] } | { steps: string[] } | { table: { head: string[]; rows: string[][] } } | { note: string };
export interface Chapter {
	id: string;
	title: string;
	blocks: Block[];
}
export interface HandoverModel {
	site: { name: string; slug: string; address: string; admin: string; live: boolean };
	generatedAt: string;
	agency: HandoverInput["agency"];
	chapters: Chapter[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const noSlash = (u: string) => u.replace(/\/+$/, "");
const host = (u: string) => {
	try {
		return new URL(u).host;
	} catch {
		return u;
	}
};
const FILL = "______________________";

export function buildHandover(i: HandoverInput): HandoverModel {
	const domain = noSlash(i.productionUrl);
	// Where the owner works today: the domain once live, else the temporary address (or the domain when not deployed).
	const now = i.live ? domain : noSlash(i.workersDevUrl ?? i.productionUrl);
	const admin = `${now}/_emdash/admin`;
	const chapters: Chapter[] = [];
	const add = (id: string, title: string, blocks: Block[]) => chapters.push({ id, title, blocks: blocks.filter(Boolean) });

	// ── Your website ────────────────────────────────────────────────────────────────────────────────────────
	const addr: string[][] = [];
	if (i.live) addr.push(["Your website", domain]);
	else {
		addr.push(["Your website (from launch day)", domain]);
		if (i.workersDevUrl) addr.push(["Preview address until launch", noSlash(i.workersDevUrl)]);
	}
	addr.push(["Admin (where you edit)", admin]);
	if (!i.live && i.workersDevUrl) addr.push(["Admin after launch", `${domain}/_emdash/admin`]);
	if (i.staging) addr.push(["Test copy (staging)", i.staging.url ? noSlash(i.staging.url) : "set up by us; we send you the address"]);
	for (const a of i.aliasDomains) addr.push(["Also forwards to your website", `${a} and www.${a}`]);
	add("site", "Your website", [
		{ p: `This pack explains how to look after **${i.name}**: signing in, editing, forms, the tools built into the admin, and who to call. It describes this site only.` },
		{ table: { head: ["What", "Address"], rows: addr } },
		...(i.live ? [] : [{ note: `The site is not on your domain yet. Until launch, everything happens on the preview address; on launch day ${host(domain)} switches over${i.keepWorkersDev ? "" : " and the preview address is switched off"}.` }]),
		...(i.staging ? [{ p: "The test copy has its own content: changes made there do not appear on your website. We use it to try larger changes before they go live." }] : []),
	]);

	// ── Signing in ──────────────────────────────────────────────────────────────────────────────────────────
	const emailLink = i.emailProvider === "emdash" ? "works on your site." : "works once email is set up in Settings → Email (ask us if the button says email is not configured).";
	add("sign-in", "Signing in", [
		{ p: `Open **${admin}**. There are no passwords: your old WordPress password does not move to the new site.` },
		{
			list: [
				"**Sign in with Passkey** — the usual way. Your phone, computer or security key confirms it is you (fingerprint, face or the device PIN). You create your passkey from the invitation we send you.",
				`**Sign in with email link** — a one-time link sent to your email address. It ${emailLink}`,
			],
		},
		{
			steps: [
				"Add a second passkey (for example on your phone) in **Settings → Security**, so losing one device never locks you out.",
				`You stay signed in for ${plural(i.sessionDays, "day")}; then you sign in again.`,
				"Never forward an invitation or sign-in link: each one is for one person.",
			],
		},
		...(i.live ? [] : [{ note: `Passkeys only work at the address where they were made. A passkey made on the preview address will not work on ${host(domain)}: after launch, sign in there with an email link (or a new invitation from us) and add a passkey for ${host(domain)}.` }]),
	]);

	// ── Who has access ──────────────────────────────────────────────────────────────────────────────────────
	const inviteRows = ROLES.map((r) => [r.label, r.can, i.invites[r.role] ? `${i.invites[r.role]} from your old site` : FILL]);
	const inviteTotal = ROLES.reduce((n, r) => n + (i.invites[r.role] ?? 0), 0);
	add("access", "Who has access", [
		{ p: "Each person has their own account and a role. Administrators add people in **Users → Invite** and can change a role or remove someone at any time." },
		{ table: { head: ["Role", "Can do", "People"], rows: inviteRows } },
		...(inviteTotal ? [{ p: `The team from your old WordPress site (${plural(inviteTotal, "person", "people")}) gets an invitation when you give us the go-ahead; WordPress subscribers are not invited.` }] : []),
		{ p: `If ${i.agency.name} has an account to look after the site, you see it in Users. Tell us if you want it changed or removed.` },
	]);

	// ── Editing ─────────────────────────────────────────────────────────────────────────────────────────────
	const content: string[] = [`**Pages** — ${plural(i.pages, "page")}. Each page is a list of sections; open a page to add, move or remove sections.`];
	if (i.posts) content.push(`**Posts** — ${plural(i.posts, "blog post")}, with categories, tags and authors. New posts appear on the blog and in “Latest posts” sections by themselves.`);
	for (const c of i.collections) content.push(`**${c}** — its own list in the admin menu; each entry has its own fields.`);
	if (i.protectedPages) content.push(`**Password-protected pages** — ${plural(i.protectedPages, "page")} ask visitors for a password. Change it in the page's Access password field; clear it to make the page public.`);
	if (i.multilingual?.length) content.push(`**Languages** — ${i.multilingual.join(", ")}. Each translation is its own page, linked to the others.`);
	add("editing", "Editing your pages", [
		{ list: content },
		{
			steps: [
				"Open the page under **Content → Pages** (or the post under Posts).",
				"Click into a section and change the text, pictures or buttons. Add a section with **Add block**; drag a section to move it.",
				"Use **Preview** to check, then **Publish**. Until you publish, your changes are a draft visitors do not see.",
				"Every page keeps its earlier versions under **Revisions**: you can go back to one if something goes wrong.",
			],
		},
		...(i.sections.length
			? [
					{ p: "The sections your site uses:" },
					{ table: { head: ["Section", "How to edit it"], rows: i.sections.map((s) => [sectionLabel(s.type), SECTION_HOWTO[s.type]]) } },
				]
			: []),
		{ p: "Fields with a size such as “40px” or “35%” keep the spacing of the old site. Leave them as they are unless you want to change the layout." },
	]);

	// ── Menus, header & footer, media ───────────────────────────────────────────────────────────────────────
	const parts: string[] = [];
	const MENU: Record<string, string> = { primary: "Main menu", secondary: "Secondary menu", footer: "Footer menu" };
	if (i.menus.length) parts.push(`**Menus** — ${i.menus.map((m) => `${MENU[m.role] ?? `“${m.name}”`}${m.lang ? ` (${m.lang})` : ""}: ${plural(m.items, "link")}`).join("; ")}. Add, rename or drag links; a link can point to a page or another website.`);
	const siteParts = [i.siteParts.header && "header", i.siteParts.footer && "footer", i.siteParts.announcement && "announcement bar"].filter(Boolean) as string[];
	if (siteParts.length) parts.push(`**Header & footer** — the ${siteParts.length > 1 ? `${siteParts.slice(0, -1).join(", ")} and ${siteParts.at(-1)}` : siteParts[0]} shown on every page. Edit once and every page changes.`);
	if (i.popups) parts.push(`**Popups** — ${plural(i.popups, "popup")}, opened by buttons or links on the site.`);
	if (i.reusableSections) parts.push(`**Sections** (admin menu) — ${plural(i.reusableSections, "reusable section")} used on several pages: edit one and it changes everywhere it is used.`);
	if (i.widgetAreas) parts.push(`**Widgets** — ${plural(i.widgetAreas, "widget area")} (sidebar or footer columns).`);
	parts.push("**Media Library** — every picture, video and document. Upload new files there or straight from an image field. Give each picture a short description (alt text): it is read aloud to people who cannot see it and helps Google.");
	parts.push("**Settings** — site title, logo, browser icon (General), social media profiles (Social Links) and search engine settings (SEO). Saving changes the live site straight away.");
	add("structure", "Menus, header & footer, pictures", [{ list: parts }, { p: "Changes show on the site within seconds of publishing. If a page still looks old after a minute, publish it again." }]);

	// ── Forms ───────────────────────────────────────────────────────────────────────────────────────────────
	if (i.forms.length) {
		const recipients = i.emailTo.length ? `Messages are emailed to: ${i.emailTo.join(", ")}.` : "No email recipient is set yet: tell us where form messages should go.";
		add("forms", "Forms", [
			{ table: { head: ["Form", "On"], rows: i.forms.map((f) => [f.title, f.pages.length ? f.pages.join(", ") : "not placed on a page yet"]) } },
			{ p: recipients },
			...(i.formsInbox
				? [{ p: `Every message${i.formsInbox.keepSent ? "" : " that could not be emailed"} is also kept in **Plugins → Form messages** for ${plural(i.formsInbox.days, "day")}${i.formsInbox.keepSent ? ", so it works as a full inbox" : ", and sent again automatically, so nothing is lost if email has a problem"}. Administrators change who receives form email under Form messages → Settings.${i.formChat ? " There you can also get a Telegram or Slack notification for each new message." : ""}` }]
				: []),
			...(i.spamProtection ? [{ p: "Spam protection (Cloudflare Turnstile) checks every message invisibly; real visitors rarely see a challenge." }] : []),
			...(i.forms.some((f) => f.uploads) ? [{ p: "Files sent with a form arrive as a download link in the email; the files and links are deleted after a while, so save what you need." }] : []),
			...(i.sensitiveNotice ? [{ note: `This site handles sensitive information. Forms ask only for what is needed and show this note: “${i.sensitiveNotice}”` }] : []),
			{ p: "Messages from the old WordPress forms stay in WordPress: export them from each form plugin before the old hosting ends. To change a form's questions, send a change request." },
		]);
	}

	// ── Built-in tools ──────────────────────────────────────────────────────────────────────────────────────
	const p = i.plugins;
	const tools: { entry: PluginEntry; extra?: string }[] = [];
	if (i.forms.length && i.formsInbox) tools.push({ entry: PLUGINS.forms });
	if (p.seo) tools.push({ entry: PLUGINS.seo });
	if (p.fixit) tools.push({ entry: PLUGINS.fixit });
	if (p.health) tools.push({ entry: PLUGINS.health, extra: p.health.monthlyReport ? (p.health.reportTo.length ? `The monthly report goes to ${p.health.reportTo.join(", ")}.` : "Tell us who should receive the monthly report.") : "The monthly report is switched off." });
	if (p.backups) tools.push({ entry: PLUGINS.backups, extra: `Every nightly backup is kept for ${plural(p.backups.daily, "day")}${p.backups.monthly ? `, plus one per month for ${plural(p.backups.monthly, "month")}` : ""}.${p.backups.restoreTestDays ? ` Every ${plural(p.backups.restoreTestDays, "day")} the newest backup is restored on a test copy to prove it works.` : ""}${p.backups.offsite ? " A second copy goes to separate storage." : ""}` });
	if (p.consent) tools.push({ entry: PLUGINS.consent, extra: `It starts as: ${CONSENT_MODES[p.consent.mode]}` });
	if (p.comments) tools.push({ entry: PLUGINS.comments });
	if (p.changeRequests) tools.push({ entry: PLUGINS["change-requests"] });
	if (p.media) tools.push({ entry: PLUGINS.media });
	if (p.og) tools.push({ entry: PLUGINS.og });
	if (p.motion) tools.push({ entry: PLUGINS.motion });
	if (tools.length)
		add("tools", "Tools in your admin", [
			{ p: "These tools are built into your site. You find them in the admin's menu." },
			{ table: { head: ["Tool", "What it does", "Where", "Who"], rows: tools.map((t) => [t.entry.name, t.extra ? `${t.entry.what} ${t.extra}` : t.entry.what, t.entry.where, t.entry.who]) } },
		]);

	// ── Monitoring ──────────────────────────────────────────────────────────────────────────────────────────
	const watch: string[] = [];
	if (p.health) watch.push(`Your site checks itself every few minutes: is it up, can search engines read it, do form messages go out, are links broken, is the security certificate valid. Problems are emailed to ${i.agency.name}, who act on them; you see the same checks in Plugins → Site health.`);
	if (p.backups) watch.push(`If a nightly backup or a restore test fails, ${i.agency.name} is alerted.`);
	if (i.outsideMonitor) watch.push(`${i.agency.name} also checks your site from outside, so we hear about an outage even if the site cannot report it.`);
	watch.push(`For ${plural(i.monitorDays, "day")} after launch we watch the site closely. The old WordPress site is kept, not public, for ${plural(i.keepWordPressDays, "day")} after launch in case anything needs to be fetched from it.`);
	add("monitoring", "Monitoring and alerts", [{ list: watch }]);

	// ── Who does what ───────────────────────────────────────────────────────────────────────────────────────
	add("responsibilities", "Who does what", [
		{
			table: {
				head: ["You", i.agency.name],
				rows: [
					["Text, pictures, pages and posts", "Hosting, security and updates of the site's software"],
					["Menus, header & footer, site settings", p.backups ? "Backups, restore tests and acting on alerts" : "Keeping your content safe and acting on alerts"],
					[i.forms.length ? "Answering form messages; choosing who receives them" : "Answering enquiries", "Changes to forms, layout, new section types"],
					["Inviting and removing people", "Domain and DNS changes, only with your approval"],
					[p.changeRequests ? "Asking for changes (Change requests)" : "Asking for changes", p.changeRequests ? "Replying to change requests and keeping their status up to date" : "Replying to change requests"],
					["Your domain name renewal, unless agreed otherwise", "Telling you before anything that affects your live site"],
				],
			},
		},
	]);

	// ── Support ─────────────────────────────────────────────────────────────────────────────────────────────
	add("support", "Support", [
		{
			table: {
				head: ["", ""],
				rows: [
					["Agency", i.agency.name],
					["Website", i.agency.url],
					["Contact", i.agency.contact ?? FILL],
					...(p.changeRequests ? [["Best way to ask for a change", "Plugins → Change requests in your admin"]] : []),
				],
			},
		},
	]);

	// ── If something breaks ─────────────────────────────────────────────────────────────────────────────────
	const fix: string[] = [
		"**The site looks down.** Check on another device or network first. If it is really down, we have usually been alerted already; contact us anyway.",
		`**A page looks wrong after an edit.** Open the page and go back to an earlier version under Revisions${p.backups ? ", or restore that one page in Plugins → Backups (you see a preview before anything changes)" : ""}.`,
	];
	if (i.forms.length) fix.push(`**Messages from your forms stop arriving.** Check your spam folder${i.formsInbox ? ", then Plugins → Form messages: messages that could not be emailed wait there" : ""}. Then contact us.`);
	fix.push("**You cannot sign in.** Use your second passkey or an email link. Otherwise an administrator (or we) can send you a new invitation.");
	fix.push("**Something else.** Note what you did, the page address and the time, and send it to us — a screenshot helps.");
	add("trouble", "If something breaks", [{ list: fix }, { p: "Never share a passkey or a sign-in link with anyone, including us: we never ask for them." }]);

	return { site: { name: i.name, slug: i.slug, address: i.live ? domain : now, admin, live: i.live }, generatedAt: i.generatedAt, agency: i.agency, chapters };
}

// ── Markdown ─────────────────────────────────────────────────────────────────────────────────────────────────
const mdCell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(m: HandoverModel): string {
	const out: string[] = [`# ${m.site.name} — website handover`, "", `Prepared by ${m.agency.name} · ${m.generatedAt.slice(0, 10)}`, ""];
	for (const c of m.chapters) {
		out.push(`## ${c.title}`, "");
		for (const b of c.blocks) {
			if ("p" in b) out.push(b.p, "");
			else if ("note" in b) out.push(`> ${b.note}`, "");
			else if ("list" in b) out.push(...b.list.map((x) => `- ${x}`), "");
			else if ("steps" in b) out.push(...b.steps.map((x, n) => `${n + 1}. ${x}`), "");
			else {
				const head = b.table.head.every((h) => !h) ? b.table.head.map(() => " ") : b.table.head;
				out.push(`| ${head.map(mdCell).join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...b.table.rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`), "");
			}
		}
	}
	out.push("---", "", `${m.agency.name} · ${m.agency.url}${m.agency.contact ? ` · ${m.agency.contact}` : ""}`, "");
	return out.join("\n");
}

// ── HTML ─────────────────────────────────────────────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** Escapes, then **bold** → <strong> and http(s) addresses → links (links are not requests: the page stays self-contained). */
const inline = (s: string) =>
	esc(s)
		.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
		.replace(/\bhttps?:\/\/[^\s<,;)]+[^\s<,;).]/g, (u) => `<a href="${u}">${u}</a>`);

const CSS = `
:root{--ink:#16181d;--muted:#5b6170;--line:#e3e5ea;--soft:#f5f6f8;--accent:#2f5bea;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 56px}
header{border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:24px}
header h1{margin:0 0 4px;font-size:28px;line-height:1.2;letter-spacing:-.01em}
header .meta{color:var(--muted);font-size:13px}
nav{background:var(--soft);border-radius:8px;padding:12px 16px;margin:0 0 8px}
nav ol{margin:0;padding-left:20px;columns:2;column-gap:32px}
h2{font-size:19px;margin:36px 0 12px;padding-top:4px;border-top:1px solid var(--line)}
p{margin:0 0 10px}
ul,ol{margin:0 0 12px;padding-left:22px}
li{margin:0 0 6px}
.note{border-left:4px solid var(--accent);background:var(--soft);border-radius:6px;padding:10px 14px;margin:0 0 12px}
.table{width:100%;overflow-x:auto;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
td:first-child{font-weight:600}
a{color:var(--accent);word-break:break-word}
footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
@media print{main{padding:0;max-width:none}nav{display:none}h2{break-after:avoid}table,.note,li{break-inside:avoid}a{color:inherit;text-decoration:none}@page{margin:16mm}}
`;

export function renderHtml(m: HandoverModel): string {
	const body: string[] = [];
	body.push(`<header><h1>${esc(m.site.name)} — website handover</h1><div class="meta">Prepared by <strong>${esc(m.agency.name)}</strong> · ${esc(m.generatedAt.slice(0, 10))}</div></header>`);
	body.push(`<nav aria-label="Contents"><ol>${m.chapters.map((c) => `<li><a href="#${c.id}">${esc(c.title)}</a></li>`).join("")}</ol></nav>`);
	for (const c of m.chapters) {
		body.push(`<section id="${c.id}"><h2>${esc(c.title)}</h2>`);
		for (const b of c.blocks) {
			if ("p" in b) body.push(`<p>${inline(b.p)}</p>`);
			else if ("note" in b) body.push(`<p class="note">${inline(b.note)}</p>`);
			else if ("list" in b) body.push(`<ul>${b.list.map((x) => `<li>${inline(x)}</li>`).join("")}</ul>`);
			else if ("steps" in b) body.push(`<ol>${b.steps.map((x) => `<li>${inline(x)}</li>`).join("")}</ol>`);
			else {
				const head = b.table.head.some(Boolean) ? `<thead><tr>${b.table.head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead>` : "";
				body.push(`<div class="table"><table>${head}<tbody>${b.table.rows.map((r) => `<tr>${r.map((x) => `<td>${inline(x)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
			}
		}
		body.push("</section>");
	}
	body.push(`<footer>${esc(m.agency.name)} · ${inline(m.agency.url)}${m.agency.contact ? ` · ${esc(m.agency.contact)}` : ""}</footer>`);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">
<title>${esc(m.site.name)} — handover</title>
<style>${CSS}</style>
</head>
<body>
<main>
${body.join("\n")}
</main>
</body>
</html>
`;
}
