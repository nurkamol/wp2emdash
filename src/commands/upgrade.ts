/**
 * `wp2emdash upgrade <slug>`: move an already-delivered site to the current kit version, and prove nothing a visitor
 * sees changed.
 *
 *   1. Before: snapshot every page of the address the client is live on (the production domain after go-live, else
 *      production's workers.dev address — the same address the deploy scripts check, src/phases/scaffold.ts
 *      `deployUrls`) → reports/upgrade/<timestamp>/before.json. Read-only GETs.
 *   2. Rebuild: the scaffold phase (same engine as `wp2emdash run <slug> scaffold`; its gate is recorded). A failed
 *      gate stops here.
 *   3. Staging (opt-in sites only): with --deploy-staging, the project's `ci:deploy:staging` script, then a staging
 *      snapshot compared with before. Without the flag nothing is deployed. With --sync-staging as well, staging is
 *      first refreshed with production's content (src/commands/sync-staging.ts) — before any snapshot — so the
 *      comparison runs on real content. The sync is a dry run unless --yes is given too: without it upgrade prints the
 *      sync plan and stops (exit 1) before snapshotting, rebuilding or deploying anything.
 *   4. Production is never deployed from here: the exact command is printed for the owner. Afterwards
 *      `wp2emdash upgrade <slug> --verify` snapshots production again and compares it with the saved before.json
 *      (`--verify staging` / `--verify <url>` compare another address, e.g. a Workers version preview URL).
 *
 * Exit codes like `run`: 0 identical / only expected changes · 2 differences found or the scaffold gate failed ·
 * 1 error.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig } from "../config/load.js";
import { readCf, siteEnvironments } from "../core/environments.js";
import { KIT_ROOT, sitePaths } from "../core/paths.js";
import { blockingPhase, type GateCheck, readState } from "../core/state.js";
import { loadSiteEnv, scrubSecrets } from "../extract/credentials.js";
import { type Comparison, compareSnapshots, comparisonReport, htmlToSnapshot, locationKey, type PageSnapshot, type SiteSnapshot, sitemapLocs, statusSnapshot } from "../upgrade/snapshot.js";
import { STACK } from "../phases/scaffold.js";
import { preChangeMarker } from "../targets/d1-backup.js";
import { defaultEmdashRunner, type EmdashPlan, type EmdashRunner, parseMigrateStatus, planEmdashStep, projectEmdashVersion } from "../upgrade/emdash.js";
import { credentialsFor } from "./provision.js";
import { runPhase } from "./run.js";
import { syncStaging, type SyncStagingOptions, type SyncStagingResult } from "./sync-staging.js";

/** The only project script this command ever runs. Production deploy scripts are refused by name. */
export const STAGING_DEPLOY_SCRIPT = "ci:deploy:staging";

export interface UpgradeOptions {
	sitesDir?: string;
	/** Compare the latest before.json with this address now: "production" (default for --verify), "staging" or a URL. */
	verify?: "production" | "staging" | string;
	/** Opt-in staging sites: run the project's ci:deploy:staging, then compare staging with before. */
	deployStaging?: boolean;
	/** Snapshot at most this many pages (default 300). */
	limit?: number;
	/** Rebuild like `run <slug> scaffold --preview`: earlier gates are not required and nothing is recorded in state.json
	 * (sites delivered before the kit recorded every phase). */
	preview?: boolean;
	/** With deployStaging: refresh staging with production's content first (wp2emdash sync-staging). */
	syncStaging?: boolean;
	/** Apply the sync; without it the sync plan is printed and upgrade stops before anything else. Also confirms
	 * --prepare-db and --after-release. */
	yes?: boolean;
	/** EmDash version change, step 2: recovery point (D1 bookmark + Backups marker), then the new version's database
	 * changes alone, while the older Worker keeps serving (src/upgrade/emdash.ts). Dry run without --yes. */
	prepareDb?: boolean;
	/** EmDash version change, last step: the release's one-time steps (e.g. media usage repair). Dry run without --yes. */
	afterRelease?: boolean;
	/** Progress lines (the CLI prints them; --json and the MCP server leave it out). */
	log?: (line: string) => void;
}

export interface UpgradeDeps {
	fetcher?: typeof fetch;
	/** Rebuild: the scaffold phase. Default: the engine's runPhase (gate recorded). */
	runScaffold?: (slug: string) => Promise<{ ok: boolean; runId: string; checks: GateCheck[] }>;
	/** Runs a project script (only ever STAGING_DEPLOY_SCRIPT). Default: `pnpm run <script>` in the project folder. */
	runScript?: (script: string, cwd: string, env: Record<string, string>) => Promise<{ code: number; out: string }>;
	now?: () => Date;
	/** The staging sync (default: sync-staging's engine). */
	syncStaging?: (slug: string, opts: SyncStagingOptions) => Promise<SyncStagingResult>;
	/** Wait after a sync before staging is snapshotted (isolates keep settings 30 s). Default: setTimeout. */
	sleep?: (ms: number) => Promise<void>;
	/** EmDash CLI calls (status, migrate, media repair). Default: npx emdash in the project. */
	emdash?: EmdashRunner;
	/** The EmDash version the project runs before the rebuild. Default: its installed package. */
	installedEmdash?: (project: string) => string | undefined;
	/** Recovery point before the database changes. Default: preChangeMarker (D1 bookmark + Backups marker). */
	marker?: typeof preChangeMarker;
}

