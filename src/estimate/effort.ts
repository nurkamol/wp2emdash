/**
 * The effort estimate: one line per rule that applies, each with its basis, so the agency sees exactly where the
 * hours come from. Rules and numbers live in rules.ts. Out-of-scope findings add no hours: they are listed as
 * excluded (scoped separately). Pure.
 */
import type { EstimateRules, Range } from "./rules.js";
import type { AdapterUse, Detections, Effort, EffortLine, Finding } from "./types.js";

const r1 = (n: number) => Math.round(n * 10) / 10;
const times = (r: Range, n: number): Range => [r1(r[0] * n), r1(r[1] * n)];
const add = (a: Range, b: Range): Range => [r1(a[0] + b[0]), r1(a[1] + b[1])];

/** Content volume: REST totals where the API answers, else the URL guess. Products are counted by the shop rule. */
export function contentVolume(d: Detections): { pages: number; posts: number; collections: { slug: string; count: number }[] } {
	if (d.types.length) {
		const pages = d.types.find((t) => t.slug === "page")?.count ?? 0;
		const posts = d.types.find((t) => t.slug === "post")?.count ?? 0;
		const collections = d.types.filter((t) => t.slug !== "page" && t.slug !== "post" && t.slug !== "product" && t.count > 0);
		return { pages: Math.max(pages, 1), posts, collections };
	}
	return { pages: Math.max(d.urlGuess.pages, 1), posts: d.urlGuess.posts, collections: [] };
}

export function computeEffort(d: Detections, adapters: AdapterUse[], findings: Finding[], rules: EstimateRules, o: { rate?: number; currency?: string } = {}): Effort {
	const e = rules.effort;
	const lines: EffortLine[] = [];
	const line = (id: string, label: string, hours: Range, basis: string) => {
		if (hours[1] > 0) lines.push({ id, label, hours, basis });
	};

	line("base", "Project setup, audit, extract, scaffold, load, verify, launch", e.base, "fixed per project");

	const vol = contentVolume(d);
	for (const a of adapters) {
		const n = Math.max(1, Math.round(vol.pages * a.share));
		line(`pages-${a.adapter}`, `Pages via ${a.label}`, times(e.perPage[a.adapter], n), `${n} page(s) × ${e.perPage[a.adapter].join("–")} h (${Math.round(a.share * 100)} % of the sample)`);
	}
	if (vol.posts) line("posts", "Blog posts (bulk import, spot checks)", times(e.perPost, vol.posts), `${vol.posts} post(s) × ${e.perPost.join("–")} h`);
	for (const c of vol.collections) line(`collection-${c.slug}`, `Collection "${c.slug}"`, add(e.perCollection, times(e.perCollectionEntry, c.count)), `1 collection (${e.perCollection.join("–")} h) + ${c.count} entr${c.count === 1 ? "y" : "ies"} × ${e.perCollectionEntry.join("–")} h`);

	const main = adapters[0];
	if (main) line("visual", "Visual parity rounds", e.visualParity[main.adapter], `main adapter: ${main.label}`);
	for (const a of adapters.filter((x) => !x.proven)) line(`unproven-${a.adapter}`, `First real site on ${a.label}`, e.unprovenAdapter, "adapter has only run on fixtures (docs/PLAN.md status)");

	const forms = d.integrations.filter((i) => i.kind === "form" && i.proposed !== "keep");
	if (forms.length) line("forms", "Forms rebuilt (form section → Worker → email, Turnstile)", times(e.perForm, forms.length), `${forms.length} distinct form(s) × ${e.perForm.join("–")} h`);
	const sensitive = d.integrations.filter((i) => i.form && i.form.sensitiveFields.length);
	if (sensitive.length) line("sensitive-forms", "Sensitive-data forms (provider choice, field review)", times(e.perSensitiveForm, sensitive.length), `${sensitive.length} form(s) × ${e.perSensitiveForm.join("–")} h`);

	const kept = d.integrations.filter((i) => ["booking", "chat", "map", "video", "reviews", "social-feed", "newsletter", "payment"].includes(i.kind));
	if (kept.length) line("integrations", "Third-party integrations kept or replaced", times(e.perIntegration, kept.length), `${kept.length} × ${e.perIntegration.join("–")} h: ${kept.map((i) => i.name).join(", ")}`);
	if (d.integrations.some((i) => ["analytics", "tag-manager", "pixel", "consent"].includes(i.kind))) line("tracking", "Analytics, tags and consent re-wired", e.tracking, "SEO & Analytics settings + consent banner");
	const popups = d.integrations.filter((i) => i.kind === "popup").length + (d.plugins.some((p) => /popup|pum/.test(p.slug)) && !d.integrations.some((i) => i.kind === "popup") ? 1 : 0);
	if (popups) line("popups", "Popups as dialog sections", times(e.perPopup, popups), `${popups} × ${e.perPopup.join("–")} h`);
	const unknown = d.plugins.filter((p) => p.action === "review" && p.replacement.startsWith("Unknown")).length;
	if (unknown) line("unknown-plugins", "Unknown plugins reviewed", times(e.perUnknownPlugin, unknown), `${unknown} × ${e.perUnknownPlugin.join("–")} h`);

	const excludedIds = new Set(findings.filter((f) => f.excluded).map((f) => f.id));
	if (findings.some((f) => f.id === "shop")) {
		const products = d.shop?.products ?? 0;
		line("shop", "Shop in catalogue mode", add(e.shopBase, times(e.shopPer50Products, Math.ceil(products / 50))), `${e.shopBase.join("–")} h + ${Math.ceil(products / 50)} × 50 products × ${e.shopPer50Products.join("–")} h`);
	}
	if (findings.some((f) => f.id === "multilingual")) {
		const extra = Math.max(1, d.multilingual.languages.length - 1);
		line("multilingual", "Languages (addresses, menus, hreflang, switcher)", add(e.multilingualBase, times(e.perExtraLanguage, extra)), `${e.multilingualBase.join("–")} h + ${extra} extra language(s) × ${e.perExtraLanguage.join("–")} h`);
	}
	const urls = Math.max(d.discovered, vol.pages + vol.posts);
	if (urls > 100) {
		const n = Math.ceil((urls - 100) / 100);
		line("urls", "Redirects and URL checks for a larger site", times(e.per100Urls, n), `${urls} addresses: ${n} × 100 beyond the first 100 × ${e.per100Urls.join("–")} h`);
	}

	const subtotal = lines.reduce((s, l) => add(s, l.hours), [0, 0] as Range);
	const contingency: Range = [r1(subtotal[0] * e.contingency), r1(subtotal[1] * e.contingency)];
	const total: Range = [Math.round(subtotal[0] + contingency[0]), Math.round(subtotal[1] + contingency[1])];
	const size = total[1] <= rules.sizes.small ? "Small" : total[1] <= rules.sizes.medium ? "Medium" : "Large";
	const excluded = findings.filter((f) => excludedIds.has(f.id)).map((f) => f.title);
	const rate = o.rate && o.rate > 0 ? o.rate : undefined;
	return {
		lines,
		subtotal,
		contingency,
		contingencyRate: e.contingency,
		total,
		size,
		excluded,
		...(rate ? { rate, cost: [Math.round(total[0] * rate), Math.round(total[1] * rate)] as Range } : {}),
		...(rate && o.currency ? { currency: o.currency } : {}),
	};
}
