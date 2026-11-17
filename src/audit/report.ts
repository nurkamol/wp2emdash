import type { KitConfig } from "../config/schema.js";
import type { LinkCheck, UrlRecord } from "../phases/audit.js";
import type { DesignCapture, ScreenshotResult } from "./browser.js";
import type { Discovery } from "./discover.js";
import type { Fingerprint } from "./fingerprint.js";
import { type HeaderScrollCapture, type MenuCapture, motionRecipe } from "./interactions.js";
import type { Integration } from "./integrations.js";
import type { PageSnapshot } from "./page.js";

export interface ReportContext {
	config: KitConfig;
	discovery: Discovery;
	records: UrlRecord[];
	pages: PageSnapshot[];
	linkChecks: LinkCheck[];
	brokenInternal: (UrlRecord | LinkCheck)[];
	brokenExternal: LinkCheck[];
	screens: ScreenshotResult[];
	design: DesignCapture[];
	fp: Fingerprint;
	integrations: Integration[];
	truncated: boolean;
}

const esc = (s: string | undefined) => (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const path = (u: string) => {
	try {
		const x = new URL(u);
		return `${x.pathname}${x.search}`;
	} catch {
		return u;
	}
};
const table = (head: string[], rows: (string | number | undefined)[][]) =>
	[`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.map((c) => esc(String(c ?? ""))).join(" | ")} |`)].join("\n");

export function auditReport(c: ReportContext): string {
	const pages = c.records.filter((r) => r.kind === "page");
	const bySource = (s: string) => new Set(c.records.filter((r) => r.sources.includes(s as never)).map((r) => r.url));
	const sitemap = bySource("sitemap");
	const rest = bySource("rest");
	const crawlOnly = c.records.filter((r) => r.sources.length === 1 && r.sources[0] === "crawl" && r.kind === "page");
	const notInSitemap = pages.filter((r) => !r.inSitemap && !r.noindex);
	const sitemapNot200 = c.records.filter((r) => r.inSitemap && r.status !== 200);
	const snap = new Map(c.pages.map((p) => [p.url, p]));
	const missingDesc = pages.filter((r) => !snap.get(r.url)?.seo.description);
	const missingAlt = c.pages.flatMap((p) => p.images.filter((i) => !i.alt?.trim()).map((i) => ({ page: path(p.url), src: i.src })));
	const multiH1 = c.pages.filter((p) => p.headings.filter((h) => h.level === 1).length !== 1);
	const leftovers = c.pages.filter((p) => p.shortcodeLeftovers.length);
	const home = c.design.find((d) => d.viewport !== "mobile");

	return `# Audit — ${c.config.name}

Source: ${c.config.source.url} · Generated ${new Date().toISOString()}
${c.truncated ? "\n> ⚠️ Crawl was truncated at `audit.maxUrls`. Results are incomplete.\n" : ""}
## Summary

| | |
|---|---|
| Theme | ${c.fp.childTheme ? `${c.fp.childTheme} (child of ${c.fp.parentTheme})` : (c.fp.parentTheme ?? "unknown")} |
| WordPress | ${c.fp.wordpressVersion ?? "hidden"} |
| Builders (pages using them) | ${Object.entries(c.fp.builders).map(([b, n]) => `${b} (${n})`).join(", ") || "none detected"} |
| URLs audited | ${c.records.length} — ${pages.length} pages, ${c.records.filter((r) => r.kind === "redirect").length} redirects, ${c.records.filter((r) => r.kind === "error").length} errors, ${c.records.filter((r) => r.kind === "non-html").length} non-HTML |
| Sitemaps | ${c.discovery.sitemaps.length} (${sitemap.size} URLs) |
| REST API | ${c.discovery.restAvailable ? `yes — ${c.discovery.types.map((t) => `${t.slug} ${t.count}`).join(", ")}; ${c.discovery.terms.length} terms; ${c.discovery.media.length} media` : "not available"} |
| Uploads served from | pages: ${c.fp.uploadsBase ?? "unknown"} · WordPress: ${c.fp.restUploadsBase ?? "unknown"}${c.fp.hiddenWpPaths ? ` — ⚠️ WordPress paths are rewritten (${c.fp.rewrittenPaths.join(", ")}); old media URLs under both bases need redirects` : ""} |
| Tracking IDs | ${[...new Set(c.pages.flatMap((p) => p.trackingIds))].join(", ") || "none"} |
| EmDash Exporter plugin | ${c.fp.emdashExporter ? "installed" : "not installed (needed for extract)"} |
| Plugins detected | ${c.fp.plugins.length} (see plugin-matrix.md) |
| Integrations | ${c.integrations.length} (see integrations.md) |
| Screenshots | ${c.screens.filter((s) => s.file).length}/${c.screens.length} |

## URL inventory

${table(
	["Path", "Status", "Kind", "Sources", "WP", "Sitemap", "noindex", "Screens"],
	c.records.map((r) => [r.path, r.status, r.kind === "redirect" ? `→ ${path(r.finalUrl)}` : r.kind, r.sources.join("+"), r.wp ? `${r.wp.type} #${r.wp.id}` : "", r.inSitemap ? "✓" : "", r.noindex ? "noindex" : "", r.screenshot ? "✓" : r.kind === "page" ? "✖" : ""]),
)}