/** reports/upgrade/<timestamp>/emdash.json: the EmDash step's plan and what has been done. */
export interface EmdashRecord extends EmdashPlan {
	at: string;
	previewVerified?: { at: string; url: string };
	prepared?: { at: string; bookmark?: string; marker: string; applied: string[] };
	afterRelease?: { at: string; steps: { id: string; ok: boolean; detail: string }[] };
}

/** After a sync: Worker isolates keep a 30 s stale-while-revalidate copy of the settings (docs/spikes/settings-findings.md). */
export const SYNC_SETTLE_MS = 35_000;

export interface ComparisonSummary {
	label: string;
	identical: boolean;
	pagesCompared: number;
	pagesWithDifferences: number;
	pagesWithNotices: number;
	json: string;
	md: string;
}

export interface UpgradeResult {
	slug: string;
	mode: "upgrade" | "verify" | "prepare-db" | "after-release";
	/** reports/upgrade/<timestamp>/ */
	dir: string;
	production: string;
	staging?: string;
	before?: { file: string; pages: number };
	scaffold?: { ok: boolean; runId: string; failing: GateCheck[] };
	stagingDeploy?: { ran: boolean; ok?: boolean; reason?: string };
	/** --sync-staging: the sync's result (counts and table names only). */
	syncStaging?: SyncStagingResult;
	/** The EmDash version changes with this upgrade: plan and progress (emdash.json). */
	emdash?: EmdashRecord;
	comparisons: ComparisonSummary[];
	next: string[];
	ok: boolean;
	/** 0 identical / expected changes only · 2 differences or scaffold gate failed · 1 error */
	exitCode: 0 | 1 | 2;
	error?: string;
}

