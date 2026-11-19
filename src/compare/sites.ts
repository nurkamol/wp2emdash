/**
 * `wp2emdash compare <slugA> <slugB>`: content diff between two audited sites (e.g. two near-identical WordPress
 * installs of the same studio on two domains). Read-only, no network: it reads both audit snapshots
 * (snapshot/pages/*.json + snapshot/html/*.html) and writes sites/<slugB>/reports/compare/<slugA>.md + .json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FormSnapshot, PageSnapshot } from "../audit/page.js";
import { sitePaths } from "../core/paths.js";
import { sourceText, tokens } from "../transform/coverage.js";

/** Pages at or above this distinct-word similarity are a "minor" difference. */
export const MINOR = 0.98;
/** Lists in the report are capped so one very different page does not bury the rest. */
const CAP_WORDS = 40;
const CAP_SENTENCES = 12;

export interface SitePage {
	path: string;
	snap: PageSnapshot;
	/** Visible text the way transform/verify read it (chrome removed); falls back to the snapshot text without HTML. */
	text: string;
}

export interface FieldDiff {
	a?: string;
	b?: string;
}

export interface PageComparison {
	path: string;
	urlA: string;
	urlB: string;
	/** Distinct-word Jaccard similarity of the visible text (kit tokeniser), 0–1. */
	similarity: number;
	verdict: "identical" | "minor" | "differs";
	wordsOnlyA: string[];
	wordsOnlyB: string[];
	wordsOnlyACount: number;
	wordsOnlyBCount: number;
	sentencesOnlyA: string[];
	sentencesOnlyB: string[];
	meta: { title?: FieldDiff; description?: FieldDiff; canonical?: FieldDiff; h1?: FieldDiff };
	forms: { onlyA: string[]; onlyB: string[] };
	links: { onlyA: LinkRef[]; onlyB: LinkRef[] };
}

export interface LinkRef {
	href: string;
	kind: "booking" | "social" | "phone" | "email" | "other";
}

export interface SiteComparison {
	a: { slug: string; host: string; pages: number };
	b: { slug: string; host: string; pages: number };
	ranAt: string;
	onlyA: { path: string; url: string; title?: string; words: number }[];
	onlyB: { path: string; url: string; title?: string; words: number }[];
	pages: PageComparison[];
	summary: { matched: number; identical: number; minor: number; differs: number; onlyA: number; onlyB: number };
}

/** Path key for matching pages across two domains: lowercased path, no trailing slash, query kept (sorted). */
export function matchKey(url: string): string {
	const u = new URL(url);
	let decoded = u.pathname;
	try {
		decoded = decodeURI(u.pathname);
	} catch {
		/* malformed escape: keep as is */
	}
	let path = decoded.toLowerCase().replace(/\/+$/, "") || "/";
	path = path.replace(/\/{2,}/g, "/");
	const q = [...u.searchParams.entries()].sort(([x], [y]) => x.localeCompare(y));
	return q.length ? `${path}?${new URLSearchParams(q).toString()}` : path;
}

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const same = (a?: string, b?: string) => norm(a).toLowerCase() === norm(b).toLowerCase();
const bare = (host: string) => host.toLowerCase().replace(/^www\./, "");

/** Distinct-word Jaccard similarity (1 when both are empty). */
export function similarity(a: string[], b: string[]): number {
	const A = new Set(a);
	const B = new Set(b);
	if (!A.size && !B.size) return 1;
	let inter = 0;
	for (const w of A) if (B.has(w)) inter++;
	return inter / (A.size + B.size - inter);
}

/** Sentences of a text, keyed by their token sequence; only ones with 4+ words (single labels are noise). */
export function sentences(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const raw of text.split(/(?<=[.!?])\s+|\n+|\s{2,}/)) {
		const s = norm(raw);
		const t = tokens(s);
		if (t.length < 4) continue;
		const key = t.join(" ");
		if (!out.has(key)) out.set(key, s.length > 240 ? `${s.slice(0, 237)}…` : s);
	}
	return out;
}