## Reconciliation

- In sitemap: ${sitemap.size} · from REST: ${rest.size} · found only by crawling: ${crawlOnly.length}
${crawlOnly.length ? `- Crawl-only pages (not in sitemap or REST — check if intentional):\n${crawlOnly.map((r) => `  - ${r.path}`).join("\n")}` : ""}
${notInSitemap.length ? `- Indexable pages missing from the sitemap:\n${notInSitemap.map((r) => `  - ${r.path}`).join("\n")}` : "- Every indexable page is in the sitemap."}
${sitemapNot200.length ? `- Sitemap URLs not returning 200:\n${sitemapNot200.map((r) => `  - ${r.path} → ${r.status}${r.kind === "redirect" ? ` ${path(r.finalUrl)}` : ""}`).join("\n")}` : "- Every sitemap URL returns 200."}

## SEO per page

${table(
	["Path", "Title", "Description", "Canonical", "Robots", "H1", "JSON-LD", "Words"],
	pages.map((r) => {
		const p = snap.get(r.url);
		return [r.path, p?.seo.title, p?.seo.description ? `${p.seo.description.slice(0, 80)}${p.seo.description.length > 80 ? "…" : ""}` : "—", p?.seo.canonical ? path(p.seo.canonical) : "—", p?.seo.robots ?? "", p?.headings.filter((h) => h.level === 1).map((h) => h.text).join(" / ") || "—", p?.seo.jsonLdTypes.join(", "), p?.wordCount];
	}),
)}

## Findings on the source site (carried over or fixed in migration)

- Pages without meta description: ${missingDesc.length}${missingDesc.length ? ` (${missingDesc.slice(0, 10).map((r) => r.path).join(", ")})` : ""}
- Pages without exactly one H1: ${multiH1.length}${multiH1.length ? ` (${multiH1.slice(0, 10).map((p) => `${path(p.url)}: ${p.headings.filter((h) => h.level === 1).length}`).join(", ")})` : ""}
- Images without alt text: ${missingAlt.length}${missingAlt.length ? ` (first: ${missingAlt.slice(0, 5).map((m) => `${m.page} ${m.src.split("/").pop()}`).join(", ")})` : ""}
- Visible shortcode leftovers: ${leftovers.length ? leftovers.map((p) => `${path(p.url)} [${p.shortcodeLeftovers.join(", ")}]`).join("; ") : "none"}
- Broken internal links: ${c.brokenInternal.length}${c.brokenInternal.length ? `\n${c.brokenInternal.map((b) => `  - ${"href" in b ? path(b.href) : b.path} → ${b.status}${"foundOn" in b ? ` (on ${b.foundOn.join(", ")})` : ""}`).join("\n")}` : ""}
- External links not answering 2xx/3xx: ${c.brokenExternal.length}${c.brokenExternal.length ? `\n${c.brokenExternal.slice(0, 30).map((b) => `  - ${b.href} → ${b.status || b.error} (on ${b.foundOn.slice(0, 3).join(", ")})`).join("\n")}` : ""}

## Design snapshot (${home?.url ? path(home.url) : "home"}, ${home?.viewport ?? "desktop"})

