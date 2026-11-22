/**
 * The WordPress end-to-end harness (e2e/, docs/e2e.md) without Docker: the seed plan and its PHP consumer agree, the
 * pinned images and zips are consistent, the workflow cannot deploy, the kit site the runner creates passes the init
 * gate, and the runner's phase loop, verdict, assertions, report and artifact handling behave — against fakes.
 * The Docker half (WordPress, seed, the real pipeline) runs in CI: .github/workflows/e2e-wordpress.yml.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { copyInto, excluded, scrubSecrets } from "../e2e/lib/artifacts.js";
import { hreflangLinks, htmlLang, outputAssertions, pathsToRender, renderedAssertions } from "../e2e/lib/assertions.js";
import { solidPng } from "../e2e/lib/images.js";
import { type Expectations, type PhaseOutcome, runPhases, verdict } from "../e2e/lib/pipeline.js";
import { buildSeedPlan, idFactory, planProblems, resolvePlaceholders, type SeedPlan } from "../e2e/lib/plan.js";
import { fetchZips, sha256, writePlanAndImages } from "../e2e/lib/prepare.js";
import { reportMarkdown } from "../e2e/lib/report.js";
import { createE2eSite, E2E_SLUG, e2eConfigText, forbiddenEnv, tickAccess } from "../e2e/lib/site.js";
import { IMAGES, ZIPS, zipFileName } from "../e2e/lib/versions.js";
import { runPhase } from "../src/commands/run.js";
import { loadConfig } from "../src/config/load.js";
import { loadOverrides } from "../src/config/overrides.js";
import { sitePaths } from "../src/core/paths.js";
import { ELEMENTOR_OPTIONS } from "../src/extract/elementor.js";
import { MIN_EXPORTER } from "../src/phases/extract.js";
import { parseChecklist } from "../src/phases/init.js";
import { versionAtLeast } from "../src/extract/client.js";

const ROOT = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const tmp = () => mkdtempSync(join(tmpdir(), "wp2emdash-e2e-test-"));

describe("seed plan", () => {
	const plan = buildSeedPlan();
	it("is deterministic and consistent", () => {
		expect(JSON.stringify(buildSeedPlan())).toBe(JSON.stringify(plan));
		expect(planProblems(plan)).toEqual([]);
	});
	it("covers what the kit must prove: Elementor + Gutenberg pages, posts, 6 products, two form plugins, en + fr", () => {
		expect(plan.pages.length).toBeGreaterThanOrEqual(8);
		expect(plan.pages.filter((p) => p.builder === "elementor").length).toBeGreaterThanOrEqual(4);
		expect(plan.pages.filter((p) => p.builder === "gutenberg").length).toBeGreaterThanOrEqual(4);
		expect(plan.posts.filter((p) => p.lang === "en")).toHaveLength(5);
		expect(plan.posts.every((p) => p.categories.length && p.featuredImage)).toBe(true);
		expect(plan.products).toHaveLength(6);
		expect(plan.products.filter((p) => p.type === "variable")).toHaveLength(2);
		expect(plan.expected.products.filter((p) => p.onSale).length).toBeGreaterThanOrEqual(2);
		expect(plan.languages.map((l) => [l.slug, l.default])).toEqual([["en", true], ["fr", false]]);
		expect(plan.expected.pairs).toContainEqual({ en: "/", fr: "/fr/" });
		expect(plan.expected.pairs).toContainEqual({ en: "/about/", fr: "/fr/a-propos/" });
		expect(plan.expected.forms).toEqual([
			{ provider: "fluent-forms", paths: ["/contact/", "/fr/nous-contacter/"] },
			{ provider: "contact-form-7", paths: ["/enquiry/"] },
		]);
		expect(plan.menus.map((m) => `${m.location}:${m.lang}`)).toEqual(["primary:en", "footer:en", "primary:fr"]);
		expect(new Set(plan.expected.routes.map((r) => r.path)).size).toBe(plan.expected.routes.length);
	});
	it("uses only Elementor widgets the adapter maps or treats as decorative", async () => {
		const { HANDLERS, DECORATIVE } = await import("../src/adapters/elementor/elements.js");
		const types = new Set<string>();
		const walk = (n: { widgetType?: string; elements: unknown[] }) => {
			if (n.widgetType) types.add(n.widgetType);
			for (const c of n.elements as (typeof n)[]) walk(c);
		};
		for (const p of plan.pages) for (const n of p.elementor ?? []) walk(n);
		expect([...types].filter((t) => !HANDLERS[t] && !DECORATIVE.has(t))).toEqual([]);
	});
	it("the Elementor adapter maps every seeded Elementor page without an error (before WordPress stores it)", async () => {
		const { adaptElementor, elementorElements } = await import("../src/adapters/elementor/index.js");
		const { Keys } = await import("../src/ir/portable-text.js");
		const images = Object.fromEntries(plan.images.map((img, i) => [img.key, { id: 100 + i, url: `http://localhost:8080/wp-content/uploads/2026/11/${img.file}` }]));
		const ctx = { site: "http://localhost:8080", images, fluent: 1, cf7: "1a2b3c4" };
		for (const p of plan.pages.filter((x) => x.builder === "elementor")) {
			const stored = resolvePlaceholders(JSON.stringify(p.elementor), ctx);
			expect(stored).not.toContain("{{");
			if (p.key === "home") expect(stored).toContain(`"id":${images.hero?.id},`);
			const tree = elementorElements(stored) ?? [];
			const r = adaptElementor(tree, { kind: "page", keys: new Keys(p.key), popupFor: () => undefined, postCount: plan.posts.length });
			expect(r.sections.length, p.key).toBeGreaterThan(0);
			expect(r.diagnostics.filter((d) => d.level === "error").map((d) => `${p.key}: ${d.message}`)).toEqual([]);
		}
	});
	it("placeholder rules: quoted image ids become numbers, everything else is text", () => {
		const ctx = { site: "http://wp.test", images: { a: { id: 7, url: "http://wp.test/a.png" } }, fluent: 3, cf7: "abc1234" };
		expect(resolvePlaceholders('{"id":"{{image:a:id}}","url":"{{image:a:url}}","c":"wp-image-{{image:a:id}}"} [fluentform id="{{form:fluent}}"] {{site}}/x/ {{form:cf7}}', ctx)).toBe('{"id":7,"url":"http://wp.test/a.png","c":"wp-image-7"} [fluentform id="3"] http://wp.test/x/ abc1234');
		expect(() => resolvePlaceholders("{{image:b:id}}", ctx)).toThrow(/unknown placeholder/);
	});
	it("reports dangling keys, bad placeholders and duplicates", () => {
		const broken = JSON.parse(JSON.stringify(plan)) as SeedPlan;
		(broken.posts[0] as SeedPlan["posts"][number]).categories = ["nope"];
		(broken.pages[1] as SeedPlan["pages"][number]).content += "{{image:missing:url}}";
		broken.products.push({ ...(broken.products[0] as SeedPlan["products"][number]) });
		const problems = planProblems(broken);
		expect(problems).toContain("post clay-body: category nope unknown");
		expect(problems).toContain("unresolvable placeholder {{image:missing:url}}");
		expect(problems).toContain("duplicate product slug: harbor-mug");
	});
	it("Elementor ids are 7 hex characters", () => {
		const next = idFactory("x");
		const ids = Array.from({ length: 50 }, next);
		expect(ids.every((i) => /^[0-9a-f]{7}$/.test(i))).toBe(true);
		expect(new Set(ids).size).toBe(50);
	});
});

describe("seed scripts read the plan the TypeScript writes", () => {
	const php = read("e2e/wordpress/seed.php") + read("e2e/wordpress/seed-languages.php");
	it("every plan key the PHP reads exists in the plan", () => {
		const keys = new Set<string>();
		const walk = (v: unknown) => {
			if (Array.isArray(v)) v.forEach(walk);
			else if (v && typeof v === "object")
				for (const [k, x] of Object.entries(v)) {
					keys.add(k);
					walk(x);
				}
		};
		walk(buildSeedPlan());
		// Keys of PHP-side arrays ($ctx, $term_ids, Polylang's saved option, regex matches).
		const phpOwn = new Set(["fluent", "cf7", "category", "post_tag", "product_cat", "default_lang", "force_lang", "hide_default", "post_types", "term_id", "elementor"]);
		const used = [...php.matchAll(/\$(?:plan|p|l|t|img|f|c7|ff|m|item|v|site)\[\s*'([A-Za-z_]+)'\s*\]/g)].map((m) => m[1] as string);
		expect(used.length).toBeGreaterThan(40);
		expect([...new Set(used)].filter((k) => !keys.has(k) && !phpOwn.has(k))).toEqual([]);
	});
	it("placeholders the PHP resolves are the ones the plan uses", () => {
		const plan = JSON.stringify(buildSeedPlan().pages);
		for (const p of ["{{site}}", "{{form:fluent}}", "{{form:cf7}}", ":id}}", ":url}}"]) expect(plan).toContain(p);
		expect(php).toContain("'form:fluent' === $key");
		expect(php).toContain("'form:cf7' === $key");
	});
	it("seed.sh runs both PHP files, writes what the runner reads, and exports the Elementor options the kit reads", () => {
		const sh = read("e2e/wordpress/seed.sh");
		expect(sh).toContain("wp eval-file /seed/seed-languages.php");
		expect(sh).toContain("wp eval-file /seed/seed.php");
		expect(sh.indexOf("seed-languages.php")).toBeLessThan(sh.indexOf("/seed/seed.php"));
		for (const out of ["app-password", "exports", "contact-form-7.xml", "elementor-options.json", "seed-summary.txt"]) expect(sh).toContain(out);
		for (const k of ELEMENTOR_OPTIONS) expect(sh).toContain(`"${k}"`);
		expect(sh).toContain("E=HTTP_AUTHORIZATION");
	});
	it("shell scripts parse (and pass shellcheck where it is installed)", () => {
		for (const f of ["e2e/run.sh", "e2e/wordpress/seed.sh"]) {
			expect(spawnSync("bash", ["-n", join(ROOT, f)]).status).toBe(0);
			expect(statSync(join(ROOT, f)).mode & 0o111).toBeTruthy();
		}
		const sc = spawnSync("shellcheck", ["--version"]);
		if (sc.status === 0) {
			const r = spawnSync("shellcheck", ["-x", join(ROOT, "e2e/run.sh"), join(ROOT, "e2e/wordpress/seed.sh")], { encoding: "utf8" });
			expect(r.stdout + r.stderr).toBe("");
		}
	});
});

describe("pinned versions", () => {
	it("docker-compose uses exactly the pinned images, binds to localhost, keeps the CLI behind a profile", () => {
		const compose = parse(read("e2e/wordpress/docker-compose.yml"), { merge: true }) as { services: Record<string, { image: string; ports?: string[]; profiles?: string[]; environment?: Record<string, string>; user?: string }> };
		expect(compose.services.db?.image).toBe(IMAGES.db);
		expect(compose.services.wordpress?.image).toBe(IMAGES.wordpress);
		expect(compose.services.wpcli?.image).toBe(IMAGES.cli);
		expect(Object.values(compose.services).every((s) => !/:latest$|^[^:]+$/.test(s.image))).toBe(true);
		expect(compose.services.wordpress?.ports).toEqual(["127.0.0.1:${E2E_WP_PORT:-8080}:80"]);
		expect(compose.services.wpcli?.profiles).toEqual(["tools"]);
		expect(compose.services.wpcli?.user).toBe("33:33");
		for (const s of ["wordpress", "wpcli"]) expect(compose.services[s]?.environment?.WORDPRESS_CONFIG_EXTRA).toContain("define('WP_ENVIRONMENT_TYPE', 'local');");
	});
	it("every zip is pinned by version and sha256; the exporter is new enough for extract", () => {
		for (const z of ZIPS) {
			expect(z.url).toContain(z.version);
			expect(z.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(zipFileName(z)).toBe(`${z.slug}-${z.version}.zip`);
		}
		expect(new Set(ZIPS.map((z) => z.slug)).size).toBe(ZIPS.length);
		expect(ZIPS.map((z) => z.slug)).toEqual(expect.arrayContaining(["elementor", "woocommerce", "polylang", "contact-form-7", "fluentform", "emdash-exporter"]));
		const exporter = ZIPS.find((z) => z.slug === "emdash-exporter");
		expect(versionAtLeast(exporter?.version ?? "0", MIN_EXPORTER)).toBe(true);
		expect(ZIPS.findIndex((z) => z.slug === "woocommerce")).toBeLessThan(ZIPS.findIndex((z) => z.slug === "polylang"));
	});
});

describe("workflow", () => {
	const text = read(".github/workflows/e2e-wordpress.yml");
	const wf = parse(text) as { on: Record<string, unknown>; permissions: Record<string, string>; env?: Record<string, string>; jobs: Record<string, { env?: Record<string, string>; steps: { run?: string; uses?: string; with?: Record<string, unknown> }[] }> };
	it("runs on demand and nightly, never on push or pull requests", () => {
		expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
		expect((wf.on.schedule as { cron: string }[])[0]?.cron).toMatch(/^\S+ \S+ \* \* \*$/);
	});
	it("cannot deploy or reach Cloudflare: read-only token, no secrets, no Cloudflare variables, API blackholed", () => {
		expect(wf.permissions).toEqual({ contents: "read" });
		expect(text).not.toMatch(/secrets\./);
		const job = wf.jobs.e2e;
		const envKeys = [...Object.keys(wf.env ?? {}), ...Object.keys(job?.env ?? {})];
		expect(envKeys.filter((k) => /CLOUDFLARE|EMDASH_TOKEN|CF_/.test(k))).toEqual([]);
		expect(job?.env?.WP2EMDASH_NO_PRODUCTION).toBe("1");
		const runs = (job?.steps ?? []).map((s) => s.run ?? "").join("\n");
		expect(runs).toContain("api.cloudflare.com");
		expect(runs).not.toMatch(/wrangler (deploy|publish)|pnpm (run )?deploy|wp2emdash (golive|provision|publish)/);
		expect(runs).toContain("e2e/run.sh");
	});
	it("uploads the report and writes the job summary even when the run fails", () => {
		const steps = wf.jobs.e2e?.steps ?? [];
		const upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
		expect(upload?.with?.path).toBe("e2e-report");
		expect((upload as { if?: string }).if).toBe("always()");
		expect(steps.some((s) => s.run?.includes("GITHUB_STEP_SUMMARY") && (s as { if?: string }).if === "always()")).toBe(true);
		expect(steps.some((s) => (s.with as { cache?: string } | undefined)?.cache === "pnpm")).toBe(true);
	});
	it("CI on push stays separate (the e2e run is not part of it)", () => {
		expect(read(".github/workflows/ci.yml")).not.toContain("e2e");
	});
});

describe("prepare", () => {
	it("writes the plan and one PNG per image", () => {
		const dir = tmp();
		const { planFile, images } = writePlanAndImages(dir);
		const plan = JSON.parse(readFileSync(planFile, "utf8")) as SeedPlan;
		expect(images).toBe(plan.images.length);
		const logo = plan.images.find((i) => i.key === "logo");
		const png = PNG.sync.read(readFileSync(join(dir, "images", logo?.file as string)));
		expect([png.width, png.height]).toEqual([logo?.width, logo?.height]);
		expect([...png.data.subarray(0, 3)]).toEqual([0x1f, 0x3a, 0x5f]);
	});
	it("solid PNGs are deterministic", () => {
		const img = { width: 8, height: 4, color: "#336699" };
		expect(sha256(solidPng(img))).toBe(sha256(solidPng(img)));
	});
	it("downloads each zip once, checks sha256, serves later runs from the cache", async () => {
		const body = Buffer.from("zip bytes");
		const zips = [{ slug: "demo", kind: "plugin" as const, version: "1.0.0", url: "https://example.test/demo.1.0.0.zip", sha256: sha256(body), why: "test" }];
		const work = tmp();
		const cache = tmp();
		let calls = 0;
		const fetcher = async () => {
			calls++;
			return body;
		};
		expect(await fetchZips(work, cache, { zips, fetcher })).toEqual(["demo-1.0.0.zip"]);
		await fetchZips(work, cache, { zips, fetcher });
		expect(calls).toBe(1);
		expect(readFileSync(join(work, "zips", "order.txt"), "utf8")).toBe("plugin demo-1.0.0.zip demo\n");
		await expect(fetchZips(tmp(), tmp(), { zips: [{ ...(zips[0] as (typeof zips)[number]), sha256: "0".repeat(64) }], fetcher })).rejects.toThrow(/does not match the pinned/);
	});
});

describe("the e2e kit site", () => {
	it("is a valid kit site: catalogue-mode shop, no Workers AI by default, decisions recorded, init gate passes", async () => {
		const sitesDir = tmp();
		const work = tmp();
		mkdirSync(join(work, "exports"));
		writeFileSync(join(work, "exports", "contact-form-7.xml"), "<rss><wp:post_type>wpcf7_contact_form</wp:post_type></rss>");
		writeFileSync(join(work, "elementor-options.json"), '{"elementor_active_kit":5}');
		const site = createE2eSite({ sitesDir, wpUrl: "http://localhost:8080", appPassword: "abcd efgh ijkl mnop", workDir: work });
		const p = sitePaths(E2E_SLUG, sitesDir);
		const config = await loadConfig(p.config);
		expect(config.source.url).toBe("http://localhost:8080");
		expect(config.shop).toMatchObject({ mode: "catalogue", checkout: "contact", currency: "USD", contactPath: "/contact/" });
		expect(config.seo.panel).toBe(false);
		expect(config.media).toMatchObject({ aiAlt: false });
		expect(config.target.productionUrl).toBe("https://harbor-lane.example");
		expect((await loadOverrides(p.overrides)).redirects).toEqual({ source: "none" });
		expect(parseChecklist(readFileSync(p.access, "utf8")).filter((i) => i.required && i.section === "Before audit").every((i) => i.done)).toBe(true);
		const env = readFileSync(join(site.root, ".env"), "utf8");
		expect(env).toBe("WP_APP_USER=admin\nWP_APP_PASSWORD=abcd efgh ijkl mnop\n");
		expect(statSync(join(site.root, ".env")).mode & 0o077).toBe(0);
		expect(existsSync(join(p.raw, "plugin-exports", "contact-form-7.xml"))).toBe(true);
		expect(existsSync(join(p.raw, "elementor-options.json"))).toBe(true);
		expect(readFileSync(p.decisions, "utf8")).toContain("Synthetic end-to-end site");
		const r = await runPhase(E2E_SLUG, "init", { sitesDir, quiet: true });
		expect(r.ok).toBe(true);
	});
	it("keeps every kit default with fullDefaults", () => {
		expect(e2eConfigText({ wpUrl: "http://localhost:8080", fullDefaults: true })).not.toContain("panel: false");
	});
	it("ticks only the named ACCESS sections", () => {
		const md = "## Before audit\n- [ ] (required) a\n## Before cutover\n- [ ] b\n";
		expect(tickAccess(md, ["Before audit"])).toBe("## Before audit\n- [x] (required) a\n## Before cutover\n- [ ] b\n");
	});
	it("the runner refuses Cloudflare and EmDash credentials", () => {
		expect(forbiddenEnv({ CLOUDFLARE_API_TOKEN: "x", EMDASH_TOKEN_PRODUCTION: "y", CLOUDFLARE_ACCOUNT_ID: "", PATH: "/bin" })).toEqual(["CLOUDFLARE_API_TOKEN", "EMDASH_TOKEN_PRODUCTION"]);
		expect(forbiddenEnv({ HOME: "/h" })).toEqual([]);
	});
});

describe("phase loop and verdict", () => {
	const exp: Expectations = { requiredPhases: ["init", "audit", "extract"], optionalPhases: ["load"], knownFailures: { "audit:screenshots": "flaky in CI (2026-11-22)", "extract:gone": "fixed already" }, allowedElementorDiagnostics: [], requiredAssertions: ["routes"] };
	const fake =
		(results: Record<string, { ok: boolean; checks?: { id: string; label: string; ok: boolean }[] } | Error>) =>
		async (phase: string, o: { preview: boolean }) => {
			const r = results[phase];
			if (r instanceof Error) throw r;
			calls.push(`${phase}${o.preview ? ":preview" : ""}`);
			return { ok: r?.ok ?? true, checks: r?.checks ?? [{ id: "x", label: "x", ok: r?.ok ?? true }], runId: `run-${phase}` };
		};
	let calls: string[] = [];
	it("keeps going after a failed gate, as --preview", async () => {
		calls = [];
		const out = await runPhases(["init", "audit", "extract", "transform"], fake({ audit: { ok: false, checks: [{ id: "screenshots", label: "Screens", ok: false }] } }));
		expect(calls).toEqual(["init", "audit", "extract:preview", "transform:preview"]);
		expect(out.map((o) => o.mode)).toEqual(["recorded", "recorded", "preview", "preview"]);
	});
	it("stops after a phase listed in stopAfterFailure; a crash is a failure with its message", async () => {
		calls = [];
		const out = await runPhases(["init", "audit", "extract"], fake({ init: new Error("boom") }), { stopAfterFailure: ["init"] });
		expect(out[0]).toMatchObject({ ok: false, error: "boom" });
		expect(out.slice(1).map((o) => o.mode)).toEqual(["skipped", "skipped"]);
	});
	it("startBroken runs everything as preview", async () => {
		calls = [];
		await runPhases(["load"], fake({}), { startBroken: true });
		expect(calls).toEqual(["load:preview"]);
	});
	const outcome = (phase: PhaseOutcome["phase"], failed: string[] = [], extra: Partial<PhaseOutcome> = {}): PhaseOutcome => ({ phase, mode: "recorded", ok: !failed.length, checks: [{ id: "ok", label: "ok", ok: true }, ...failed.map((id) => ({ id, label: id, ok: false }))], ms: 1, ...extra });
	it("fails on required gates and assertions; excuses known failures; reports stale ones; ignores optional phases", () => {
		const v = verdict([outcome("init"), outcome("audit", ["screenshots"]), outcome("extract", ["forms"]), outcome("load", ["target"])], [{ id: "routes", ok: true }, { id: "html", ok: false }], exp);
		expect(v.ok).toBe(false);
		expect(v.reasons).toEqual(["extract:forms: forms"]);
		expect(v.excused).toEqual(["audit:screenshots — flaky in CI (2026-11-22)"]);
		expect(v.stale).toEqual(["extract:gone"]);
		const pass = verdict([outcome("init"), outcome("audit", ["screenshots"]), outcome("extract")], [{ id: "routes", ok: true }], exp);
		expect(pass.ok).toBe(true);
		const skipped = verdict([outcome("init"), outcome("audit"), outcome("extract")], [{ id: "routes", ok: false, skipped: true }], exp);
		expect(skipped.reasons).toEqual(["assertion routes: skipped (its input is missing)"]);
		const notRun = verdict([outcome("init"), outcome("audit"), outcome("extract", [], { mode: "skipped", checks: [], error: "not run" })], [], exp);
		expect(notRun.reasons).toEqual(["extract: not run"]);
	});
});

/** A site folder holding what a good migration of the seed plan produces. */
function fakeSite(plan: SeedPlan, tweak: (root: string) => void = () => {}): { root: string; project: string } {
	const root = tmp();
	const ir = join(root, "ir");
	const project = join(root, "project");
	for (const d of ["pages", "posts", "entries/products"]) mkdirSync(join(ir, d), { recursive: true });
	mkdirSync(join(project, "src", "forms"), { recursive: true });
	mkdirSync(join(project, "dist"));
	writeFileSync(join(project, "wrangler.jsonc"), '{ "name": "harbor-lane-e2e" }');
	writeFileSync(join(project, "src", "forms", "fluent-forms-1.json"), "{}");
	writeFileSync(join(project, "src", "forms", "contact-form-7-1a2b3c4.json"), "{}");
	writeFileSync(join(ir, "site.json"), "{}");
	const group = (path: string) => {
		const pair = plan.expected.pairs.find((p) => p.en === path || p.fr === path);
		return pair ? `g-${pair.en}` : `g-${path}`;
	};
	const formOn = (path: string) => plan.expected.forms.filter((f) => f.paths.includes(path)).map((f) => ({ type: "form", fields: { formRef: { provider: f.provider, id: "1" } } }));
	for (const r of plan.expected.routes) {
		const slug = r.path === "/" ? "home" : r.path === "/fr/" ? "accueil" : (r.path.split("/").filter(Boolean).pop() as string);
		const doc = { kind: r.kind === "product" ? "entry" : r.kind, source: { slug, builder: r.builder ?? "gutenberg", type: r.kind }, route: { path: r.path }, i18n: { lang: r.lang, group: group(r.path) }, sections: [{ type: "text", fields: {} }, ...formOn(r.path)], diagnostics: [] };
		const file = r.kind === "page" ? join(ir, "pages", `${slug}${r.lang === "fr" ? ".fr" : ""}.json`) : r.kind === "post" ? join(ir, "posts", `${slug}.json`) : join(ir, "entries", "products", `${slug}.json`);
		const product = plan.expected.products.find((p) => p.slug === slug);
		writeFileSync(file, JSON.stringify(r.kind === "product" && product?.type === "variable" ? { ...doc, entry: { collection: "products", fields: { variations: [{ name: "Small" }] } } } : doc));
	}
	writeFileSync(join(ir, "collections.json"), JSON.stringify({ collections: [{ slug: "products", type: "product", shop: { checkout: "contact" } }] }));
	writeFileSync(join(ir, "shop.json"), JSON.stringify({ facts: { products: 6, onSale: 3, variations: 5 }, listing: "/shop/", checkout: "contact" }));
	writeFileSync(join(ir, "i18n.json"), JSON.stringify({ plugin: "polylang", defaultLang: "en", urlMode: "directory", supported: true, languages: [{ code: "en", prefix: "" }, { code: "fr", prefix: "fr" }] }));
	tweak(root);
	return { root, project };
}