const kitVersion = (): string | undefined => {
	try {
		return (JSON.parse(readFileSync(join(KIT_ROOT, "package.json"), "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
};

const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");

/** The address the client is live on, and staging's (opt-in), from kit.config and cloudflare.json. */
export function upgradeAddresses(config: { target: { productionUrl: string; stagingUrl?: string | undefined; staging?: unknown } }, cf: ReturnType<typeof readCf>): { production?: string; staging?: string; hasStaging: boolean; live: boolean } {
	const envs = siteEnvironments(config as never, cf);
	const production = cf.production?.live ? config.target.productionUrl : cf.production?.worker?.url;
	const staging = envs.staging ? (cf.staging?.worker?.url ?? config.target.stagingUrl) : undefined;
	return { ...(production ? { production: production.replace(/\/$/, "") } : {}), ...(staging ? { staging: staging.replace(/\/$/, "") } : {}), hasStaging: envs.staging, live: envs.live };
}

async function get(fetcher: typeof fetch, url: string, tries = 3): Promise<{ status: number; type: string; body: string; location?: string; error?: string }> {
	let last: { status: number; type: string; body: string; location?: string; error?: string } = { status: 0, type: "", body: "" };
	for (let i = 0; i < tries; i++) {
		try {
			const res = await fetcher(url, { redirect: "manual", headers: { "user-agent": "wp2emdash-upgrade-check" }, signal: AbortSignal.timeout(20_000) });
			const type = res.headers.get("content-type") ?? "";
			const body = /text|html|xml|css|json/.test(type) ? await res.text() : (await res.arrayBuffer(), "");
			const location = res.headers.get("location");
			last = { status: res.status, type, body, ...(location ? { location } : {}) };
			if (res.status < 500 && res.status !== 0) return last;
		} catch (e) {
			last = { status: 0, type: "", body: "", error: (e as Error).message };
		}
		if (i < tries - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
	}
	return last;
}

/**
 * Snapshot of `origin`: the home page, every sitemap URL (index followed one level), and `extraPaths` (the before
 * snapshot's pages, so a page gone from the sitemap still shows up as missing). Sitemap URLs on another host
 * (staging lists production addresses) are rebased onto `origin`.
 */
export async function takeSnapshot(origin: string, label: string, o: { fetcher?: typeof fetch; extraPaths?: string[]; limit?: number; now?: () => Date; log?: (l: string) => void } = {}): Promise<SiteSnapshot> {
	const fetcher = o.fetcher ?? fetch;
	const base = new URL(origin).origin;
	const local = (u: string) => {
		try {
			const x = new URL(u, base);
			return x.pathname + x.search;
		} catch {
			return undefined;
		}
	};
	const paths = new Set<string>(["/"]);
	const index = await get(fetcher, `${base}/sitemap.xml`);
	let listed = 0;
	if (index.status === 200) {
		for (const loc of sitemapLocs(index.body)) {
			const p = local(loc);
			if (!p) continue;
			if (/\.xml$/.test(p.split("?")[0] ?? "")) {
				const part = await get(fetcher, base + p);
				for (const u of sitemapLocs(part.body)) {
					const q = local(u);
					if (q) {
						paths.add(q);
						listed++;
					}
				}
			} else {
				paths.add(p);
				listed++;
			}
		}
	}
	for (const p of o.extraPaths ?? []) paths.add(p);
	const all = [...paths];
	const limit = o.limit ?? 300;
	const list = all.slice(0, limit);
	o.log?.(`${label}: ${list.length} page(s) from ${base}${index.status === 200 ? "" : ` (sitemap.xml answered ${index.status || index.error})`}`);
	const cssCache = new Map<string, Promise<string>>();
	const css = (href: string) => {
		let p = cssCache.get(href);
		if (!p) {
			p = get(fetcher, href, 2).then((r) => (r.status === 200 ? r.body : ""));
			cssCache.set(href, p);
		}
		return p;
	};
	const pages: PageSnapshot[] = [];
	for (let i = 0; i < list.length; i += 4) {
		const batch = await Promise.all(
			(list.slice(i, i + 4) as string[]).map(async (path) => {
				const url = base + path;
				const r = await get(fetcher, url);
				if (r.status !== 200 || !/html/.test(r.type)) return statusSnapshot(url, r.status, { ...(r.location ? { location: locationKey(r.location, url) as string } : {}), ...(r.error ? { error: r.error } : {}) });
				// Same-origin stylesheets, for the @font-face families (fetched once per address).
				const hrefs = [...r.body.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]).filter((t) => /rel=["']?[^"'>]*stylesheet/i.test(t)).map((t) => /href=["']([^"']+)["']/i.exec(t)?.[1]?.replace(/&amp;/g, "&")).filter((h): h is string => !!h);
				const sheets = await Promise.all(hrefs.map((h) => new URL(h, url)).filter((u) => u.origin === base).map((u) => css(u.href)));
				return htmlToSnapshot(r.body, url, 200, sheets);
			}),
		);
		pages.push(...batch);
	}
	const v = kitVersion();
	return { origin: base, label, takenAt: (o.now ?? (() => new Date()))().toISOString(), ...(v ? { kitVersion: v } : {}), pages, ...(all.length > list.length ? { skipped: all.length - list.length } : {}), sitemap: { status: index.status, urls: listed } };
}

const writeJson = (file: string, v: unknown) => writeFileSync(file, `${JSON.stringify(v, null, 2)}\n`);

function writeComparison(dir: string, name: string, title: string, c: Comparison, root: string): ComparisonSummary {
	const json = join(dir, `compare-${name}.json`);
	const md = join(dir, `compare-${name}.md`);
	writeJson(json, c);
	writeFileSync(md, comparisonReport(c, title));
	return { label: name, identical: c.identical, pagesCompared: c.pagesCompared, pagesWithDifferences: c.pagesWithDifferences, pagesWithNotices: c.pagesWithNotices, json: relative(root, json), md: relative(root, md) };
}

/** The newest reports/upgrade/<timestamp>/ that holds a before.json. */
export function latestUpgradeDir(reports: string): string | undefined {
	const base = join(reports, "upgrade");
	if (!existsSync(base)) return undefined;
	const dirs = readdirSync(base, { withFileTypes: true })
		.filter((d) => d.isDirectory() && existsSync(join(base, d.name, "before.json")))
		.map((d) => d.name)
		.sort();
	const last = dirs.at(-1);
	return last ? join(base, last) : undefined;
}

/** `pnpm run <script>` in the project folder; refuses anything but the staging deploy. */
export async function defaultRunScript(script: string, cwd: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
	assertStagingScript(script);
	return new Promise((resolve) => {
		const p = spawn("pnpm", ["run", script], { cwd, env: { ...process.env, ...env, CI: "1", FORCE_COLOR: "0" } });
		let out = "";
		p.stdout.on("data", (b: Buffer) => (out += b.toString()));
		p.stderr.on("data", (b: Buffer) => (out += b.toString()));
		p.on("error", (e) => resolve({ code: 1, out: `${out}${e.message}` }));
		p.on("close", (code) => resolve({ code: code ?? 1, out }));
	});
}

export function assertStagingScript(script: string): void {
	if (script !== STAGING_DEPLOY_SCRIPT || /production/i.test(script)) throw new Error(`Refused: upgrade only ever runs ${STAGING_DEPLOY_SCRIPT}; production deploys are the owner's step.`);
}

/** The command the owner runs to deploy production (printed, never run). */
export function productionDeployCommand(project: string): string {
	let scripts: Record<string, string> = {};
	try {
		scripts = (JSON.parse(readFileSync(join(project, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
	} catch {
		// project not built
	}
	return `cd ${project} && pnpm run ${scripts["ci:deploy:production"] ? "ci:deploy:production" : "deploy:production"}`;
}

const EMDASH_FILE = "emdash.json";
function readEmdash(dir: string | undefined): EmdashRecord | undefined {
	if (!dir || !existsSync(join(dir, EMDASH_FILE))) return undefined;
	return JSON.parse(readFileSync(join(dir, EMDASH_FILE), "utf8")) as EmdashRecord;
}

/** The safe order once the EmDash version changes (src/upgrade/emdash.ts), as the owner reads it. */
export function emdashSequence(slug: string, project: string, rec: EmdashRecord): string[] {
	const undo = rec.prepared?.bookmark ? ` Restore the database only if data went wrong: npx wrangler d1 time-travel restore <database> --bookmark=${rec.prepared.bookmark}` : "";
	return [
		`EmDash ${rec.from} → ${rec.to}: ${rec.pending.length ? `database change(s) to apply: ${rec.pending.join(", ")}` : "no database change"}.${rec.after.length ? ` After the release: ${rec.after.map((a) => a.id).join(", ")}.` : ""}`,
		`${rec.prepared ? "✔" : "1."} Recovery point + database changes (the live site keeps working): pnpm wp2emdash upgrade ${slug} --prepare-db --yes`,
		`${rec.previewVerified ? "✔" : "2."} Preview, required: cd ${project} && pnpm run versions:upload → pnpm wp2emdash upgrade ${slug} --verify <preview-url>`,
		`3. Production (owner's approval, never run by the kit): cd ${project} && pnpm run versions:deploy <version-id> — the Worker Version ID versions:upload printed: exactly the version that was previewed, no prompt`,
		`4. Then: pnpm wp2emdash upgrade ${slug} --verify${rec.after.length ? `, and pnpm wp2emdash upgrade ${slug} --after-release --yes` : ""}`,
		`Undo: cd ${project} && npx wrangler rollback (the older EmDash works on the changed database).${undo}`,
	];
}

export async function upgrade(slug: string, opts: UpgradeOptions = {}, deps: UpgradeDeps = {}): Promise<UpgradeResult> {
	const paths = sitePaths(slug, opts.sitesDir);
	if (!existsSync(paths.config)) throw new Error(`No site "${slug}" (sites/${slug}/kit.config.ts)`);
	const config = await loadConfig(paths.config);
	const cf = readCf(paths.root);
	const addr = upgradeAddresses(config, cf);
	const fetcher = deps.fetcher ?? fetch;
	const now = deps.now ?? (() => new Date());
	const log = opts.log ?? (() => {});
	const vars = { ...process.env, ...loadSiteEnv(paths.root) } as Record<string, string | undefined>;
	const secretValues = Object.fromEntries(Object.entries(loadSiteEnv(paths.root)).filter(([, v]) => v));
	const scrub = (s: string) => scrubSecrets(s, secretValues);
	const snapOpts = { fetcher, now, log, ...(opts.limit ? { limit: opts.limit } : {}) };
	if (!addr.production) throw new Error(`No production address for ${slug}: production is neither live (cloudflare.json production.live) nor provisioned with a workers.dev address. upgrade is for delivered sites.`);
	const production = addr.production;
	const base = { slug, production, ...(addr.staging ? { staging: addr.staging } : {}) };

	const em = deps.emdash ?? defaultEmdashRunner;
	const prodCreds = () => {
		const c = credentialsFor("production", vars, cf as never);
		return { ...(c.token ? { CLOUDFLARE_API_TOKEN: c.token } : {}), ...(c.accountId ? { CLOUDFLARE_ACCOUNT_ID: c.accountId } : {}) } as Record<string, string>;
	};

	// ── --prepare-db: recovery point, then the new EmDash version's database changes alone ──
	if (opts.prepareDb) {
		const dir = latestUpgradeDir(paths.reports);
		const rec = readEmdash(dir);
		if (!dir || !rec) throw new Error(`No EmDash step recorded: run \`wp2emdash upgrade ${slug}\` first (it plans the database changes when the EmDash version changes).`);
		const rel = relative(paths.root, dir);
		const done = (r: Partial<UpgradeResult> & { next: string[]; ok: boolean; exitCode: 0 | 1 | 2 }) => ({ ...base, mode: "prepare-db" as const, dir: rel, emdash: rec, comparisons: [], ...r });
		if (rec.blockers.length) return done({ next: ["The plan has blockers; nothing was applied.", ...rec.blockers], ok: false, exitCode: 2, error: "blockers" });
		if (projectEmdashVersion(paths.project) !== rec.to && !deps.emdash) return done({ next: [`The project is not on EmDash ${rec.to} (rebuild with \`wp2emdash upgrade ${slug}\`).`], ok: false, exitCode: 1, error: "project not rebuilt" });
		// The database must still be the one planned against, with nothing unexpected since.
		const st = await em.status(paths.project, prodCreds());
		if (st.code !== 0) return done({ next: [`emdash migrate --status failed (exit ${st.code}): ${scrub(st.out).slice(-400)}`], ok: false, exitCode: 1, error: "status failed" });
		const now1 = parseMigrateStatus(st.out);
		if (rec.fingerprint && now1.fingerprint !== rec.fingerprint) return done({ next: [`The database answering is not the one planned against (fingerprint changed). Nothing was applied; rerun \`wp2emdash upgrade ${slug}\`.`], ok: false, exitCode: 2, error: "fingerprint changed" });
		if (now1.unknownApplied.length) return done({ next: [`Unknown database changes appeared: ${now1.unknownApplied.join(", ")}. Nothing was applied.`], ok: false, exitCode: 2, error: "unknown applied" });
		if (!now1.pending.length) {
			rec.prepared ??= { at: now().toISOString(), marker: "nothing to apply", applied: [] };
			writeJson(join(dir, EMDASH_FILE), rec);
			return done({ next: ["No database change is pending.", ...emdashSequence(slug, paths.project, rec)], ok: true, exitCode: 0 });
		}
		const plan = [`Recovery point: D1 Time Travel bookmark of ${cf.production?.d1?.name ?? "the production database"} + a marker on the Backups page`, `Apply: ${now1.pending.join(", ")} (emdash migrate --expected-target-fingerprint=${(now1.fingerprint ?? "").slice(0, 12)}…, then --check)`, "The live Worker keeps serving the older EmDash, which accepts the changed database"];
		for (const p of plan) log(`  - ${p}`);
		if (!opts.yes) return done({ next: [...plan, `Nothing changed. After the owner's go-ahead: pnpm wp2emdash upgrade ${slug} --prepare-db --yes`], ok: false, exitCode: 1, error: "dry run without --yes" });
		const mark = await (deps.marker ?? preChangeMarker)({ reason: `EmDash ${rec.from} → ${rec.to}: before the database changes`, cf: cf as never, vars, bookmarksFile: join(paths.root, "load", "d1-bookmarks.jsonl"), now: now() });
		log(`${mark.ok ? "✔" : "✖"} ${mark.detail}`);
		if (!mark.bookmark) return done({ next: [`No recovery point (${mark.detail}); nothing was applied. Fix the Cloudflare token (D1 read) and rerun.`], ok: false, exitCode: 1, error: "no bookmark" });
		const m = await em.migrate(paths.project, prodCreds(), now1.fingerprint as string);
		writeFileSync(join(dir, "prepare-db.log"), scrub(m.out));
		const after1 = await em.status(paths.project, prodCreds());
		const left = after1.code === 0 ? parseMigrateStatus(after1.out).pending : now1.pending;
		if (m.code !== 0 || left.length) return done({ next: [`Applying the database changes failed (exit ${m.code}; still pending: ${left.join(", ") || "none"}; log ${rel}/prepare-db.log). The live site runs the older EmDash. Recovery point: bookmark ${mark.bookmark}.`], ok: false, exitCode: 1, error: "migrate failed" });
		rec.prepared = { at: now().toISOString(), bookmark: mark.bookmark, marker: mark.detail, applied: now1.pending };
		writeJson(join(dir, EMDASH_FILE), rec);
		log(`✔ Applied ${now1.pending.join(", ")}`);
		return done({ next: emdashSequence(slug, paths.project, rec), ok: true, exitCode: 0 });
	}

	// ── --after-release: the release's one-time steps, after production runs the new version ──
	if (opts.afterRelease) {
		const dir = latestUpgradeDir(paths.reports);
		const rec = readEmdash(dir);
		if (!dir || !rec) throw new Error(`No EmDash step recorded for ${slug}: nothing to run after a release.`);
		const rel = relative(paths.root, dir);
		const done = (r: Partial<UpgradeResult> & { next: string[]; ok: boolean; exitCode: 0 | 1 | 2 }) => ({ ...base, mode: "after-release" as const, dir: rel, emdash: rec, comparisons: [], ...r });
		if (!rec.after.length) return done({ next: [`EmDash ${rec.to} asks for nothing after its release.`], ok: true, exitCode: 0 });
		const token = vars.EMDASH_TOKEN_PRODUCTION;
		const plan = rec.after.map((a) => `${a.id}: ${a.label} on ${production}`);
		for (const p of plan) log(`  - ${p}`);
		if (!opts.yes) return done({ next: [...plan, `Nothing changed. After production runs EmDash ${rec.to}: pnpm wp2emdash upgrade ${slug} --after-release --yes`], ok: false, exitCode: 1, error: "dry run without --yes" });
		if (!token) return done({ next: ["EMDASH_TOKEN_PRODUCTION (an admin token) is not set in the site's .env."], ok: false, exitCode: 1, error: "no token" });
		const steps: { id: string; ok: boolean; detail: string }[] = [];
		for (const a of rec.after) {
			if (a.id === "media-repair-usage") {
				const r = await em.repairMediaUsage(paths.project, production, token);
				let detail = `exit ${r.code}`;
				try {
					const j = JSON.parse(r.out.slice(r.out.indexOf("{"))) as { status?: string };
					detail = `status ${j.status ?? "?"}`;
				} catch {
					detail = scrub(r.out).trim().slice(-200) || detail;
				}
				steps.push({ id: a.id, ok: r.code === 0, detail });
				log(`${r.code === 0 ? "✔" : "✖"} ${a.id}: ${detail}`);
			}
		}
		rec.afterRelease = { at: now().toISOString(), steps };
		writeJson(join(dir, EMDASH_FILE), rec);
		const ok = steps.every((x) => x.ok);
		return done({ next: ok ? [`EmDash ${rec.to} upgrade complete.`] : ["A step failed; rerun it (each is safe to repeat)."], ok, exitCode: ok ? 0 : 1 });
	}

	// ── --verify: compare an address now with the saved before.json ──
	if (opts.verify !== undefined) {
		const dir = latestUpgradeDir(paths.reports);
		if (!dir) throw new Error(`No before snapshot: run \`wp2emdash upgrade ${slug}\` first (reports/upgrade/<timestamp>/before.json).`);
		const where = opts.verify || "production";
		let target: string;
		let name: string;
		if (where === "production") [target, name] = [production, "production"];
		else if (where === "staging") {
			if (!addr.staging) throw new Error(`${slug} has no staging address (staging is opt-in: target.staging, target.stagingUrl).`);
			[target, name] = [addr.staging, "staging"];
		} else {
			let u: URL;
			try {
				u = new URL(where);
			} catch {
				throw new Error(`--verify takes production, staging or an http(s) URL, not "${where}"`);
			}
			if (!/^https?:$/.test(u.protocol)) throw new Error(`--verify takes production, staging or an http(s) URL, not "${where}"`);
			[target, name] = [u.origin, `url-${u.host.replace(/[^a-z0-9.-]/gi, "-")}`];
		}
		const before = JSON.parse(readFileSync(join(dir, "before.json"), "utf8")) as SiteSnapshot;
		const after = await takeSnapshot(target, name, { ...snapOpts, extraPaths: before.pages.map((p) => p.path) });
		writeJson(join(dir, `after-${name}.json`), after);
		const c = compareSnapshots(before, after);
		const summary = writeComparison(dir, name, `Upgrade check: ${name} vs before (${slug})`, c, paths.root);
		const rec = readEmdash(dir);
		if (rec && c.identical && name !== "production" && name !== "staging") {
			rec.previewVerified = { at: now().toISOString(), url: target };
			writeJson(join(dir, EMDASH_FILE), rec);
		}
		let next = c.identical ? (name === "production" ? ["Production matches the snapshot taken before the upgrade. Done."] : [`${name} matches. Deploy production when the owner approves: ${productionDeployCommand(paths.project)}`, `Then: pnpm wp2emdash upgrade ${slug} --verify`]) : [`Read ${summary.md} — every difference is listed per page.`, ...(name === "production" ? ["If the upgrade broke something, roll back the Worker to the previous version (`npx wrangler rollback` in the project, owner step) and fix the cause in the kit."] : [])];
		if (rec && c.identical) next = name === "production" ? [`Production matches the snapshot taken before the upgrade.${rec.after.length && !rec.afterRelease ? ` Last step: pnpm wp2emdash upgrade ${slug} --after-release --yes` : " Done."}`] : emdashSequence(slug, paths.project, rec);
		return { ...base, mode: "verify", ...(rec ? { emdash: rec } : {}), dir: relative(paths.root, dir), before: { file: relative(paths.root, join(dir, "before.json")), pages: before.pages.length }, comparisons: [summary], next, ok: c.identical, exitCode: c.identical ? 0 : 2 };
	}

	// ── upgrade: before snapshot, scaffold, optional staging deploy + comparison ──
	// Gates before scaffold must have passed (or --preview): checked first, so no snapshot is taken for nothing.
	if (!opts.preview && !deps.runScaffold && existsSync(paths.state)) {
		const blocker = blockingPhase(readState(paths.state), "scaffold");
		if (blocker) return { ...base, mode: "upgrade", dir: "", comparisons: [], next: [`The "${blocker}" gate has not passed in state.json, so scaffold cannot run. Sites delivered before the kit recorded every phase: \`wp2emdash upgrade ${slug} --preview\` (rebuilds without touching state.json).`], ok: false, exitCode: 1, error: `gate "${blocker}" has not passed` };
	}
	// --sync-staging: staging gets production's content first, before any snapshot (a refusal or dry run stops here).
	let synced: SyncStagingResult | undefined;
	if (opts.syncStaging) {
		if (!addr.hasStaging) return { ...base, mode: "upgrade", dir: "", comparisons: [], next: [`${slug} has one environment (production): --sync-staging is only for sites with staging.`], ok: false, exitCode: 1, error: "no staging environment" };
		if (!opts.deployStaging) return { ...base, mode: "upgrade", dir: "", comparisons: [], next: ["--sync-staging goes with --deploy-staging (the sync is for the staging comparison)."], ok: false, exitCode: 1, error: "--sync-staging without --deploy-staging" };
		log("Staging sync: production's content → staging");
		synced = await (deps.syncStaging ?? ((s: string, o: SyncStagingOptions) => syncStaging(s, o)))(slug, { ...(opts.sitesDir ? { sitesDir: opts.sitesDir } : {}), yes: !!opts.yes, log });
		if (!synced.applied) {
			const dry = synced.exitCode === 0;
			return { ...base, mode: "upgrade", dir: "", syncStaging: synced, comparisons: [], next: dry ? [`Read the sync plan above, then rerun with --yes: pnpm wp2emdash upgrade ${slug} --deploy-staging --sync-staging --yes. Nothing was snapshotted, rebuilt or deployed.`] : [...synced.next, "Nothing was snapshotted, rebuilt or deployed."], ok: false, exitCode: synced.exitCode === 2 ? 2 : 1, error: dry ? "--sync-staging is a dry run without --yes" : (synced.error ?? "staging sync failed") };
		}
		if (synced.exitCode !== 0) return { ...base, mode: "upgrade", dir: "", syncStaging: synced, comparisons: [], next: [...synced.next, "Nothing was snapshotted, rebuilt or deployed."], ok: false, exitCode: synced.exitCode, error: synced.error ?? "staging sync finished with differences" };
		await (deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(SYNC_SETTLE_MS);
	}
	const dir = join(paths.reports, "upgrade", stamp(now()));
	mkdirSync(dir, { recursive: true });
	const rel = relative(paths.root, dir);
	log(`Before: snapshot of ${production}${addr.live ? " (live domain)" : " (workers.dev, not live yet)"}`);
	const before = await takeSnapshot(production, "before", snapOpts);
	const home = before.pages.find((p) => p.path === "/");
	const beforeFile = join(dir, "before.json");
	writeJson(beforeFile, before);
	if (!home || home.status === 0 || home.status >= 500) {
		return { ...base, mode: "upgrade", dir: rel, before: { file: relative(paths.root, beforeFile), pages: before.pages.length }, comparisons: [], next: [`Production (${production}) did not answer (home page: ${home?.status || home?.error || "no answer"}). Nothing was rebuilt.`], ok: false, exitCode: 1, error: "production did not answer" };
	}
	log(`Saved ${relative(paths.root, beforeFile)} (${before.pages.length} pages)`);
	// --deploy-staging: staging is snapshotted too, before the rebuild, and the deployed staging is compared with it — the
	// same environment before and after, so only what the upgrade changed shows (staging may already differ from
	// production, e.g. a production that has not been redeployed since staging moved on).
	let stagingBefore: SiteSnapshot | undefined;
	if (addr.hasStaging && opts.deployStaging && addr.staging) {
		log(`Before: snapshot of staging ${addr.staging}`);
		stagingBefore = await takeSnapshot(addr.staging, "staging-before", snapOpts);
		writeJson(join(dir, "before-staging.json"), stagingBefore);
	}

	const emdashBefore = (deps.installedEmdash ?? projectEmdashVersion)(paths.project);
	log("Rebuild: scaffold phase");
	const runScaffold = deps.runScaffold ?? ((s: string) => runPhase(s, "scaffold", { ...(opts.sitesDir ? { sitesDir: opts.sitesDir } : {}), ...(opts.preview ? { preview: true } : {}), quiet: !opts.log }));
	const sc = await runScaffold(slug);
	const scaffold = { ok: sc.ok, runId: sc.runId, failing: sc.checks.filter((c) => !c.ok) };
	const out: UpgradeResult = { ...base, mode: "upgrade", dir: rel, before: { file: relative(paths.root, beforeFile), pages: before.pages.length }, scaffold, ...(synced ? { syncStaging: synced } : {}), comparisons: [], next: [], ok: false, exitCode: 2 };
	if (!sc.ok) {
		out.next = [`The scaffold gate failed (${scaffold.failing.map((c) => c.id).join(", ")}): fix it, then run \`wp2emdash upgrade ${slug}\` again. Nothing was deployed.`];
		return out;
	}

	// The EmDash version changes: read-only check of the production database, then the safe order instead of a deploy.
	if (emdashBefore && emdashBefore !== STACK.emdash) {
		log(`EmDash ${emdashBefore} → ${STACK.emdash}: checking the production database (read-only)`);
		const st = await em.status(paths.project, prodCreds());
		if (st.code !== 0) return { ...out, exitCode: 1, error: "emdash migrate --status failed", next: [`Could not read the production database's migration status (exit ${st.code}): ${scrub(st.out).slice(-400)}. Nothing was applied or deployed.`] };
		const plan = planEmdashStep({ from: emdashBefore, to: STACK.emdash, status: parseMigrateStatus(st.out), ...(cf.production?.d1?.fingerprint ? { recordedFingerprint: cf.production.d1.fingerprint } : {}) });
		const rec: EmdashRecord = { ...plan, at: now().toISOString() };
		writeJson(join(dir, EMDASH_FILE), rec);
		out.emdash = rec;
		for (const n of plan.notes) log(`! ${n}`);
		if (plan.blockers.length) return { ...out, exitCode: 2, next: ["Stopped before anything was applied or deployed:", ...plan.blockers] };
		out.next.push(...emdashSequence(slug, paths.project, rec));
		return { ...out, ok: true, exitCode: 0 };
	}

	const prodCmd = productionDeployCommand(paths.project);
	if (addr.hasStaging) {
		if (!opts.deployStaging) {
			out.stagingDeploy = { ran: false, reason: "--deploy-staging not given" };
			out.next.push(`Staging: \`wp2emdash upgrade ${slug} --deploy-staging\` deploys staging (ci:deploy:staging) and compares it, or deploy it yourself and run \`wp2emdash upgrade ${slug} --verify staging\`.`);
		} else {
			let scripts: Record<string, string> = {};
			try {
				scripts = (JSON.parse(readFileSync(join(paths.project, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
			} catch {
				// handled below
			}
			if (!scripts[STAGING_DEPLOY_SCRIPT]) {
				out.stagingDeploy = { ran: false, ok: false, reason: `the project has no ${STAGING_DEPLOY_SCRIPT} script (provision staging first: wp2emdash provision ${slug} staging)` };
				return { ...out, exitCode: 1, error: out.stagingDeploy.reason as string, next: [`No ${STAGING_DEPLOY_SCRIPT} in ${paths.project}/package.json: provision staging (\`wp2emdash provision ${slug} staging\`) and rerun.`] };
			}
			if (!addr.staging) {
				out.stagingDeploy = { ran: false, ok: false, reason: "no staging address (cloudflare.json staging.worker.url or target.stagingUrl)" };
				return { ...out, exitCode: 1, error: out.stagingDeploy.reason as string };
			}
			log(`Staging: pnpm run ${STAGING_DEPLOY_SCRIPT}`);
			const creds = credentialsFor("staging", vars, cf as never);
			const env: Record<string, string> = { ...(creds.token ? { CLOUDFLARE_API_TOKEN: creds.token } : {}), ...(creds.accountId ? { CLOUDFLARE_ACCOUNT_ID: creds.accountId } : {}) };
			assertStagingScript(STAGING_DEPLOY_SCRIPT);
			const r = await (deps.runScript ?? defaultRunScript)(STAGING_DEPLOY_SCRIPT, paths.project, env);
			writeFileSync(join(dir, "staging-deploy.log"), scrub(r.out));
			if (r.code !== 0) {
				out.stagingDeploy = { ran: true, ok: false, reason: `exit ${r.code} (log: ${rel}/staging-deploy.log)` };
				return { ...out, exitCode: 1, error: `staging deploy failed (exit ${r.code})`, next: [`Staging deploy failed: read ${rel}/staging-deploy.log. Production was not touched.`] };
			}
			out.stagingDeploy = { ran: true, ok: true };
			const base4 = stagingBefore ?? before;
			const after = await takeSnapshot(addr.staging, "staging", { ...snapOpts, extraPaths: base4.pages.map((p) => p.path) });
			writeJson(join(dir, "after-staging.json"), after);
			const c = compareSnapshots(base4, after);
			out.comparisons.push(writeComparison(dir, "staging", `Upgrade check: staging after vs staging before (${slug})`, c, paths.root));
			if (!c.identical) {
				out.next.push(`The upgrade changed ${c.pagesWithDifferences} page(s) on staging: read ${rel}/compare-staging.md before deploying production.`);
				return out;
			}
		}
	} else {
		out.next.push(`Optional review before production (single environment): \`cd ${paths.project} && pnpm run versions:upload\` prints a preview URL without sending traffic to it; compare it with \`wp2emdash upgrade ${slug} --verify <preview-url>\`.`);
	}
	out.next.push(`Production (owner's approval, never run by the kit): ${prodCmd}`, `After the production deploy: pnpm wp2emdash upgrade ${slug} --verify`);
	return { ...out, ok: true, exitCode: 0 };
}
