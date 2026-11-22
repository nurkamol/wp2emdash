/**
 * What the end-to-end test checks beyond the kit's own gates: the migrated output holds what the seed put into
 * WordPress (e2e/lib/plan.ts → expected). Pure functions over a site folder and fetched HTML, so they are unit-tested
 * against a fake site (test/e2e-wordpress.test.ts) without Docker.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SeedExpectations } from "./plan.js";

export interface Assertion {
	id: string;
	label: string;
	ok: boolean;
	detail?: string;
	/** Not evaluated (its input does not exist because an earlier step failed); never counts as a pass. */
	skipped?: boolean;
}

interface IrDocLite {
	file: string;
	kind?: string;
	source?: { wpId?: number; type?: string; slug?: string; status?: string; builder?: string };
	route?: { path?: string; isFrontPage?: boolean };
	i18n?: { lang?: string; group?: string };
	sections?: { type?: string; fields?: { formRef?: { provider?: string; id?: string } } }[];
	diagnostics?: { level?: string; code?: string; message?: string; path?: string; carriesContent?: boolean; tag?: string }[];
	entry?: { collection?: string };
}

const readJson = <T>(file: string): T | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
};

function jsonFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir).flatMap((f) => {
		const p = join(dir, f);
		return statSync(p).isDirectory() ? jsonFiles(p) : f.endsWith(".json") ? [p] : [];
	});
}

/** Every routable IR document (pages, posts, custom post type entries), with its file. */
export function irDocs(irDir: string): IrDocLite[] {
	return ["pages", "posts", "entries"].flatMap((d) => jsonFiles(join(irDir, d)).map((file) => ({ ...(readJson<IrDocLite>(file) ?? {}), file })));
}

const norm = (p: string) => (p.endsWith("/") ? p : `${p}/`);

export interface AssertionInput {
	siteRoot: string;
	/** Where the generated project is (sitePaths().project). */
	project: string;
	expected: SeedExpectations;
	/** Allowed Elementor diagnostics, as "<slug>:<code>" or "<slug>:<code>:<tag>" (e2e/expectations.json). */
	allowedElementorDiagnostics?: string[];
}