describe("output assertions", () => {
	const plan = buildSeedPlan();
	const run = (s: { root: string; project: string }, allowed: string[] = []) => outputAssertions({ siteRoot: s.root, project: s.project, expected: plan.expected, allowedElementorDiagnostics: allowed });
	it("all pass on a faithful migration", () => {
		const out = run(fakeSite(plan));
		expect(out.filter((a) => !a.ok).map((a) => `${a.id}: ${a.detail}`)).toEqual([]);
		expect(out.map((a) => a.id)).toEqual(["routes", "products-collection", "variable-products", "shop-facts", "elementor-pages", "forms-mapped", "languages", "project-built"]);
	});
	it("names what is missing or wrong", () => {
		const s = fakeSite(plan, (root) => {
			const ir = join(root, "ir");
			writeFileSync(join(ir, "entries", "products", "planter.json"), JSON.stringify({ kind: "entry", source: { slug: "planter" }, route: { path: "/product/planter/" } }));
			const faq = JSON.parse(readFileSync(join(ir, "pages", "faq.json"), "utf8"));
			faq.diagnostics = [{ level: "error", code: "unmapped", message: "[google_maps] no address", carriesContent: true, tag: "google_maps" }];
			writeFileSync(join(ir, "pages", "faq.json"), JSON.stringify(faq));
			const about = JSON.parse(readFileSync(join(ir, "pages", "a-propos.fr.json"), "utf8"));
			about.i18n.group = "other";
			writeFileSync(join(ir, "pages", "a-propos.fr.json"), JSON.stringify(about));
		});
		const out = Object.fromEntries(run(s).map((a) => [a.id, a]));
		expect(out["variable-products"]?.ok).toBe(false);
		expect(out["variable-products"]?.detail).toContain("planter");
		expect(out["elementor-pages"]?.detail).toContain("faq: error unmapped [google_maps]");
		expect(out.languages?.detail).toContain("/about/ ↔ /fr/a-propos/: different translation groups");
		expect(Object.fromEntries(run(s, ["faq:unmapped:google_maps"]).map((a) => [a.id, a.ok]))["elementor-pages"]).toBe(true);
	});
	it("are skipped, not passed, without transform output", () => {
		const out = run({ root: tmp(), project: tmp() });
		expect(out.every((a) => a.skipped && !a.ok)).toBe(true);
	});
});

