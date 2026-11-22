/**
 * `wp2emdash sync-staging <slug> [--yes]`: refresh a site's staging environment with production's content, so an upgrade
 * is checked on real content. Only for sites with staging (target.staging). Strictly production → staging.
 *
 * Production is only READ: SELECT / PRAGMA queries over D1's REST query endpoint (`POST …/d1/database/:id/query`, the
 * call `wrangler d1 execute --remote --command` makes; every statement passes `assertReadOnly`), and R2 object GETs.
 * Not `wrangler d1 export`: an export makes the database unavailable to serve queries while it runs (Wrangler 4.163.0,
 * docs/spikes/staging-sync-findings.md). Staging is written once, with `wrangler d1 execute <staging> --remote --file`
 * (D1's import: atomic — a failure leaves staging as it was), addressed by its recorded database id through a temporary
 * one-binding Wrangler config, and its media bucket with R2 object PUTs.
 *
 * Dry run by default: the plan (tables, row counts on both sides, what is skipped and why, media) is printed and
 * nothing is written. With --yes: a D1 Time Travel bookmark of STAGING first (refused without one), media files copied
 * (missing or different size only), the import, counts read back, then a settings save through staging's EmDash API
 * (purges every cached page: they all carry the site-settings tag). Logs and results hold counts and table names only.
 *
 * Exit codes: 0 done (or the plan, dry run) · 2 refused (blockers) or counts differ afterwards · 1 error.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { loadConfig } from "../config/load.js";
import { readCf, siteEnvironments } from "../core/environments.js";
import { sitePaths } from "../core/paths.js";
import { loadSiteEnv, scrubSecrets } from "../extract/credentials.js";
import { assertReadOnly, assertStagingBucket, assertStagingDatabase, buildPlan, buildSyncSql, type DbSchema, mediaKeyAllowed, optionsWhere, type Query, quoteIdent, readSchema, type Row, type SyncCf, type SyncPlan, syncRefusals } from "../sync/staging.js";
import { EmDashApi } from "../targets/emdash/api.js";
import { d1Bookmark, recordBookmark, restoreCommand } from "../targets/d1-backup.js";
import { credentialsFor } from "./provision.js";

const API = "https://api.cloudflare.com/client/v4";
const PAGE_ROWS = 500;

export interface SyncStagingOptions {
	sitesDir?: string;
	/** Apply. Without it: the plan only (dry run). */
	yes?: boolean;
	/** Copy media files too (default true). */
	media?: boolean;
	log?: (line: string) => void;
	/** Environment variables (default: process.env + the kit and site .env). */
	vars?: Record<string, string | undefined>;
}

export interface SyncStagingDeps {
	fetcher?: typeof fetch;
	/** Runs `wrangler <args>` (only ever `d1 execute <staging> --remote --file …`). Default: `pnpm exec wrangler` in the project. */
	runWrangler?: (args: string[], cwd: string, env: Record<string, string>) => Promise<{ code: number; out: string }>;
	now?: () => Date;
}

export interface TableSummary {
	table: string;
	action: "replace" | "create";
	production: number;
	staging: number;
}

export interface MediaSummary {
	records: number;
	files: number;
	copied: number;
	alreadyThere: number;
	missingInProduction: number;
	failed: number;
	bytes: number;
}

export interface SyncStagingResult {
	slug: string;
	applied: boolean;
	refusals: string[];
	plan?: { tables: TableSummary[]; skipped: { table: string; why: string }[]; blockers: string[]; warnings: string[]; schema: SyncPlan["schema"]; mediaRecords: number; mediaFiles: number };
	bookmark?: { bookmark: string; restore: string; file: string };
	media?: MediaSummary;
	imported?: { statements: number; rows: number; oversized: number };
	verify?: { table: string; expected: number; actual: number }[];
	purge?: { done: boolean; detail: string };
	next: string[];
	exitCode: 0 | 1 | 2;
	error?: string;
}

