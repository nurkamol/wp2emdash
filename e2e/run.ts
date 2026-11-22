/**
 * WordPress end-to-end test, the TypeScript half (e2e/run.sh drives Docker around it).
 *
 *   tsx e2e/run.ts prepare    seed plan + images + pinned plugin zips → e2e/wordpress/.work (before Docker)
 *   tsx e2e/run.ts pipeline   kit site in a temp sites dir → init … scaffold, then load + verify against the local
 *                             dev server → assertions → report (E2E_OUT, default e2e/wordpress/.work/report)
 *
 * Exit codes (pipeline): 0 passed · 2 a required gate or assertion failed · 1 the runner itself broke.
 * Environment: E2E_WP_URL (http://localhost:8080), E2E_WORK_DIR, E2E_OUT, E2E_SITES_DIR (default: a new temp dir),
 * E2E_CACHE_DIR (zip cache), E2E_SKIP_LOAD=1, E2E_FULL_DEFAULTS=1, E2E_DEV_PORT (4399), E2E_KEEP_SCREENS=1.
 * Never deploys and never talks to Cloudflare: it refuses to start with CLOUDFLARE_* or EMDASH_TOKEN* set, blanks
 * them for the site, and pins load/verify to the local target (WP2EMDASH_NO_PRODUCTION=1).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { runPhase } from "../src/commands/run.js";
import { KIT_ROOT, sitePaths } from "../src/core/paths.js";
import { loadEnv } from "../src/extract/credentials.js";
import { copyInto, PROJECT_COPY, SITE_COPY, scrubSecrets, startDevServer } from "./lib/artifacts.js";
import { type Assertion, type FetchedPage, outputAssertions, pathsToRender, renderedAssertions } from "./lib/assertions.js";
import { type Expectations, type PhaseOutcome, runPhases, verdict } from "./lib/pipeline.js";
import { buildSeedPlan } from "./lib/plan.js";
import { fetchZips, writePlanAndImages } from "./lib/prepare.js";
import { reportJson, reportMarkdown } from "./lib/report.js";
import { createE2eSite, E2E_SLUG, forbiddenEnv, KIT_ENV_BLANK } from "./lib/site.js";

const E2E_DIR = join(KIT_ROOT, "e2e");
const env = process.env;
const workDir = env.E2E_WORK_DIR ?? join(E2E_DIR, "wordpress", ".work");
const log = (m: string) => console.log(`[e2e] ${m}`);

async function prepare(): Promise<void> {
	const { planFile, images } = writePlanAndImages(workDir);
	log(`plan ${relative(KIT_ROOT, planFile)} (${images} images)`);
	const zips = await fetchZips(workDir, env.E2E_CACHE_DIR ?? join(homedir(), ".cache", "wp2emdash-e2e"), { log });
	log(`zips: ${zips.join(", ")}`);
}

async function pipeline(): Promise<number> {
	const bad = forbiddenEnv(env);
	if (bad.length) {
		console.error(`[e2e] refusing to run with ${bad.join(", ")} set: the end-to-end test never talks to Cloudflare or a real EmDash site. Unset them.`);
		return 1;
	}
	Object.assign(env, { WP2EMDASH_NO_PRODUCTION: "1", WP2EMDASH_LOAD_TARGET: "local", WP2EMDASH_TARGET: "local", WRANGLER_SEND_METRICS: "false", ASTRO_TELEMETRY_DISABLED: "1" });
	const startedAt = new Date().toISOString();
	const wpUrl = (env.E2E_WP_URL ?? "http://localhost:8080").replace(/\/$/, "");
	const outDir = env.E2E_OUT ?? join(workDir, "report");
	rmSync(outDir, { recursive: true, force: true });
	mkdirSync(join(outDir, "logs"), { recursive: true });
	const exp = JSON.parse(readFileSync(join(E2E_DIR, "expectations.json"), "utf8")) as Expectations;
	const plan = buildSeedPlan();
	const notes: string[] = [];

	const pwFile = join(workDir, "app-password");
	if (!existsSync(pwFile)) {
		console.error(`[e2e] ${pwFile} missing: seed WordPress first (e2e/run.sh does).`);
		return 1;
	}
	const appPassword = readFileSync(pwFile, "utf8").trim();
	const sitesDir = env.E2E_SITES_DIR ?? mkdtempSync(join(tmpdir(), "wp2emdash-e2e-"));
	if (sitesDir.startsWith(join(KIT_ROOT, "sites"))) {
		console.error("[e2e] E2E_SITES_DIR must not be the kit's sites/ folder.");
		return 1;
	}
	const site = createE2eSite({ sitesDir, wpUrl, appPassword, workDir, fullDefaults: env.E2E_FULL_DEFAULTS === "1" });
	// The kit .env (a maintainer's machine) may hold a Cloudflare token: blank those keys for this site (site .env wins).
	const kitKeys = Object.keys(loadEnv(join(KIT_ROOT, ".env"))).filter((k) => KIT_ENV_BLANK.test(k));
	if (kitKeys.length) {
		writeFileSync(join(site.root, ".env"), `${readFileSync(join(site.root, ".env"), "utf8")}${kitKeys.map((k) => `${k}=`).join("\n")}\n`);
		notes.push(`Kit .env keys blanked for the e2e site: ${kitKeys.join(", ")}`);
	}
	log(`site ${site.root}`);
	const paths = sitePaths(E2E_SLUG, sitesDir);
	const runner = (phase: Parameters<typeof runPhase>[1], o: { preview: boolean }) => runPhase(E2E_SLUG, phase, { sitesDir, ...(o.preview ? { preview: true } : {}) });

	const phases: PhaseOutcome[] = await runPhases(["init", "audit", "extract", "transform", "scaffold"], runner, { stopAfterFailure: exp.stopAfterFailure, log });
	const assertions: Assertion[] = [];

	// load + verify against the generated project's local dev server (local D1/R2 under the project's .wrangler).
	const canServe = existsSync(join(paths.project, "package.json")) && existsSync(join(paths.project, "node_modules"));
	if (env.E2E_SKIP_LOAD === "1" || !canServe) {
		const why = env.E2E_SKIP_LOAD === "1" ? "E2E_SKIP_LOAD=1" : "no installed project (scaffold did not get that far)";
		notes.push(`load, verify and the rendered-page checks were not run: ${why}`);
		for (const phase of ["load", "verify"] as const) phases.push({ phase, mode: "skipped", ok: false, checks: [], ms: 0, error: why });
		assertions.push(...renderedAssertions([], plan.expected).map((a) => ({ ...a, ok: false, skipped: true, detail: why })));
	} else {
		const port = Number(env.E2E_DEV_PORT ?? 4399);
		env.WP2EMDASH_DEV_PORT = String(port);
		let server: Awaited<ReturnType<typeof startDevServer>> | undefined;
		try {
			log(`starting the project's dev server on :${port} (log: logs/dev-server.log)`);
			server = await startDevServer(paths.project, port, join(outDir, "logs", "dev-server.log"));
		} catch (e) {
			notes.push(`dev server: ${(e as Error).message}`);
		}
		if (!server) {
			for (const phase of ["load", "verify"] as const) phases.push({ phase, mode: "skipped", ok: false, checks: [], ms: 0, error: "the project's dev server did not start (logs/dev-server.log)" });
			assertions.push(...renderedAssertions([], plan.expected).map((a) => ({ ...a, ok: false, skipped: true, detail: "dev server did not start" })));
		} else {
			try {
				phases.push(...(await runPhases(["load", "verify"], runner, { log, startBroken: phases.some((p) => !p.ok) })));
				const fetched: FetchedPage[] = [];
				for (const path of pathsToRender(plan.expected)) {
					try {
						const r = await fetch(`${server.base}${path}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
						fetched.push({ path, status: r.status, html: await r.text() });
					} catch (e) {
						fetched.push({ path, status: 0, html: "", error: (e as Error).message });
					}
				}
				mkdirSync(join(outDir, "rendered"), { recursive: true });
				for (const f of fetched) writeFileSync(join(outDir, "rendered", `${f.path.replace(/^\/|\/$/g, "").replace(/\//g, "__") || "home"}.html`), f.html || `<!-- HTTP ${f.status} ${f.error ?? ""} -->`);
				const names = new Map(plan.products.map((p) => [p.slug, p.name]));
				assertions.push(...renderedAssertions(fetched, plan.expected, (s) => names.get(s)));
			} finally {
				await server.stop();
			}
		}
	}
	assertions.unshift(...outputAssertions({ siteRoot: site.root, project: paths.project, expected: plan.expected, allowedElementorDiagnostics: exp.allowedElementorDiagnostics }));

	// ── Report ────────────────────────────────────────────────────────────────────────────────────────────────
	const v = verdict(phases, assertions, exp);
	const files = [
		...copyInto(site.root, SITE_COPY, join(outDir, "site"), env.E2E_KEEP_SCREENS === "1").map((f) => `site/${f}`),
		...copyInto(paths.project, PROJECT_COPY, join(outDir, "project")).map((f) => `project/${f}`),
	];
	for (const f of ["seed-summary.txt", "seed.log", "seed-plan.json"]) if (existsSync(join(workDir, f))) copyInto(workDir, [f], outDir).forEach((x) => files.push(x));
	const astroLogs = existsSync(join(paths.project, ".astro")) ? readdirSync(join(paths.project, ".astro")).filter((f) => f.endsWith(".log")) : [];
	files.push(...copyInto(join(paths.project, ".astro"), astroLogs, join(outDir, "logs", "astro")).map((f) => `logs/astro/${f}`));
	const input = { verdict: v, phases, assertions, startedAt, finishedAt: new Date().toISOString(), wpUrl, notes, files: ["report.md", "report.json", "logs/", "rendered/", ...files], env };
	writeFileSync(join(outDir, "report.md"), reportMarkdown(input));
	writeFileSync(join(outDir, "report.json"), `${JSON.stringify(reportJson(input), null, 2)}\n`);
	const scrubbed = scrubSecrets(outDir, [appPassword]);
	if (scrubbed) log(`credentials scrubbed from ${scrubbed} report file(s)`);
	log(`report: ${join(outDir, "report.md")}`);
	log(v.ok ? "PASSED" : `FAILED:\n  - ${v.reasons.join("\n  - ")}`);
	if (!env.E2E_SITES_DIR) rmSync(sitesDir, { recursive: true, force: true });
	return v.ok ? 0 : 2;
}

const direct = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const cmd = direct ? process.argv[2] : undefined;
if (cmd === "prepare") {
	prepare().then(
		() => process.exit(0),
		(e) => {
			console.error(`[e2e] prepare failed: ${(e as Error).message}`);
			process.exit(1);
		},
	);
} else if (cmd === "pipeline") {
	pipeline().then(
		(code) => process.exit(code),
		(e) => {
			console.error(`[e2e] runner crashed: ${(e as Error).stack ?? e}`);
			process.exit(1);
		},
	);
} else if (direct) {
	console.error("usage: tsx e2e/run.ts prepare|pipeline");
	process.exit(1);
}