describe("rendered-page assertions", () => {
	const plan = buildSeedPlan();
	const page = (path: string, lang: string, alternates: [string, string][], switcher = true) => ({
		path,
		status: 200,
		html: `<!doctype html><html lang="${lang}"><head>${alternates.map(([l, h]) => `<link rel="alternate" hreflang="${l}" href="https://harbor-lane.example${h}">`).join("")}</head><body>${switcher ? '<nav class="lang-switcher lang-switcher--header">' : ""}Harbor mug Tide bowl Speckled plate Espresso cup Serving bowl Planter</body></html>`,
	});
	const pages = () =>
		pathsToRender(plan.expected).map((path) => {
			const pair = plan.expected.pairs.find((p) => p.en === path || p.fr === path);
			if (!pair) return page(path, "en", []);
			const alts: [string, string][] = [["en", pair.en], ["fr", pair.fr], ["x-default", pair.en]];
			return page(path, path === pair.fr ? "fr" : "en", alts);
		});
	it("parses hreflang links and the html lang", () => {
		const html = '<html lang="fr-FR"><link href="/a/" rel="alternate" hreflang="en"><link rel=alternate hreflang=x-default href=/a/><link rel="stylesheet" href="/s.css">';
		expect([...hreflangLinks(html)]).toEqual([["en", "/a/"], ["x-default", "/a/"]]);
		expect(htmlLang(html)).toBe("fr-fr");
	});
	it("pass when French pages have lang, reciprocal alternates, x-default and the switcher", () => {
		const out = renderedAssertions(pages(), plan.expected, (s) => plan.products.find((p) => p.slug === s)?.name);
		expect(out.filter((a) => !a.ok)).toEqual([]);
	});
	it("fail with the page and the missing piece", () => {
		const broken = pages().map((p) => (p.path === "/fr/a-propos/" ? page(p.path, "en", [["en", "/about/"]], false) : p.path === "/shop/" ? { ...p, status: 404 } : p));
		const out = Object.fromEntries(renderedAssertions(broken, plan.expected).map((a) => [a.id, a]));
		expect(out["html-hreflang"]?.detail).toContain('/fr/a-propos/: <html lang="en">');
		expect(out["html-hreflang"]?.detail).toContain("/fr/a-propos/: no hreflang x-default");
		expect(out["html-hreflang"]?.detail).toContain("/fr/a-propos/: no language switcher");
		expect(out["html-products"]?.detail).toContain("/shop/: HTTP 404");
	});
});