${
	home
		? `- Fonts: ${home.fonts.slice(0, 5).map((f) => `${f.family} (${f.count})`).join("; ")}
- Text colours: ${home.colors.filter((x) => x.usage === "text").slice(0, 6).map((x) => x.value).join(", ")}
- Backgrounds: ${home.colors.filter((x) => x.usage === "background").slice(0, 6).map((x) => x.value).join(", ")}
- Container widths: ${home.containerWidths.map((w) => `${w.width}px`).join(", ") || "—"}
- Breakpoints in CSS: ${home.breakpoints.join(", ") || "—"}
- Header: ${home.header ? `${home.header.height}px, ${home.header.position}, ${home.header.background}` : "—"} · Footer: ${home.footer ? `${home.footer.height}px, ${home.footer.background}` : "—"}
- Logo: ${home.logo ? `${home.logo.src} (${home.logo.width}×${home.logo.height})` : "—"} · Favicon: ${home.favicon ?? "—"}

Type scale:

${table(
	["Element", "Family", "Size", "Weight", "Line height", "Colour"],
	Object.entries(home.typography)
		.filter(([, v]) => v)
		.map(([k, v]) => [k, v?.fontFamily.split(",")[0], v?.fontSize, v?.fontWeight, v?.lineHeight, v?.color]),
)}

Buttons:

${table(["Selector", "Text", "Background", "Colour", "Radius", "Size", "Font"], home.buttons.slice(0, 8).map((b) => [b.selector, b.text, `${b.styles.background}${b.styles.paintedBy === "pseudo-element" ? " (::before)" : ""}`, b.styles.color, b.styles.borderRadius, b.styles.size, `${b.styles.fontSize} ${b.styles.fontWeight} ${b.styles.textTransform}`]))}`
		: "Design capture failed — see run log."
}
`;
}

export function integrationsReport(c: ReportContext): string {
	const forms = c.integrations.filter((i) => i.kind === "form");
	const rest = c.integrations.filter((i) => i.kind !== "form");
	const formBlocks = forms
		.map((f) => {
			const form = f.form;
			if (!form) return "";
			return `### ${f.name}

- **Proposed:** ${f.proposed} — ${f.note ?? ""}
- **Appears on (${f.pageCount}):** ${f.pages.join(", ")}
- **Spam protection:** ${form.hasCaptcha.join(", ") || "none detected"} · **Submit label:** ${form.submitLabel ?? "—"} · **Method:** ${form.method ?? "—"}${form.inPopup ? " · inside a popup" : ""}
${form.sensitiveFields.length ? `- ⚠️ **Possibly sensitive fields:** ${form.sensitiveFields.join(", ")}\n` : ""}
${table(["Field", "Name", "Type", "Required", "Options / placeholder"], form.fields.map((x) => [x.label ?? "", x.name, x.type, x.required ? "yes" : "", x.options?.join(", ") ?? x.placeholder ?? ""]))}

Still needed from WordPress admin (extract phase): notification recipients, autoresponder text, success message/redirect, conditional logic, integrations (CRM/newsletter/webhooks).
`;
		})
		.join("\n");

	return `# Forms & integrations — ${c.config.name}

Each item has a proposed action. Confirm or change it in \`overrides.ts → integrations\` before the load phase.
Actions: **keep** (same provider/embed), **rebuild** (native section + Worker), **replace** (different tool), **drop**, **decide** (owner input needed).
${c.config.sensitiveData ? "\n> This site is marked `sensitiveData: true`: rebuilt forms never store or email fields flagged as sensitive.\n" : ""}
## Forms (${forms.length})

${formBlocks || "No forms found."}

## Other integrations (${rest.length})

${table(["Kind", "Name", "Proposed", "Pages", "Evidence", "Note"], rest.map((i) => [i.kind, i.name, i.proposed, i.pageCount, i.evidence[0]?.slice(0, 80), i.note]))}
`;
}

export function pluginMatrixReport(c: ReportContext): string {
	return `# Plugin replacement matrix — ${c.config.name}

Detected from public asset paths and REST namespaces. Plugins without public traces (admin-only, backups, security) won't appear here — confirm the full list in WordPress admin during extract.

${table(["Plugin", "Evidence", "Action", "Replacement"], c.fp.plugins.map((p) => [p.name, p.evidence.join(", "), p.action, p.replacement]))}

Theme: ${c.fp.themes.join(", ") || "unknown"}
`;
}