const BOOKING = /calendly\.com|acuityscheduling\.com|as\.me|mindbody(online)?\.(com|io)|marianaiframes\.com|marianatek\.com|momence\.com|setmore\.com|simplybook\.(me|it)|fresha\.com|booksy\.com|vagaro\.com|janeapp\.com|cal\.com|zocdoc\.com|opentable\.|resy\.com|squareup\.com\/appointments|square\.site|book\.|booking|reserv|appointment|schedul/i;
const SOCIAL = /(^|\.)(facebook|instagram|linkedin|twitter|x|youtube|tiktok|pinterest|threads|wa)\.(com|net|me)|youtu\.be|wa\.me/i;

export function linkKind(href: string): LinkRef["kind"] {
	if (/^tel:/i.test(href)) return "phone";
	if (/^mailto:/i.test(href)) return "email";
	let host = "";
	try {
		host = new URL(href).hostname;
	} catch {
		return "other";
	}
	if (SOCIAL.test(host)) return "social";
	if (BOOKING.test(href)) return "booking";
	return "other";
}

/** External destinations of a page, with links to either compared domain treated as internal. */
function externalLinks(links: PageSnapshot["links"], hosts: Set<string>): Map<string, string> {
	const out = new Map<string, string>();
	for (const l of links) {
		if (l.internal) continue;
		if (!/^(https?:|tel:|mailto:)/i.test(l.href)) continue;
		if (/\/(wp-content|wp-includes)\//.test(l.href)) continue;
		let key = l.href.trim();
		if (/^https?:/i.test(key)) {
			try {
				const u = new URL(key);
				if (hosts.has(bare(u.hostname))) continue;
				key = `${bare(u.hostname)}${u.pathname.replace(/\/+$/, "")}${u.search}`.toLowerCase();
			} catch {
				continue;
			}
		} else key = key.toLowerCase().replace(/\s+/g, "");
		if (!out.has(key)) out.set(key, l.href);
	}
	return out;
}

/** A form's identity for comparison: provider, provider id and field types (names differ between installs). */
export function formKey(f: FormSnapshot): string {
	return `${f.provider}${f.providerFormId ? `#${f.providerFormId}` : ""} [${f.fields.map((x) => x.type).join(", ")}]`;
}

const canonicalPath = (c?: string) => {
	if (!c) return undefined;
	try {
		return matchKey(c);
	} catch {
		return c;
	}
};

export function comparePage(a: SitePage, b: SitePage, hosts: Set<string>): PageComparison {
	const ta = tokens(a.text);
	const tb = tokens(b.text);
	const A = new Set(ta);
	const B = new Set(tb);
	const onlyA = [...A].filter((w) => !B.has(w));
	const onlyB = [...B].filter((w) => !A.has(w));
	const sa = sentences(a.text);
	const sb = sentences(b.text);
	const meta: PageComparison["meta"] = {};
	if (!same(a.snap.seo.title, b.snap.seo.title)) meta.title = { a: a.snap.seo.title, b: b.snap.seo.title };
	if (!same(a.snap.seo.description, b.snap.seo.description)) meta.description = { a: a.snap.seo.description, b: b.snap.seo.description };
	// Each domain is canonical to itself: only a canonical pointing at another path is a difference.
	if (canonicalPath(a.snap.seo.canonical) !== canonicalPath(b.snap.seo.canonical)) meta.canonical = { a: a.snap.seo.canonical, b: b.snap.seo.canonical };
	const h1a = a.snap.headings.find((h) => h.level === 1)?.text;
	const h1b = b.snap.headings.find((h) => h.level === 1)?.text;
	if (!same(h1a, h1b)) meta.h1 = { a: h1a, b: h1b };
	const forms = (s: PageSnapshot) => new Set(s.forms.filter((f) => f.provider !== "wp-search").map(formKey));
	const fa = forms(a.snap);
	const fb = forms(b.snap);
	const la = externalLinks(a.snap.links, hosts);
	const lb = externalLinks(b.snap.links, hosts);
	const ref = (href: string): LinkRef => ({ href, kind: linkKind(href) });
	const sim = similarity(ta, tb);
	const cmp: PageComparison = {
		path: a.path,
		urlA: a.snap.url,
		urlB: b.snap.url,
		similarity: Math.round(sim * 10000) / 10000,
		verdict: "differs",
		wordsOnlyA: onlyA.slice(0, CAP_WORDS),
		wordsOnlyB: onlyB.slice(0, CAP_WORDS),
		wordsOnlyACount: onlyA.length,
		wordsOnlyBCount: onlyB.length,
		sentencesOnlyA: [...sa].filter(([k]) => !sb.has(k)).map(([, s]) => s).slice(0, CAP_SENTENCES),
		sentencesOnlyB: [...sb].filter(([k]) => !sa.has(k)).map(([, s]) => s).slice(0, CAP_SENTENCES),
		meta,
		forms: { onlyA: [...fa].filter((f) => !fb.has(f)), onlyB: [...fb].filter((f) => !fa.has(f)) },
		links: { onlyA: [...la].filter(([k]) => !lb.has(k)).map(([, h]) => ref(h)), onlyB: [...lb].filter(([k]) => !la.has(k)).map(([, h]) => ref(h)) },
	};
	const otherDiffs = Object.keys(meta).length + cmp.forms.onlyA.length + cmp.forms.onlyB.length + cmp.links.onlyA.length + cmp.links.onlyB.length;
	cmp.verdict = sim === 1 && otherDiffs === 0 ? "identical" : sim >= MINOR ? "minor" : "differs";
	return cmp;
}

/** Every snapshotted HTML page of an audited site. */
export function readSitePages(snapshotDir: string): SitePage[] {
	const dir = join(snapshotDir, "pages");
	if (!existsSync(dir)) return [];
	const out: SitePage[] = [];
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
		const snap = JSON.parse(readFileSync(join(dir, f), "utf8")) as PageSnapshot;
		if (snap.status && snap.status !== 200) continue;
		const htmlFile = join(snapshotDir, "html", f.replace(/\.json$/, ".html"));
		const text = existsSync(htmlFile) ? sourceText(readFileSync(htmlFile, "utf8")) : snap.text;
		out.push({ path: matchKey(snap.url), snap, text });
	}
	return out;
}