/** A read-only query function over D1's REST query endpoint. */
export function d1Reader(fetcher: typeof fetch, o: { token: string; accountId: string; databaseId: string }): Query {
	return async (sql: string) => {
		assertReadOnly(sql);
		const res = await fetcher(`${API}/accounts/${o.accountId}/d1/database/${o.databaseId}/query`, { method: "POST", headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, body: JSON.stringify({ sql }) });
		const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { results?: Row[]; success?: boolean }[]; errors?: { message: string }[] };
		if (!res.ok || j.success === false) throw new Error(`D1 query failed: ${j.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`}`);
		return j.result?.[0]?.results ?? [];
	};
}

/** Every row of a table, in rowid pages; tables without rowid are read at once. */
export async function readAll(q: Query, table: string, where = "1 = 1"): Promise<Row[]> {
	const rows: Row[] = [];
	let after: number | null = null;
	for (;;) {
		let page: Row[];
		try {
			page = await q(`SELECT rowid AS __sync_rowid, * FROM ${quoteIdent(table)} WHERE (${where})${after === null ? "" : ` AND rowid > ${after}`} ORDER BY rowid LIMIT ${PAGE_ROWS}`);
		} catch (e) {
			if (after === null && /rowid/i.test((e as Error).message)) return q(`SELECT * FROM ${quoteIdent(table)} WHERE (${where})`);
			throw e;
		}
		for (const r of page) {
			after = Number(r.__sync_rowid);
			delete r.__sync_rowid;
			rows.push(r);
		}
		if (page.length < PAGE_ROWS) return rows;
	}
}

const countOf = async (q: Query, table: string, where?: string) => Number((await q(`SELECT COUNT(*) AS n FROM ${quoteIdent(table)}${where ? ` WHERE ${where}` : ""}`))[0]?.n ?? 0);
const whereFor = (table: string) => (table === "options" ? optionsWhere() : undefined);

/** `pnpm exec wrangler …` in the project folder (where the site's Wrangler is installed). */
export async function defaultRunWrangler(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; out: string }> {
	if (args[0] !== "d1" || args[1] !== "execute" || !args.includes("--remote") || !args.includes("--file")) throw new Error("Refused: sync-staging only runs `wrangler d1 execute <staging> --remote --file`.");
	return new Promise((resolve) => {
		const p = spawn("pnpm", ["exec", "wrangler", ...args], { cwd, env: { ...process.env, ...env, CI: "1", FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false" } });
		let out = "";
		p.stdout.on("data", (b: Buffer) => (out += b.toString()));
		p.stderr.on("data", (b: Buffer) => (out += b.toString()));
		p.on("error", (e) => resolve({ code: 1, out: `${out}${e.message}` }));
		p.on("close", (code) => resolve({ code: code ?? 1, out }));
	});
}

const objectUrl = (accountId: string, bucket: string, key: string) => `${API}/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`;

/**
 * Production's media files → staging's bucket. Production: GET only. Staging: HEAD (skip when the same size is already
 * there; any other answer copies again — idempotent), then PUT with the content type.
 */
export async function copyMedia(
	fetcher: typeof fetch,
	o: { prod: { token: string; accountId: string; bucket: string }; stg: { token: string; accountId: string; bucket: string }; objects: { key: string; size?: number; type?: string }[]; cf: SyncCf },
): Promise<MediaSummary> {
	assertStagingBucket(o.stg.bucket, o.cf);
	const out: MediaSummary = { records: o.objects.length, files: 0, copied: 0, alreadyThere: 0, missingInProduction: 0, failed: 0, bytes: 0 };
	const seen = new Set<string>();
	const list = o.objects.filter((x) => mediaKeyAllowed(x.key) && !seen.has(x.key) && seen.add(x.key));
	out.files = list.length;
	const one = async (x: { key: string; size?: number; type?: string }) => {
		try {
			const head = await fetcher(objectUrl(o.stg.accountId, o.stg.bucket, x.key), { method: "HEAD", headers: { authorization: `Bearer ${o.stg.token}` } });
			const len = Number(head.headers.get("content-length") ?? Number.NaN);
			if (head.status === 200 && typeof x.size === "number" && len === x.size) {
				out.alreadyThere++;
				return;
			}
			const got = await fetcher(objectUrl(o.prod.accountId, o.prod.bucket, x.key), { method: "GET", headers: { authorization: `Bearer ${o.prod.token}` } });
			if (got.status === 404) {
				out.missingInProduction++;
				return;
			}
			if (!got.ok) {
				out.failed++;
				return;
			}
			const body = new Uint8Array(await got.arrayBuffer());
			const type = got.headers.get("content-type") ?? x.type ?? "application/octet-stream";
			const put = await fetcher(objectUrl(o.stg.accountId, o.stg.bucket, x.key), { method: "PUT", headers: { authorization: `Bearer ${o.stg.token}`, "content-type": type }, body });
			if (!put.ok) {
				out.failed++;
				return;
			}
			out.copied++;
			out.bytes += body.byteLength;
		} catch {
			out.failed++;
		}
	};
	for (let i = 0; i < list.length; i += 4) await Promise.all(list.slice(i, i + 4).map(one));
	return out;
}

const stamp = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
const mb = (n: number) => `${(n / 1_048_576).toFixed(1)} MB`;

export async function syncStaging(slug: string, opts: SyncStagingOptions = {}, deps: SyncStagingDeps = {}): Promise<SyncStagingResult> {
	const paths = sitePaths(slug, opts.sitesDir);
	if (!existsSync(paths.config)) throw new Error(`No site "${slug}" (sites/${slug}/kit.config.ts)`);
	const config = await loadConfig(paths.config);
	const cf = readCf(paths.root) as SyncCf;
	const envs = siteEnvironments(config, cf as never);
	const log = opts.log ?? (() => {});
	const fetcher = deps.fetcher ?? fetch;
	const now = deps.now ?? (() => new Date());
	const siteEnv = loadSiteEnv(paths.root);
	const vars = opts.vars ?? ({ ...process.env, ...siteEnv } as Record<string, string | undefined>);
	const base = { slug, applied: false, next: [] as string[] };

	const refusals = syncRefusals(envs.staging, cf);
	if (refusals.length) return { ...base, refusals, next: refusals, exitCode: 2, error: refusals[0] as string };
	const prodDb = cf.production?.d1 as { id: string; name?: string };
	const stgDb = cf.staging?.d1 as { id: string; name: string };
	const pc = credentialsFor("production", vars, cf as never);
	const sc = credentialsFor("staging", vars, cf as never);
	if (!pc.token || !pc.accountId || !sc.token || !sc.accountId) return { ...base, refusals: [], next: ["Set CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (or the *_PRODUCTION / *_STAGING pair) in the kit or site .env (docs/cloudflare-api-token.md)."], exitCode: 1, error: "Cloudflare credentials missing for production or staging" };
	const prodQ = d1Reader(fetcher, { token: pc.token, accountId: pc.accountId, databaseId: prodDb.id });
	const stgQ = d1Reader(fetcher, { token: sc.token, accountId: sc.accountId, databaseId: stgDb.id });

	// ── Plan (read-only on both sides) ──
	log(`Reading schemas: production ${prodDb.name ?? prodDb.id} and staging ${stgDb.name} (read-only)`);
	let prodSchema: DbSchema;
	let stgSchema: DbSchema;
	try {
		[prodSchema, stgSchema] = await Promise.all([readSchema(prodQ), readSchema(stgQ)]);
	} catch (e) {
		return { ...base, refusals: [], next: ["Check the token (D1: Read on production, D1: Edit on staging) and the database ids in cloudflare.json."], exitCode: 1, error: (e as Error).message };
	}
	const plan = buildPlan(prodSchema, stgSchema);
	for (const t of plan.tables) {
		t.productionRows = await countOf(prodQ, t.table, whereFor(t.table));
		t.stagingRows = t.action === "create" ? 0 : await countOf(stgQ, t.table, whereFor(t.table));
	}
	const mediaStats = prodSchema.tables.media ? (await prodQ("SELECT COUNT(*) AS n, COUNT(DISTINCT storage_key) AS k FROM media"))[0] : undefined;
	const summary: NonNullable<SyncStagingResult["plan"]> = {
		tables: plan.tables.map((t) => ({ table: t.table, action: t.action, production: t.productionRows ?? 0, staging: t.stagingRows ?? 0 })),
		skipped: plan.skipped,
		blockers: plan.blockers,
		warnings: plan.warnings,
		schema: plan.schema,
		mediaRecords: Number(mediaStats?.n ?? 0),
		mediaFiles: Number(mediaStats?.k ?? 0),
	};
	const totalRows = summary.tables.reduce((n, t) => n + t.production, 0);
	log(`Plan: ${summary.tables.length} table(s), ${totalRows} production row(s) replace ${summary.tables.reduce((n, t) => n + t.staging, 0)} staging row(s); ${summary.skipped.length} table(s) left as staging has them; ${summary.mediaFiles} media file(s)`);
	const out: SyncStagingResult = { ...base, refusals: [], plan: summary, exitCode: 0 };
	if (plan.blockers.length) return { ...out, exitCode: 2, error: plan.blockers[0] as string, next: plan.blockers };
	if (!opts.yes) return { ...out, next: [`Dry run: nothing was written. To apply: pnpm wp2emdash sync-staging ${slug} --yes (a D1 Time Travel bookmark of staging is taken first).`] };

	// ── Apply: bookmark staging first; refuse without one ──
	assertStagingDatabase(stgDb.id, cf);
	const bm = await d1Bookmark({ token: sc.token, accountId: sc.accountId, databaseId: stgDb.id }, fetcher);
	if ("error" in bm) return { ...out, exitCode: 1, error: `Staging D1 bookmark failed (${bm.error}): nothing was written.`, next: ["The staging token needs D1: Edit (docs/cloudflare-api-token.md)."] };
	const at = now();
	const bookmarksFile = join(paths.root, "sync", "d1-bookmarks.jsonl");
	recordBookmark(bookmarksFile, { at: at.toISOString(), database: stgDb.name, databaseId: stgDb.id, bookmark: bm.bookmark, reason: "sync-staging (before production content replaced staging's)" });
	const restore = restoreCommand(stgDb.name, bm.bookmark);
	out.bookmark = { bookmark: bm.bookmark, restore, file: relative(paths.root, bookmarksFile) };
	log(`Staging bookmark ${bm.bookmark} recorded (sync/d1-bookmarks.jsonl)`);

	// ── Media first (additive): pages never point at a file staging does not have yet ──
	if (opts.media !== false && prodSchema.tables.media) {
		const rows = await readAll(prodQ, "media");
		const objects = rows.map((r) => ({ key: String(r.storage_key ?? ""), ...(typeof r.size === "number" ? { size: r.size } : {}), ...(typeof r.mime_type === "string" ? { type: r.mime_type } : {}) }));
		out.media = await copyMedia(fetcher, { prod: { token: pc.token, accountId: pc.accountId, bucket: cf.production?.r2?.bucket as string }, stg: { token: sc.token, accountId: sc.accountId, bucket: cf.staging?.r2?.bucket as string }, objects, cf });
		const m = out.media;
		log(`Media: ${m.files} file(s) — ${m.copied} copied (${mb(m.bytes)}), ${m.alreadyThere} already on staging${m.missingInProduction ? `, ${m.missingInProduction} missing in production` : ""}${m.failed ? `, ${m.failed} failed` : ""}`);
	}

	// ── Rows: production read, one atomic import into staging ──
	const rows: Record<string, Row[]> = {};
	for (const t of plan.tables) rows[t.table] = await readAll(prodQ, t.table, whereFor(t.table));
	const built = buildSyncSql(plan, prodSchema, rows);
	const imported = Object.values(built.rows).reduce((n, x) => n + x, 0);
	out.imported = { statements: built.statements, rows: imported, oversized: built.oversized };
	const tmp = mkdtempSync(join(tmpdir(), "wp2emdash-sync-"));
	let r: { code: number; out: string };
	try {
		const sqlFile = join(tmp, "sync.sql");
		const cfgFile = join(tmp, "wrangler.json");
		writeFileSync(sqlFile, built.sql);
		// One binding, the exact staging id: Wrangler resolves the database from this config, never by name lookup.
		writeFileSync(cfgFile, JSON.stringify({ name: `${slug}-sync-staging`, compatibility_date: "2026-11-01", d1_databases: [{ binding: "DB", database_name: stgDb.name, database_id: stgDb.id }] }, null, 2));
		assertStagingDatabase(stgDb.id, cf);
		log(`Import: ${imported} row(s) in ${built.statements} statement(s) into staging ${stgDb.name}`);
		const env: Record<string, string> = { CLOUDFLARE_API_TOKEN: sc.token, CLOUDFLARE_ACCOUNT_ID: sc.accountId };
		const cwd = existsSync(join(paths.project, "package.json")) ? paths.project : paths.root;
		r = await (deps.runWrangler ?? defaultRunWrangler)(["d1", "execute", stgDb.name, "--remote", "--file", sqlFile, "--yes", "--config", cfgFile], cwd, env);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
	if (r.code !== 0) {
		const dir = join(paths.root, "sync");
		mkdirSync(dir, { recursive: true });
		const logFile = join(dir, `${stamp(at)}-wrangler.log`);
		const secrets = Object.fromEntries(Object.entries({ ...siteEnv, CLOUDFLARE_API_TOKEN: sc.token, PRODUCTION_TOKEN: pc.token }).filter(([, v]) => v)) as Record<string, string>;
		writeFileSync(logFile, scrubSecrets(r.out, secrets));
		return { ...out, exitCode: 1, error: `staging import failed (exit ${r.code})`, next: [`D1's import is atomic: staging's database is as it was. Wrangler's output: ${relative(paths.root, logFile)}.`, `If staging looks wrong anyway: cd ${paths.project} && ${restore} (with the staging token in the environment).`] };
	}

	// ── Read back ──
	out.verify = [];
	for (const t of plan.tables) out.verify.push({ table: t.table, expected: built.rows[t.table] ?? 0, actual: await countOf(stgQ, t.table, whereFor(t.table)) });
	const differ = out.verify.filter((v) => v.expected !== v.actual);
	log(`Read back: ${out.verify.length - differ.length}/${out.verify.length} table(s) match${differ.length ? ` — differ: ${differ.map((d) => `${d.table} ${d.actual}/${d.expected}`).join(", ")}` : ""}`);

	// ── Cached pages: a settings save purges every page (they all carry the site-settings tag) ──
	const stgUrl = (config.target.stagingUrl ?? cf.staging?.worker?.url)?.replace(/\/$/, "");
	const emdashToken = vars.EMDASH_TOKEN;
	if (stgUrl && emdashToken) {
		try {
			const api = new EmDashApi(stgUrl, { token: emdashToken }, fetcher);
			const s = await api.settings();
			if (typeof s.title === "string") {
				await api.updateSettings({ title: s.title });
				out.purge = { done: true, detail: "staging's cached pages purged (settings saved unchanged through the EmDash API)" };
			} else out.purge = { done: false, detail: "staging has no site title to save back: cached pages expire on their own or with the next staging deploy" };
		} catch (e) {
			out.purge = { done: false, detail: `settings save failed (${(e as Error).message.slice(0, 120)}): cached pages expire on their own or with the next staging deploy` };
		}
	} else out.purge = { done: false, detail: "no EMDASH_TOKEN / staging address: cached pages on staging expire on their own (route cache) or with the next staging deploy (the cache key includes the Worker version)" };
	log(`Cache: ${out.purge.detail}`);

	out.applied = true;
	out.next = [`Undo: cd ${paths.project} && ${restore} (staging token in the environment).`, ...(out.media?.failed ? [`${out.media.failed} media file(s) failed to copy: run sync-staging again (copied files are skipped).`] : []), ...(differ.length ? [`Row counts differ on ${differ.length} table(s): staging may have been edited during the sync; run it again.`] : [])];
	return { ...out, exitCode: differ.length ? 2 : 0 };
}