export function interactionsReport(c: { config: KitConfig; menus: MenuCapture[]; headers: HeaderScrollCapture[] }): string {
	const rel = (f?: string) => (f ? f.split("/snapshot/")[1] ?? f : "—");
	const menus = c.menus
		.map((m) => {
			if (!m.found) return `### ${m.viewport}\n\nNo menu toggle found — navigation is shown inline at this width.\n`;
			const anims = m.animations
				.sort((a, b) => a.delayMs - b.delayMs)
				.slice(0, 25)
				.map((a) => [a.target, a.kind, a.name, a.durationMs, a.delayMs, a.easing]);
			return `### ${m.viewport}

- **Toggle:** \`${m.toggle?.selector}\` "${m.toggle?.label}" at ${m.toggle?.rect.x},${m.toggle?.rect.y} (${m.toggle?.rect.width}×${m.toggle?.rect.height}) · ${m.toggle?.isButton ? "button" : "link (not a <button>)"} · aria-expanded ${m.toggle?.ariaExpandedBefore ?? "missing"} → ${m.toggle?.ariaExpandedAfter ?? "missing"}
- **Panel:** ${m.panel ? `${m.panel.type} \`${m.panel.selector}\` ${m.panel.rect.width}×${m.panel.rect.height} at x=${m.panel.rect.x}, background ${m.panel.background}, z-index ${m.panel.zIndex}` : "not identified"}
- **Overlay:** ${m.overlay ? `${m.overlay.background} (opacity ${m.overlay.opacity})` : "none"}
- **Open motion:** ${m.openDurationMs ? `${m.openDurationMs} ms total` : "unknown"}, ${m.animations.length} animation(s)
- **Motion recipe (used by the starter header):** \`${JSON.stringify(motionRecipe(m))}\`
- **Behaviour:** scroll lock ${m.behaviour.bodyScrollLocked ? "yes" : "no"} · focus moves into menu ${m.behaviour.focusMovedIntoPanel ? "yes" : "no"} · Esc closes ${m.behaviour.escCloses ? "yes" : "no"} · toggle closes ${m.behaviour.toggleClosesAgain ? "yes" : "no"}${m.behaviour.closeButton ? " · has close button" : ""}
- **Item style:** ${m.itemStyle ? `${m.itemStyle.fontFamily.split(",")[0]} ${m.itemStyle.fontSize}/${m.itemStyle.lineHeight} ${m.itemStyle.fontWeight} ${m.itemStyle.textTransform} ${m.itemStyle.color}` : "—"}
- **Files:** closed ${rel(m.files.closed)} · open ${rel(m.files.open)} · frames ${m.files.frames.map(rel).join(", ")} · video ${rel(m.files.video)}
${m.error ? `- ⚠️ Error: ${m.error}\n` : ""}${Object.keys(m.themeSettings).length ? `- **Theme settings (body data-*):** ${Object.entries(m.themeSettings).filter(([k]) => /slide|ocm|icon|header|anim|ca[de]|hhun|dropdown|button|ajax|loading|smooth|m-?animate/i.test(k)).map(([k, v]) => `${k}=${v}`).join(", ")}\n` : ""}
Items:

${table(["Text", "Link", "Depth"], m.items.map((i) => [i.text, i.href, i.depth]))}

Animations (what moves when the menu opens):

${anims.length ? table(["Target", "Kind", "Property / name", "Duration ms", "Delay ms", "Easing"], anims) : "None detected (instant show/hide)."}
`;
		})
		.join("\n");
	const headers = c.headers.map((h) => `- **${h.viewport}:** ${h.changes.length ? h.changes.join("; ") : "no change on scroll"} (${rel(h.files.top)}, ${rel(h.files.scrolled)})`).join("\n");
	const a11y = c.menus.filter((m) => m.found && (!m.toggle?.isButton || !m.toggle?.ariaExpandedAfter || !m.behaviour.escCloses || !m.behaviour.focusMovedIntoPanel));
	return `# Interactions — ${c.config.name}

How the navigation and header behave on the live site. The starter's header component reproduces the panel type, motion (durations, delays, easing) and item styling below; verify replays the same steps on staging and compares.

## Navigation menu

${menus}
## Header on scroll

${headers || "Not captured."}

## Accessibility gaps on the source (fixed in the rebuild, not copied)

${a11y.length ? a11y.map((m) => `- ${m.viewport}: ${[!m.toggle?.isButton && "toggle is not a <button>", !m.toggle?.ariaExpandedAfter && "no aria-expanded", !m.behaviour.escCloses && "Esc does not close", !m.behaviour.focusMovedIntoPanel && "focus stays behind the menu"].filter(Boolean).join(", ")}`).join("\n") : "None found."}
`;
}
