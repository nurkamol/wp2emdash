/**
 * The monthly report: what happened on the site last month, in plain words — availability and incidents, speed and
 * real-visitor Core Web Vitals, visits, top pages and referrers (Cloudflare Web Analytics, when the read token is
 * set), how many form messages arrived (counts only), content published and updated, broken links found and fixed,
 * and the average SEO score. Built once on the 1st from what the checks stored (`buildReport`, pure), kept for 12
 * months, emailed as HTML with a plain-text part, shown in the admin and downloadable as a print-friendly page.
 * No personal data: no form contents, no names or addresses of visitors.
 */
import type { HealthBrand } from "./index.js";
import type { Cwv, DayRow, Incident, LinkLedger } from "./store.js";
import { type Rating, RATING_LABEL, rate, missingText } from "./checks/speed.js";
import { duration, esc, median, monthName, monthRange, plural } from "./util.js";

export interface ReportVisits {
	visits: number;
	pageViews: number;
	pages: { path: string; views: number }[];
	referrers: { host: string; views: number }[];
}

export interface ReportData {
	v: 1;
	month: string;
	generatedAt: string;
	site: { name: string; url: string };
	uptime: { pct?: number; probes: number; fails: number; downMinutes: number; incidents: { title: string; startedAt: string; endedAt?: string; minutes?: number }[] };
	speed: { ttfbMedian?: number; cwv?: { lcp?: number; inp?: number; cls?: number; at: string }; cwvNote?: string };
	visits?: ReportVisits;
	visitsNote?: string;
	forms?: { total: number; emailed: number; kept: number };
	formsNote?: string;
	content: { published: number; updated: number; items: { title: string; what: "published" | "updated"; day: string }[] };
	links: { found: number; fixed: number; open: number };
	seo?: { average: number; pages: number };
	seoNote?: string;
}

export interface ReportInputs {
	month: string;
	site: { name: string; url: string };
	history: DayRow[];
	incidents: Incident[];
	/** Latest CrUX answer (used when no history row of the month carries one). */
	cwv?: Cwv | null;
	ledger: LinkLedger;
	visits?: ReportVisits | { missing: string };
	forms?: { total: number; emailed: number; kept: number } | { missing: string };
	content: { items: { title: string; publishedAt?: string | null; updatedAt?: string; createdAt?: string }[] };
	seo?: { average: number; pages: number } | { missing: string };
	now: number;
}

const inMonth = (iso: string | null | undefined, since: number, until: number) => {
	const t = iso ? Date.parse(iso) : Number.NaN;
	return Number.isFinite(t) && t >= since && t < until;
};