export function compareSites(slugA: string, a: SitePage[], slugB: string, b: SitePage[], hostA: string, hostB: string): SiteComparison {
	const mapA = new Map(a.map((p) => [p.path, p]));
	const mapB = new Map(b.map((p) => [p.path, p]));
	const hosts = new Set([bare(hostA), bare(hostB)]);
	const brief = (p: SitePage) => ({ path: p.path, url: p.snap.url, ...(p.snap.seo.title ? { title: p.snap.seo.title } : {}), words: p.snap.wordCount });
	const pages = [...mapA.values()].filter((p) => mapB.has(p.path)).map((p) => comparePage(p, mapB.get(p.path) as SitePage, hosts));
	// Most different first: those are the ones to read.
	pages.sort((x, y) => x.similarity - y.similarity || x.path.localeCompare(y.path));
	const onlyA = [...mapA.values()].filter((p) => !mapB.has(p.path)).map(brief);
	const onlyB = [...mapB.values()].filter((p) => !mapA.has(p.path)).map(brief);
	const count = (v: PageComparison["verdict"]) => pages.filter((p) => p.verdict === v).length;
	return {
		a: { slug: slugA, host: hostA, pages: a.length },
		b: { slug: slugB, host: hostB, pages: b.length },
		ranAt: new Date().toISOString(),
		onlyA,
		onlyB,
		pages,
		summary: { matched: pages.length, identical: count("identical"), minor: count("minor"), differs: count("differs"), onlyA: onlyA.length, onlyB: onlyB.length },
	};
}