export function outputAssertions(i: AssertionInput): Assertion[] {
	const ir = join(i.siteRoot, "ir");
	const out: Assertion[] = [];
	const add = (id: string, label: string, ok: boolean, detail?: string) => out.push({ id, label, ok, ...(detail ? { detail } : {}) });
	if (!existsSync(join(ir, "site.json"))) {
		const why = "no transform output (ir/site.json): see the transform phase above";
		for (const [id, label] of ASSERTION_LABELS) out.push({ id, label, ok: false, skipped: true, detail: why });
		return out;
	}
	const docs = irDocs(ir);
	const byPath = new Map(docs.filter((d) => d.route?.path).map((d) => [norm(d.route?.path as string), d]));
	const label = (id: string) => ASSERTION_LABELS.get(id) as string;

	// Routes: every seeded page, post and product kept its address.
	const missingRoutes = i.expected.routes.filter((r) => !byPath.has(norm(r.path)));
	add("routes", label("routes"), missingRoutes.length === 0, missingRoutes.length ? `missing: ${missingRoutes.map((r) => `${r.kind} ${r.path}`).join(", ")}` : `${i.expected.routes.length} addresses`);

	// Products collection (WooCommerce catalogue mode).
	const collections = readJson<{ collections?: { slug: string; type: string; shop?: unknown }[] }>(join(ir, "collections.json"));
	const shopCol = collections?.collections?.find((c) => c.shop);
	const entries = shopCol ? docs.filter((d) => d.file.includes(`${join("entries", shopCol.slug)}`)) : [];
	const entrySlugs = new Set(entries.map((e) => e.source?.slug));
	const missingProducts = i.expected.products.filter((p) => !entrySlugs.has(p.slug));
	add(
		"products-collection",
		label("products-collection"),
		!!shopCol && missingProducts.length === 0,
		!shopCol ? `no shop collection in ir/collections.json (${(collections?.collections ?? []).map((c) => c.slug).join(", ") || "none"})` : missingProducts.length ? `${shopCol.slug}: missing ${missingProducts.map((p) => p.slug).join(", ")}` : `${shopCol.slug}: ${entries.length} entries (${i.expected.products.length} seeded)`,
	);
	// Variable products: every variation option reaches the entry.
	const varProblems = i.expected.products
		.filter((p) => p.type === "variable")
		.flatMap((p) => {
			const e = entries.find((x) => x.source?.slug === p.slug);
			if (!e) return [`${p.slug}: no entry`];
			const text = readFileSync(e.file, "utf8");
			const variants = (text.match(/"(?:variations|variants)"\s*:\s*\[/g) ?? []).length;
			return variants ? [] : [`${p.slug}: no variations/variants list in the entry`];
		});
	add("variable-products", label("variable-products"), varProblems.length === 0, varProblems.join("; ") || `${i.expected.products.filter((p) => p.type === "variable").length} variable products carry their variations`);
	const shop = readJson<{ facts?: { products?: number; variations?: number; onSale?: number }; listing?: string; checkout?: string }>(join(ir, "shop.json"));
	const seededOnSale = i.expected.products.filter((p) => p.onSale).length;
	add(
		"shop-facts",
		label("shop-facts"),
		!!shop?.facts && shop.facts.products === i.expected.products.length && (shop.facts.onSale ?? 0) >= 1,
		shop?.facts ? `products ${shop.facts.products}/${i.expected.products.length}, on sale ${shop.facts.onSale} (seeded ${seededOnSale}), variations ${shop.facts.variations}, listing ${shop.listing ?? "?"}, checkout ${shop.checkout ?? "?"}` : "no ir/shop.json",
	);

	// Elementor pages: built from _elementor_data, nothing unmapped beyond the allowed list.
	const allowed = new Set(i.allowedElementorDiagnostics ?? []);
	const elProblems: string[] = [];
	const elInfo: string[] = [];
	for (const slug of i.expected.elementorSlugs) {
		const d = docs.find((x) => x.source?.slug === slug && x.kind !== "entry");
		if (!d) {
			elProblems.push(`${slug}: no IR page`);
			continue;
		}
		if (d.source?.builder !== "elementor") elProblems.push(`${slug}: builder ${d.source?.builder ?? "?"} (expected elementor)`);
		const blocking = (d.diagnostics ?? []).filter((x) => x.level === "error" || (x.code === "unmapped" && x.carriesContent));
		for (const x of blocking) {
			const key = `${slug}:${x.code}`;
			if (allowed.has(key) || (x.tag && allowed.has(`${key}:${x.tag}`))) elInfo.push(`${key} (allowed)`);
			else elProblems.push(`${slug}: ${x.level} ${x.code}${x.tag ? ` [${x.tag}]` : ""} ${x.message ?? ""}`.trim());
		}
		if (!(d.sections ?? []).length) elProblems.push(`${slug}: no sections`);
	}
	add("elementor-pages", label("elementor-pages"), elProblems.length === 0, elProblems.slice(0, 10).join("; ") || `${i.expected.elementorSlugs.length} pages${elInfo.length ? `; ${elInfo.join(", ")}` : ""}`);

	// Forms: each embedding page has a form section for its provider, and scaffold generated the definition.
	const formProblems: string[] = [];
	const formDir = join(i.project, "src", "forms");
	const defs = existsSync(formDir) ? readdirSync(formDir).filter((f) => f.endsWith(".json")) : [];
	for (const f of i.expected.forms) {
		for (const path of f.paths) {
			const d = byPath.get(norm(path));
			const sec = d?.sections?.find((s) => s.type === "form" && s.fields?.formRef?.provider === f.provider);
			if (!sec) formProblems.push(`${path}: no ${f.provider} form section`);
		}
		if (!defs.some((x) => x.startsWith(`${f.provider}-`))) formProblems.push(`${f.provider}: no definition in project/src/forms`);
	}
	add("forms-mapped", label("forms-mapped"), formProblems.length === 0, formProblems.join("; ") || `${defs.length} form definition(s): ${defs.join(", ")}`);

	// Languages (Polylang): plan, prefixes and translated pairs.
	const i18n = readJson<{ plugin?: string; defaultLang?: string; urlMode?: string; supported?: boolean; languages?: { code: string; prefix: string }[] }>(join(ir, "i18n.json"));
	const langProblems: string[] = [];
	if (!i18n) langProblems.push("no ir/i18n.json");
	else {
		if (i18n.plugin !== "polylang") langProblems.push(`plugin ${i18n.plugin}`);
		if (i18n.defaultLang !== "en") langProblems.push(`default ${i18n.defaultLang}`);
		if (i18n.urlMode !== "directory") langProblems.push(`URL mode ${i18n.urlMode}`);
		if (i18n.languages?.find((l) => l.code === "en")?.prefix !== "") langProblems.push("en is prefixed");
		if (i18n.languages?.find((l) => l.code === "fr")?.prefix !== "fr") langProblems.push("fr prefix is not /fr/");
		for (const p of i.expected.pairs) {
			const en = byPath.get(norm(p.en));
			const fr = byPath.get(norm(p.fr));
			if (!en || !fr) langProblems.push(`${p.en} ↔ ${p.fr}: ${!en ? "en" : "fr"} missing`);
			else if (en.i18n?.lang !== "en" || fr.i18n?.lang !== "fr") langProblems.push(`${p.en} ↔ ${p.fr}: languages ${en.i18n?.lang}/${fr.i18n?.lang}`);
			else if (!en.i18n?.group || en.i18n.group !== fr.i18n?.group) langProblems.push(`${p.en} ↔ ${p.fr}: different translation groups`);
		}
	}
	add("languages", label("languages"), langProblems.length === 0, langProblems.join("; ") || `${i18n?.languages?.map((l) => l.code).join(", ")}; ${i.expected.pairs.length} translated pairs`);

	// Generated project: built, and a Worker config without any Cloudflare account in it.
	const wrangler = join(i.project, "wrangler.jsonc");
	const built = existsSync(join(i.project, "dist"));
	const wranglerText = existsSync(wrangler) ? readFileSync(wrangler, "utf8") : "";
	add("project-built", label("project-built"), built && !!wranglerText && !/"account_id"\s*:\s*"[0-9a-f]{32}"/.test(wranglerText), !wranglerText ? "no wrangler.jsonc" : !built ? "no dist/ (astro build did not run or failed)" : "dist/ and wrangler.jsonc present, no account id");
	return out;
}

const ASSERTION_LABELS = new Map<string, string>([
	["routes", "Every seeded page, post and product has an IR document at its WordPress address"],
	["products-collection", "WooCommerce products became a shop collection with every seeded product"],
	["variable-products", "Variable products carry their variations"],
	["shop-facts", "Shop facts (products, sale prices, variations) read from the real WooCommerce"],
	["elementor-pages", "Elementor pages adapted from real _elementor_data, no unmapped content beyond the allowed list"],
	["forms-mapped", "Fluent Forms and Contact Form 7 forms mapped to form sections with generated definitions"],
	["languages", "Polylang: en default unprefixed, fr under /fr/, translated pairs share a group"],
	["project-built", "Generated project built (dist/) with no Cloudflare account id"],
]);

// ── Rendered pages (local dev server after load) ─────────────────────────────────────────────────────────────

export interface FetchedPage {
	path: string;
	status: number;
	html: string;
	error?: string;
}

/** hreflang alternates (lang → href) of a page. */
export function hreflangLinks(html: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
		const tag = m[0];
		if (!/\brel=["']?alternate/i.test(tag)) continue;
		const lang = /\bhreflang=["']?([^"'\s>]+)/i.exec(tag)?.[1];
		const href = /\bhref=["']?([^"'\s>]+)/i.exec(tag)?.[1];
		if (lang && href) out.set(lang.toLowerCase(), href);
	}
	return out;
}

export const htmlLang = (html: string) => /<html\b[^>]*\blang=["']?([^"'\s>]+)/i.exec(html)?.[1]?.toLowerCase();

/** French pages carry lang="fr", reciprocal hreflang (en, fr, x-default) and the language switcher; products and shop render. */
export function renderedAssertions(pages: FetchedPage[], expected: SeedExpectations, productName?: (slug: string) => string | undefined): Assertion[] {
	const get = (path: string) => pages.find((p) => norm(p.path) === norm(path));
	const problems: string[] = [];
	for (const pair of expected.pairs) {
		const fr = get(pair.fr);
		const en = get(pair.en);
		if (!fr || fr.status !== 200) {
			problems.push(`${pair.fr}: HTTP ${fr?.status ?? "not fetched"}${fr?.error ? ` (${fr.error})` : ""}`);
			continue;
		}
		const lang = htmlLang(fr.html);
		if (!lang?.startsWith("fr")) problems.push(`${pair.fr}: <html lang="${lang ?? ""}">`);
		const alt = hreflangLinks(fr.html);
		const enHref = [...alt].find(([l]) => l.startsWith("en"))?.[1];
		if (!enHref) problems.push(`${pair.fr}: no hreflang en`);
		else if (!new URL(enHref, "http://x").pathname.endsWith(norm(pair.en))) problems.push(`${pair.fr}: hreflang en → ${enHref} (expected ${pair.en})`);
		if (![...alt.keys()].some((l) => l.startsWith("fr"))) problems.push(`${pair.fr}: no self hreflang fr`);
		if (!alt.has("x-default")) problems.push(`${pair.fr}: no hreflang x-default`);
		if (!/class=["'][^"']*\blang-switcher\b/.test(fr.html)) problems.push(`${pair.fr}: no language switcher (.lang-switcher)`);
		if (en?.status === 200 && ![...hreflangLinks(en.html).keys()].some((l) => l.startsWith("fr"))) problems.push(`${pair.en}: no hreflang fr back`);
	}
	const out: Assertion[] = [
		{ id: "html-hreflang", label: "Rendered French pages: lang=fr, reciprocal hreflang + x-default, language switcher", ok: problems.length === 0, ...(problems.length ? { detail: problems.slice(0, 10).join("; ") } : { detail: `${expected.pairs.length} pairs` }) },
	];
	const shopProblems: string[] = [];
	for (const p of expected.products) {
		const path = `/product/${p.slug}/`;
		const page = get(path);
		if (!page || page.status !== 200) shopProblems.push(`${path}: HTTP ${page?.status ?? "not fetched"}`);
		else if (productName?.(p.slug) && !page.html.includes(productName(p.slug) as string)) shopProblems.push(`${path}: product name missing`);
	}
	const listing = get("/shop/");
	if (!listing || listing.status !== 200) shopProblems.push(`/shop/: HTTP ${listing?.status ?? "not fetched"}`);
	out.push({ id: "html-products", label: "Rendered product pages and the /shop/ listing answer 200 with the product names", ok: shopProblems.length === 0, detail: shopProblems.slice(0, 10).join("; ") || `${expected.products.length} products + /shop/` });
	return out;
}

/** The paths the rendered checks fetch. */
export function pathsToRender(expected: SeedExpectations): string[] {
	return [...new Set([...expected.pairs.flatMap((p) => [p.en, p.fr]), ...expected.products.map((p) => `/product/${p.slug}/`), "/shop/"])];
}