export function buildReport(i: ReportInputs): ReportData {
	const { since, until } = monthRange(i.month);
	const days = i.history.filter((r) => r.d.startsWith(i.month));
	const probes = days.reduce((n, r) => n + r.probes, 0);
	const fails = days.reduce((n, r) => n + r.fails, 0);
	const overlapping = i.incidents.filter((x) => Date.parse(x.startedAt) < until && (!x.endedAt || Date.parse(x.endedAt) >= since) && (x.kind === "down" || x.kind === "page"));
	const clipped = (x: Incident) => Math.max(0, Math.min(x.endedAt ? Date.parse(x.endedAt) : i.now, until) - Math.max(Date.parse(x.startedAt), since));
	const downMinutes = Math.round(overlapping.filter((x) => x.kind === "down").reduce((n, x) => n + clipped(x), 0) / 60_000);
	const cwvRow = [...days].reverse().find((r) => r.lcp !== undefined || r.inp !== undefined || r.cls !== undefined);
	const cwv = cwvRow ? { ...(cwvRow.lcp !== undefined ? { lcp: cwvRow.lcp } : {}), ...(cwvRow.inp !== undefined ? { inp: cwvRow.inp } : {}), ...(cwvRow.cls !== undefined ? { cls: cwvRow.cls } : {}), at: cwvRow.d } : i.cwv && !i.cwv.missing && inMonth(i.cwv.at, since, until + 3 * 86_400_000) ? { ...(i.cwv.lcp !== undefined ? { lcp: i.cwv.lcp } : {}), ...(i.cwv.inp !== undefined ? { inp: i.cwv.inp } : {}), ...(i.cwv.cls !== undefined ? { cls: i.cwv.cls } : {}), at: i.cwv.at.slice(0, 10) } : undefined;
	const ttfbMedian = median(days.flatMap((r) => (r.ttfb50 !== undefined ? [r.ttfb50] : [])));
	// EmDash keeps one publishedAt and one updatedAt per entry: "published" = its publish date falls in the month,
	// "updated" = saved in the month and not published in it. A page edited several times counts once.
	const published = i.content.items.filter((c) => inMonth(c.publishedAt, since, until));
	const pubSet = new Set(published);
	const updated = i.content.items.filter((c) => !pubSet.has(c) && inMonth(c.updatedAt, since, until));
	const ledger = Object.values(i.ledger);
	return {
		v: 1,
		month: i.month,
		generatedAt: new Date(i.now).toISOString(),
		site: i.site,
		uptime: {
			...(probes ? { pct: Math.round(((probes - fails) / probes) * 10_000) / 100 } : {}),
			probes,
			fails,
			downMinutes,
			incidents: overlapping.slice(0, 20).map((x) => ({ title: x.title, startedAt: x.startedAt, ...(x.endedAt ? { endedAt: x.endedAt, minutes: Math.round((Date.parse(x.endedAt) - Date.parse(x.startedAt)) / 60_000) } : {}) })),
		},
		speed: { ...(ttfbMedian !== undefined ? { ttfbMedian } : {}), ...(cwv ? { cwv } : { cwvNote: missingText(i.cwv?.missing ?? "not-enough-data") }) },
		...(i.visits && "visits" in i.visits ? { visits: { visits: i.visits.visits, pageViews: i.visits.pageViews, pages: i.visits.pages.slice(0, 10), referrers: i.visits.referrers.slice(0, 5) } } : { visitsNote: i.visits && "missing" in i.visits ? i.visits.missing : "Visits are not set up for this site." }),
		...(i.forms && "total" in i.forms ? { forms: i.forms } : { formsNote: i.forms && "missing" in i.forms ? i.forms.missing : "Form messages are emailed directly and not counted on this site." }),
		content: {
			published: published.length,
			updated: updated.length,
			items: [...published.map((c) => ({ title: c.title, what: "published" as const, day: (c.publishedAt as string).slice(0, 10) })), ...updated.map((c) => ({ title: c.title, what: "updated" as const, day: (c.updatedAt as string).slice(0, 10) }))].sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 10),
		},
		links: { found: ledger.filter((e) => inMonth(e.first, since, until)).length, fixed: ledger.filter((e) => inMonth(e.fixed, since, until)).length, open: ledger.filter((e) => !e.fixed).length },
		...(i.seo && "average" in i.seo ? { seo: i.seo } : i.seo && "missing" in i.seo ? { seoNote: i.seo.missing } : {}),
	};
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────────────────────

const HEX = /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i;
const colour = (v: string | undefined, fallback: string) => (v && HEX.test(v.trim()) ? v.trim() : fallback);
const n = (v: number) => v.toLocaleString("en-US");
const RATING_COLOUR: Record<Rating, string> = { good: "#067647", "needs-improvement": "#b54708", poor: "#b42318" };

/** One-line summary for the email preview and the admin list. */
export function headline(r: ReportData): string {
	const up = r.uptime.pct !== undefined ? `${r.uptime.pct}% uptime` : "uptime not measured";
	const inc = r.uptime.incidents.filter((i) => /down/i.test(i.title)).length;
	return `${up}${inc ? `, ${plural(inc, "outage")}` : ", no outages"}${r.visits ? `, ${n(r.visits.visits)} visits` : ""}${r.forms ? `, ${plural(r.forms.total, "form message")}` : ""}.`;
}

interface Row {
	label: string;
	value: string;
	note?: string;
	tone?: string;
}

function cwvRows(r: ReportData): Row[] {
	const c = r.speed.cwv;
	if (!c) return [];
	const row = (label: string, metric: "lcp" | "inp" | "cls", v: number | undefined, text: (v: number) => string): Row[] => (v === undefined ? [] : [{ label, value: text(v), note: RATING_LABEL[rate(metric, v)], tone: RATING_COLOUR[rate(metric, v)] }]);
	return [...row("Largest Contentful Paint (loading)", "lcp", c.lcp, (v) => `${(v / 1000).toFixed(1)} s`), ...row("Interaction to Next Paint (responsiveness)", "inp", c.inp, (v) => `${v} ms`), ...row("Cumulative Layout Shift (visual stability)", "cls", c.cls, (v) => v.toFixed(2))];
}

