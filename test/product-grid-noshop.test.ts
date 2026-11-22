/**
 * The product grid section (PLAN §8b) exists only on WooCommerce catalogue-mode sites. This file proves that a site
 * without a shop gets exactly the scaffold output it got before the section existed: the same seed.json (block types,
 * collections and their allowed sections, content), the same section library, the same client docs. The goldens in
 * test/golden/product-grid/noshop-*.json were generated from the kit before the product grid was added; they are never
 * rewritten by UPDATE_GOLDEN (a change meant for shop sites only must not touch them).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import type { IrPage } from "../src/ir/schema.js";
import { runTransform } from "../src/phases/transform.js";
import { type ClientRepoInput, clientRepoFiles } from "../src/scaffold/client-repo.js";
import { buildSeed, seedMediaResolver } from "../src/scaffold/seed.js";
import { BLOCK_TYPES } from "../src/starter/library.js";
import type { CptPlan } from "../src/transform/cpt.js";

const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "cpt", "site.json"), "utf8"));
const goldenDir = join(import.meta.dirname, "golden", "product-grid");
const golden = (name: string, value: unknown) => {
	const file = join(goldenDir, name);
	const json = `${JSON.stringify(value, null, "\t")}\n`;
	if (!existsSync(file)) {
		mkdirSync(goldenDir, { recursive: true });
		writeFileSync(file, json);
	}
	expect(json).toBe(readFileSync(file, "utf8"));
};
const sha = (v: unknown) => createHash("sha256").update(typeof v === "string" ? v : JSON.stringify(v)).digest("hex");

const dir = mkdtempSync(join(tmpdir(), "wp2e-noshop-"));
const put = (file: string, data: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const config = kitConfigSchema.parse({ slug: "noshop", name: "Example Studio", source: { url: "https://cpt.example.test" }, target: { productionUrl: "https://cpt.example.test" } });
const readDir = (d: string) => (existsSync(d) ? Object.fromEntries(readdirSync(d).sort().map((f) => [f, JSON.parse(readFileSync(join(d, f), "utf8"))])) : {});

describe("sites without a shop: scaffold output unchanged by the product grid", async () => {
	const paths = sitePaths("noshop", dir);
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "options.json"), fx.options);
	put(join(paths.raw, "exporter", "content", "page.json"), fx.pages);
	for (const t of ["team", "services", "location"]) put(join(paths.raw, "exporter", "content", `${t}.json`), fx[t]);
	put(join(paths.raw, "exporter", "taxonomies.json"), fx.taxonomies);
	put(join(paths.raw, "exporter", "analyze.json"), fx.analyze);
	put(join(paths.raw, "exporter", "types.json"), fx.types);
	for (const [f, d] of Object.entries(fx.fieldDefinitions)) put(join(paths.raw, "field-definitions", f), d);
	put(join(paths.raw, "media-manifest.json"), fx.media);
	put(join(paths.snapshot, "urls.json"), fx.urls);
	put(join(paths.snapshot, "discovery.json"), fx.discovery);
	put(paths.overrides, `export default { contentTypes: { team: { as: "collection", fields: { legacy_code: "string" } } } };\n`);
	await runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
	const plan = JSON.parse(readFileSync(join(paths.ir, "collections.json"), "utf8")) as CptPlan;
	const entries = plan.collections.flatMap((c) => Object.values(readDir(join(paths.ir, "entries", c.slug)))) as IrPage[];
	const pages = Object.values(readDir(join(paths.ir, "pages"))) as IrPage[];
	const media = seedMediaResolver(new Map(fx.media.map((m: { id: number; url: string }) => [m.id, { url: m.url }])), (u) => u);
	const seed = buildSeed({ name: "x", site: { version: 1, title: "Example Studio", menus: [], partials: [], popups: [] }, pages, partials: [], popups: [], media, titleSeparator: "-", forms: [], includeContent: true, collections: { plan, entries } });

	it("seed.json: same block types, collections, allowed sections and content (golden from before the product grid)", () => {
		const cols = seed.collections as { slug: string; fields: { slug: string; type: string; validation?: { allowedTypes?: string[] } }[] }[];
		golden("noshop-seed.json", {
			sha256: sha(seed),
			blockTypes: (seed.blockTypes as { slug: string }[]).map((b) => b.slug),
			blockTypesSha256: sha(seed.blockTypes),
			allowedTypes: Object.fromEntries(cols.map((c) => [c.slug, c.fields.find((f) => f.type === "blocks")?.validation?.allowedTypes ?? null])),
			collections: cols.map((c) => c.slug),
		});
		expect(JSON.stringify(seed)).not.toMatch(/product_grid|product grid/i);
	});

	it("section library: the shared block types are unchanged (golden from before the product grid)", () => {
		golden("noshop-library.json", { count: BLOCK_TYPES.length, slugs: BLOCK_TYPES.map((b) => b.slug), sha256: sha(BLOCK_TYPES) });
	});

	it("client docs: same files and text (golden from before the product grid)", () => {
		const input: ClientRepoInput = {
			name: "Example Studio",
			slug: "noshop",
			sourceUrl: "https://cpt.example.test",
			productionUrl: "https://cpt.example.test",
			workerName: "noshop",
			productionReady: false,
			sections: [
				{ slug: "section_hero", label: "Hero", description: "Page introduction" },
				{ slug: "section_posts_list", label: "Latest posts", description: "The newest blog posts" },
			],
			forms: [],
			email: { provider: "brevo", to: ["owner@example.com"] },
			turnstileProduction: false,
			sensitiveData: false,
			collections: plan.collections.map((c) => ({ label: c.label, labelSingular: c.labelSingular, slug: c.slug, fields: c.fields.map((f) => ({ label: f.label, type: f.type })), hierarchical: c.hierarchical, taxonomies: c.taxonomies.map((t) => t.label) })),
			stack: { node: ">=24", astro: "7", emdash: "1.5.0", wrangler: "4" },
		};
		const files = clientRepoFiles(input);
		golden("noshop-docs.json", Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sha(v)])));
		expect(Object.values(files).join("\n")).not.toMatch(/product grid/i);
	});
});