/** Human-readable plan / result (counts and table names only). */
export function syncReport(r: SyncStagingResult): string {
	const lines: string[] = [];
	if (r.refusals.length) return r.refusals.map((x) => `✖ ${x}`).join("\n");
	const p = r.plan;
	if (p) {
		lines.push(`${r.applied ? "Synced" : "Plan"} — production → staging (${r.slug})${p.schema.production ? ` · schema ${p.schema.production}${p.schema.staging && p.schema.staging !== p.schema.production ? ` / staging ${p.schema.staging}` : ""}` : ""}`);
		const w = Math.max(5, ...p.tables.map((t) => t.table.length));
		lines.push(`  ${"table".padEnd(w)}  production  staging now`);
		for (const t of p.tables) lines.push(`  ${t.table.padEnd(w)}  ${String(t.production).padStart(10)}  ${String(t.staging).padStart(11)}${t.action === "create" ? "  (new on staging)" : ""}`);
		lines.push(`  media: ${p.mediaRecords} record(s), ${p.mediaFiles} file(s)`);
		lines.push(`Left as staging has them (${p.skipped.length}): ${p.skipped.map((s) => s.table).join(", ") || "—"}`);
		for (const b of p.blockers) lines.push(`✖ ${b}`);
		for (const x of p.warnings) lines.push(`! ${x}`);
	}
	if (r.bookmark) lines.push(`Staging bookmark: ${r.bookmark.bookmark} (${r.bookmark.file})`);
	if (r.media) lines.push(`Media: ${r.media.copied} copied, ${r.media.alreadyThere} already there, ${r.media.missingInProduction} missing in production, ${r.media.failed} failed`);
	if (r.imported) lines.push(`Imported: ${r.imported.rows} row(s) in ${r.imported.statements} statement(s)`);
	if (r.purge) lines.push(`Cache: ${r.purge.detail}`);
	if (r.error) lines.push(`✖ ${r.error}`);
	if (r.next.length) lines.push(`\nNext:\n${r.next.map((n) => `  - ${n}`).join("\n")}`);
	return lines.join("\n");
}