/** The report as an HTML email / printable page (inline styles: mail apps drop most CSS; @media print for paper). */
export function renderReportHtml(r: ReportData, brand: HealthBrand): string {
	const accent = colour(brand.colors?.accent, "#1f2937");
	const text = colour(brand.colors?.text, "#1a1a1a");
	const name = esc(r.site.name);
	const logo = brand.logo && /^https:\/\/[^\s"'<>]+\.(?:png|jpe?g|webp|gif)(?:\?[^\s"'<>]*)?$/i.test(brand.logo) ? `<img src="${esc(brand.logo)}" alt="${name}" style="max-height:48px;max-width:220px;display:block">` : `<div style="font-size:20px;font-weight:700;color:${text}">${name}</div>`;
	const h2 = (t: string) => `<h2 style="margin:28px 0 10px;font-size:17px;color:${accent};border-bottom:2px solid ${accent};padding-bottom:4px">${esc(t)}</h2>`;
	const p = (t: string, style = "") => `<p style="margin:0 0 10px;${style}">${esc(t)}</p>`;
	const rows = (list: Row[]) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 8px">${list.map((x) => `<tr><td style="padding:7px 0;border-bottom:1px solid #eee">${esc(x.label)}</td><td style="padding:7px 0;border-bottom:1px solid #eee;text-align:right;font-weight:600;white-space:nowrap">${esc(x.value)}${x.note ? ` <span style="font-weight:400;color:${x.tone ?? "#667085"}">${esc(x.note)}</span>` : ""}</td></tr>`).join("")}</table>`;
	const big = (items: { label: string; value: string }[]) => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:8px 0;margin:8px -8px 4px"><tr>${items.map((x) => `<td style="background:#f6f6f4;border-radius:8px;padding:14px 12px;text-align:center;width:${Math.floor(100 / items.length)}%"><div style="font-size:22px;font-weight:700;color:${accent}">${esc(x.value)}</div><div style="font-size:12px;color:#667085">${esc(x.label)}</div></td>`).join("")}</tr></table>`;
	const up = r.uptime;
	const parts: string[] = [];
	parts.push(big([{ label: "Uptime", value: up.pct !== undefined ? `${up.pct}%` : "—" }, { label: "Visits", value: r.visits ? n(r.visits.visits) : "—" }, { label: "Form messages", value: r.forms ? n(r.forms.total) : "—" }, { label: "Pages published or updated", value: n(r.content.published + r.content.updated) }]));
	parts.push(h2("Availability"));
	parts.push(up.probes ? p(`The site was checked every 5 minutes (${n(up.probes)} checks) and answered ${up.pct}% of the time.${up.downMinutes ? ` It was unavailable for ${duration(up.downMinutes * 60_000)} in total.` : ""}`) : p("Availability was not measured this month."));
	parts.push(up.incidents.length ? rows(up.incidents.map((i) => ({ label: `${i.title} — ${i.startedAt.slice(0, 10)} ${i.startedAt.slice(11, 16)} UTC`, value: i.minutes !== undefined ? duration(i.minutes * 60_000) : "still open" }))) : p("No outages or page errors.", "color:#067647"));
	parts.push(h2("Speed"));
	const cw = cwvRows(r);
	parts.push(cw.length ? `${p(`How fast the site felt to real Chrome visitors (Google's measurement for the 28 days up to ${r.speed.cwv?.at}, 75th percentile — the level Google uses for search):`)}${rows(cw)}` : p(r.speed.cwvNote ?? "Real-visitor speed is not available."));
	if (r.speed.ttfbMedian !== undefined) parts.push(p(`Building a page took ${r.speed.ttfbMedian} ms on a typical day; most visitors get a ready-made copy from Cloudflare's cache, which is faster.`, "color:#667085;font-size:13px"));
	parts.push(h2("Visitors"));
	if (r.visits) {
		parts.push(rows([{ label: "Visits", value: n(r.visits.visits) }, { label: "Page views", value: n(r.visits.pageViews) }]));
		if (r.visits.pages.length) parts.push(`${p("Most viewed pages:", "font-weight:600")}${rows(r.visits.pages.slice(0, 5).map((x) => ({ label: x.path, value: n(x.views) })))}`);
		if (r.visits.referrers.length) parts.push(`${p("Where visitors came from:", "font-weight:600")}${rows(r.visits.referrers.map((x) => ({ label: x.host, value: n(x.views) })))}`);
		parts.push(p("Counted by Cloudflare Web Analytics: no cookies, no personal data.", "color:#667085;font-size:13px"));
	} else parts.push(p(r.visitsNote ?? "Visits are not set up."));
	parts.push(h2("Form messages"));
	parts.push(r.forms ? p(r.forms.total ? `${plural(r.forms.total, "message")} arrived through the website's forms${r.forms.kept ? ` (${r.forms.kept} waited in the outbox before they could be emailed)` : ""}. Only the number is reported here, never what anyone wrote.` : "No messages arrived through the website's forms.") : p(r.formsNote ?? "Not counted."));
	parts.push(h2("Content"));
	parts.push(p(r.content.published || r.content.updated ? `${plural(r.content.published, "page")} published and ${plural(r.content.updated, "page")} updated.` : "No pages were published or changed."));
	if (r.content.items.length) parts.push(rows(r.content.items.map((c) => ({ label: c.title, value: `${c.what === "published" ? "Published" : "Updated"} ${c.day}` }))));
	parts.push(h2("Links and search"));
	parts.push(rows([{ label: "Broken links found this month", value: n(r.links.found) }, { label: "Broken links fixed this month", value: n(r.links.fixed) }, { label: "Broken links still open", value: n(r.links.open), ...(r.links.open ? { note: "see Site health", tone: "#b54708" } : {}) }, ...(r.seo ? [{ label: `Average SEO score (${plural(r.seo.pages, "page")})`, value: `${r.seo.average}/100` }] : [])]));
	if (!r.seo && r.seoNote) parts.push(p(r.seoNote, "color:#667085;font-size:13px"));
	const title = `${r.site.name} — website report, ${monthName(r.month)}`;
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>@media print{body{background:#fff!important;padding:0!important}.sheet{box-shadow:none!important;border:0!important;max-width:none!important}a{color:inherit}}@page{margin:16mm}</style></head>
<body style="margin:0;padding:24px 12px;background:#f6f6f4;font:15px/1.5 -apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:${text}">
<table role="presentation" class="sheet" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;margin:0 auto;background:#fff;border-radius:10px;border-top:6px solid ${accent}">
<tr><td style="padding:28px 28px 8px">${logo}<h1 style="margin:18px 0 4px;font-size:24px;color:${text}">Website report — ${esc(monthName(r.month))}</h1>
<p style="margin:0;color:#667085">${esc(r.site.url.replace(/^https?:\/\//, "").replace(/\/$/, ""))} · ${esc(headline(r))}</p></td></tr>
<tr><td style="padding:0 28px 24px">${parts.join("\n")}</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eee;font-size:12px;color:#667085">${brand.footer ? `${esc(brand.footer)} · ` : ""}Generated ${esc(r.generatedAt.slice(0, 10))} · All times UTC</td></tr>
</table></body></html>
`;
}

/** The report email: subject, plain-text part and the HTML page. */
export function reportMail(r: ReportData, o: { brand: HealthBrand }): { subject: string; text: string; html: string } {
	return { subject: `${r.site.name}: website report for ${monthName(r.month)}`, text: renderReportText(r, o.brand), html: renderReportHtml(r, o.brand) };
}

export function renderReportText(r: ReportData, brand: HealthBrand): string {
	const up = r.uptime;
	const lines = [
		`${r.site.name} — website report, ${monthName(r.month)}`,
		r.site.url,
		"",
		headline(r),
		"",
		"AVAILABILITY",
		up.probes ? `Checked every 5 minutes (${n(up.probes)} checks); answered ${up.pct}% of the time.${up.downMinutes ? ` Unavailable for ${duration(up.downMinutes * 60_000)} in total.` : ""}` : "Not measured this month.",
		...(up.incidents.length ? up.incidents.map((i) => `- ${i.title}, ${i.startedAt.slice(0, 16).replace("T", " ")} UTC, ${i.minutes !== undefined ? duration(i.minutes * 60_000) : "still open"}`) : ["No outages or page errors."]),
		"",
		"SPEED",
		...(cwvRows(r).length ? cwvRows(r).map((x) => `- ${x.label}: ${x.value} (${x.note})`) : [r.speed.cwvNote ?? ""]),
		...(r.speed.ttfbMedian !== undefined ? [`Building a page: ${r.speed.ttfbMedian} ms on a typical day.`] : []),
		"",
		"VISITORS",
		...(r.visits ? [`Visits: ${n(r.visits.visits)}; page views: ${n(r.visits.pageViews)}.`, ...r.visits.pages.slice(0, 5).map((x) => `- ${x.path}: ${n(x.views)}`), ...(r.visits.referrers.length ? [`From: ${r.visits.referrers.map((x) => `${x.host} (${n(x.views)})`).join(", ")}`] : [])] : [r.visitsNote ?? ""]),
		"",
		"FORM MESSAGES",
		r.forms ? `${plural(r.forms.total, "message")} (count only).` : (r.formsNote ?? ""),
		"",
		"CONTENT",
		`${plural(r.content.published, "page")} published, ${plural(r.content.updated, "page")} updated.`,
		...r.content.items.map((c) => `- ${c.title}: ${c.what} ${c.day}`),
		"",
		"LINKS AND SEARCH",
		`Broken links: ${r.links.found} found, ${r.links.fixed} fixed, ${r.links.open} still open.`,
		...(r.seo ? [`Average SEO score: ${r.seo.average}/100 (${plural(r.seo.pages, "page")}).`] : []),
		...(brand.footer ? ["", brand.footer] : []),
	];
	return `${lines.join("\n")}\n`;
}