const esc = (s: string | undefined) => norm(s).replace(/\|/g, "\\|") || "—";
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

export function compareReport(c: SiteComparison): string {
	const A = `${c.a.slug} (${c.a.host})`;
	const B = `${c.b.slug} (${c.b.host})`;
	const L: string[] = [];
	L.push(`# Content comparison — ${c.a.slug} vs ${c.b.slug}`, "");
	L.push(`Generated by \`wp2emdash compare ${c.a.slug} ${c.b.slug}\` on ${c.ranAt.slice(0, 10)} from the two audit snapshots (read-only).`);
	L.push(`A = ${A}, ${c.a.pages} pages · B = ${B}, ${c.b.pages} pages. Pages matched by path (case and trailing slash ignored).`);
	L.push(`Similarity = shared distinct words ÷ all distinct words of both pages (visible text, header/footer/menu removed). identical = 100% and same title, description, canonical path, H1, forms and external links; minor ≥ ${pct(MINOR)}; differs below.`, "");
	L.push("| | Pages |", "|---|---|");
	L.push(`| Matched | ${c.summary.matched} (identical ${c.summary.identical}, minor ${c.summary.minor}, differs ${c.summary.differs}) |`);
	L.push(`| Only on A | ${c.summary.onlyA} |`, `| Only on B | ${c.summary.onlyB} |`, "");
	L.push("Content that exists only on one site has to be merged into the primary deliberately (overrides.ts / decisions.md, or in the CMS after load) — the alias domain only redirects.", "");

	const only = (title: string, list: SiteComparison["onlyA"]) => {
		L.push(`## ${title} (${list.length})`, "");
		if (!list.length) return L.push("None.", "");
		L.push("| Path | Title | Words |", "|---|---|---|");
		for (const p of list) L.push(`| \`${p.path}\` | ${esc(p.title)} | ${p.words} |`);
		L.push("");
	};
	only(`Pages only on A — ${A}`, c.onlyA);
	only(`Pages only on B — ${B}`, c.onlyB);

	L.push(`## Matched pages (${c.pages.length})`, "");
	if (c.pages.length) {
		L.push("| Path | Similarity | Verdict | Differences |", "|---|---|---|---|");
		for (const p of c.pages) {
			const d = [...Object.keys(p.meta), ...(p.forms.onlyA.length + p.forms.onlyB.length ? ["forms"] : []), ...(p.links.onlyA.length + p.links.onlyB.length ? ["links"] : []), ...(p.wordsOnlyACount + p.wordsOnlyBCount ? [`words −${p.wordsOnlyACount}/+${p.wordsOnlyBCount}`] : [])];
			L.push(`| \`${p.path}\` | ${pct(p.similarity)} | ${p.verdict} | ${d.join(", ") || "—"} |`);
		}
		L.push("");
	}
	for (const p of c.pages.filter((x) => x.verdict !== "identical")) {
		L.push(`### \`${p.path}\` — ${p.verdict}, ${pct(p.similarity)}`, "");
		for (const [k, v] of Object.entries(p.meta)) L.push(`- **${k}**: A ${esc(v?.a)} · B ${esc(v?.b)}`);
		if (p.sentencesOnlyA.length) L.push(`- **Sentences only on A** (${p.sentencesOnlyA.length}${p.sentencesOnlyA.length >= CAP_SENTENCES ? "+" : ""}):`, ...p.sentencesOnlyA.map((s) => `  - ${s}`));
		if (p.sentencesOnlyB.length) L.push(`- **Sentences only on B** (${p.sentencesOnlyB.length}${p.sentencesOnlyB.length >= CAP_SENTENCES ? "+" : ""}):`, ...p.sentencesOnlyB.map((s) => `  - ${s}`));
		if (p.wordsOnlyACount) L.push(`- **Words only on A** (${p.wordsOnlyACount}): ${p.wordsOnlyA.join(", ")}${p.wordsOnlyACount > p.wordsOnlyA.length ? ", …" : ""}`);
		if (p.wordsOnlyBCount) L.push(`- **Words only on B** (${p.wordsOnlyBCount}): ${p.wordsOnlyB.join(", ")}${p.wordsOnlyBCount > p.wordsOnlyB.length ? ", …" : ""}`);
		if (p.forms.onlyA.length) L.push(`- **Forms only on A**: ${p.forms.onlyA.join("; ")}`);
		if (p.forms.onlyB.length) L.push(`- **Forms only on B**: ${p.forms.onlyB.join("; ")}`);
		if (p.links.onlyA.length) L.push(`- **External links only on A**: ${p.links.onlyA.map((l) => `${l.href} (${l.kind})`).join(", ")}`);
		if (p.links.onlyB.length) L.push(`- **External links only on B**: ${p.links.onlyB.map((l) => `${l.href} (${l.kind})`).join(", ")}`);
		L.push("");
	}
	return `${L.join("\n")}\n`;
}