describe("report and artifacts", () => {
	it("the report leads with the verdict and the reasons, then every phase and assertion", () => {
		const md = reportMarkdown({
			verdict: { ok: false, reasons: ["extract:forms: Every live form — Not extracted: contact-form-7#9"], excused: [], stale: ["audit:x"] },
			phases: [{ phase: "extract", mode: "recorded", ok: false, checks: [{ id: "forms", label: "Every live form", ok: false, detail: "Not extracted" }], ms: 1234 }],
			assertions: [{ id: "routes", label: "Routes", ok: true, detail: "29 addresses" }],
			startedAt: "2026-11-22T00:00:00Z",
			finishedAt: "2026-11-22T00:10:00Z",
			wpUrl: "http://localhost:8080",
			notes: [],
			files: ["report.md"],
		});
		expect(md.split("\n")[0]).toBe("# WordPress end-to-end: FAILED");
		expect(md).toContain("- extract:forms: Every live form — Not extracted: contact-form-7#9");
		expect(md).toContain("| extract | recorded | **failed** | 1.2 s | forms |");
		expect(md).toContain("- ✗ `forms` Every live form — Not extracted");
		expect(md).toContain("| Routes (`routes`) | passed | 29 addresses |");
		expect(md).toContain("- audit:x");
		expect(md).toContain(`\`${IMAGES.wordpress}\``);
	});
	it("never copies .env, node_modules or screenshots (unless asked); scrubs credentials", () => {
		expect(excluded(".env", false)).toBe(true);
		expect(excluded("raw/.env.local", false)).toBe(true);
		expect(excluded("project/node_modules/x", false)).toBe(true);
		expect(excluded("reports/verify/screens/a.png", false)).toBe(true);
		expect(excluded("reports/verify/screens/a.png", true)).toBe(false);
		const src = tmp();
		const dest = tmp();
		mkdirSync(join(src, "reports", "audit"), { recursive: true });
		writeFileSync(join(src, ".env"), "WP_APP_PASSWORD=secret-value-123");
		writeFileSync(join(src, "reports", "audit", "audit.md"), "auth with secret-value-123 and secretvalue");
		writeFileSync(join(src, "reports", "audit", ".env"), "x");
		expect(copyInto(src, [".env", "reports", "missing"], dest)).toEqual(["reports"]);
		expect(existsSync(join(dest, ".env"))).toBe(false);
		expect(existsSync(join(dest, "reports", "audit", ".env"))).toBe(false);
		expect(scrubSecrets(dest, ["secret-value-123"])).toBe(1);
		expect(readFileSync(join(dest, "reports", "audit", "audit.md"), "utf8")).toBe("auth with [redacted] and secretvalue");
	});
});