export interface CompareResult {
	comparison: SiteComparison;
	md: string;
	json: string;
}

/** Reads both audit snapshots, compares them and writes the report to sites/<slugB>/reports/compare/<slugA>.{md,json}. */
export function compareCommand(slugA: string, slugB: string, sitesDir?: string): CompareResult {
	if (slugA === slugB) throw new Error("Compare two different sites");
	const pa = sitesDir ? sitePaths(slugA, sitesDir) : sitePaths(slugA);
	const pb = sitesDir ? sitePaths(slugB, sitesDir) : sitePaths(slugB);
	const a = readSitePages(pa.snapshot);
	const b = readSitePages(pb.snapshot);
	for (const [slug, pages, p] of [[slugA, a, pa], [slugB, b, pb]] as const) {
		if (!pages.length) throw new Error(`No audit snapshot for "${slug}" (${join(p.snapshot, "pages")}). Run \`wp2emdash run ${slug} audit\` first (read-only).`);
	}
	const host = (pages: SitePage[]) => new URL((pages.find((p) => p.path === "/") ?? (pages[0] as SitePage)).snap.url).host;
	const comparison = compareSites(slugA, a, slugB, b, host(a), host(b));
	const outDir = join(pb.reports, "compare");
	mkdirSync(outDir, { recursive: true });
	const md = join(outDir, `${slugA}.md`);
	const json = join(outDir, `${slugA}.json`);
	writeFileSync(md, compareReport(comparison));
	writeFileSync(json, `${JSON.stringify(comparison, null, 2)}\n`);
	return { comparison, md, json };
}

/** Short terminal table: the summary plus the least similar pages. */
export function compareTable(c: SiteComparison, max = 15): string {
	const rows = [
		`A ${c.a.slug} (${c.a.host}, ${c.a.pages} pages) · B ${c.b.slug} (${c.b.host}, ${c.b.pages} pages)`,
		`matched ${c.summary.matched}: identical ${c.summary.identical}, minor ${c.summary.minor}, differs ${c.summary.differs} · only on A ${c.summary.onlyA} · only on B ${c.summary.onlyB}`,
		"",
		`${"path".padEnd(40)} ${"similar".padStart(7)}  verdict`,
		...c.pages.slice(0, max).map((p) => `${(p.path.length > 40 ? `${p.path.slice(0, 39)}…` : p.path).padEnd(40)} ${pct(p.similarity).padStart(7)}  ${p.verdict}`),
	];
	if (c.pages.length > max) rows.push(`… ${c.pages.length - max} more in the report`);
	for (const p of c.onlyA.slice(0, 10)) rows.push(`only A  ${p.path}`);
	for (const p of c.onlyB.slice(0, 10)) rows.push(`only B  ${p.path}`);
	return rows.join("\n");
}
