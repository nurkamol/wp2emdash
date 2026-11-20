/**
 * `wp2emdash golive <slug> [--aliases] [--rollback] [--yes]` — the owner-approved traffic switch (docs/PLAN.md §7a).
 *
 * Without `--yes` it only reads: it re-checks the preconditions and prints exactly what it would change. The operator
 * passes `--yes` only after the owner said go in the current conversation; nothing in the kit passes it for them.
 *
 * - Primary (default): needs the last cutover preflight passed (or accepted by the owner) and production indexable.
 *   Creates the Worker routes `<domain>/*` and `www.<domain>/*` → the production Worker (a route already pointing at
 *   that Worker is kept and recorded; one pointing anywhere else stops the switch before any change), records the route
 *   ids in cutover/golive.json at once, smoke-tests the real domain (200 on audited paths, canonical host, no robots
 *   noindex on the production host — retried to ride out isolates that still cache an old setting), compares DNS with
 *   cutover/dns-before.json, then sets cloudflare.json → production.live = true and liveSince.
 * - `--aliases` (a separate, confirmed step after the primary is live): one Single Redirect rule per
 *   `target.aliasDomains` entry, appended to the zone's existing redirect entry point (other rules are never replaced;
 *   the entry point is only created when the zone has none), then the check-aliases probe and a DNS comparison with
 *   cutover/dns-before.<alias>.json.
 * - `--rollback`: deletes exactly the route ids and alias rule ids recorded in cutover/golive.json and sets live = false
 *   (`--rollback --aliases`: only the alias rules). DNS is never touched.
 *
 * Every Cloudflare call uses CLOUDFLARE_GOLIVE_TOKEN from sites/<slug>/.env (token B, docs/cloudflare-api-token.md).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import type { KitConfig } from "../config/schema.js";
import { siteEnvironments } from "../core/environments.js";
import { type SitePaths, sitePaths } from "../core/paths.js";
import { type GateCheck, phaseState, readState } from "../core/state.js";
import { checkAliases } from "./check-aliases.js";
import { type DnsRecord, REDIRECT_PHASE, type RedirectRule, primaryHost, redirectRule, ruleRef } from "../cutover/aliases.js";
import { sameAsBuildToken } from "../cutover/token.js";
import { loadEnv, loadSiteEnv } from "../extract/credentials.js";
import { remoteTarget } from "../targets/remote.js";

const API = "https://api.cloudflare.com/client/v4";
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GoliveOptions {
	aliases?: boolean;
	rollback?: boolean;
	yes?: boolean;
	sitesDir?: string;
	fetch?: FetchLike;
	log?: (line: string) => void;
	sleep?: (ms: number) => Promise<void>;
	/** Smoke / alias-check attempts before giving up (default 4), and the wait between them (default 20 s). */
	attempts?: number;
	retryMs?: number;
	/** Check only the first n audited paths in the smoke test. */
	limit?: number;
	/** Environment: `site` = sites/<slug>/.env only (the go-live token), `merged` = kit .env + site .env + process. */
	vars?: { site: Record<string, string>; merged: Record<string, string | undefined> };
	now?: () => Date;
}

export interface RecordedRoute {
	id: string;
	pattern: string;
	/** Already pointed at the Worker before this command ran (created by hand); still removed by rollback. */
	adopted: boolean;
	at: string;
}
export interface RecordedRule {
	alias: string;
	zoneId: string;
	rulesetId: string;
	ruleId: string;
	ref: string;
	adopted: boolean;
	/** The zone had no redirect entry point; this command created it with this one rule. */
	createdEntrypoint: boolean;
	at: string;
}
export interface GoliveRecord {
	domain: string;
	worker: string;
	zoneId?: string;
	routes: RecordedRoute[];
	aliasRules: RecordedRule[];
	switchedAt?: string;
	liveSince?: string;
	smoke?: { at: string; ok: boolean; checked: number; failures: string[] };
	history: { at: string; action: string }[];
}

export interface GoliveResult {
	/** Something was changed on Cloudflare or in cloudflare.json. */
	applied: boolean;
	ok: boolean;
	plan: string[];
	blockers: string[];
	checks: GateCheck[];
	next: string[];
	record?: GoliveRecord;
}

interface CfFile {
	production?: { live?: boolean; liveSince?: string; worker?: { name?: string; url?: string } };
	[k: string]: unknown;
}

type Call = <T>(method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; result?: T; error?: string }>;

function cfClient(f: FetchLike, token: string): Call {
	return async <T>(method: string, path: string, body?: unknown) => {
		try {
			const res = await f(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
			const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
			return res.ok && j.success !== false ? { ok: true, status: res.status, ...(j.result !== undefined ? { result: j.result } : {}) } : { ok: false, status: res.status, error: j.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}` };
		} catch (e) {
			return { ok: false, status: 0, error: (e as Error).message };
		}
	};
}

const readJson = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined);
const writeJson = (file: string, data: unknown, indent: string | number = 2) => writeFileSync(file, `${JSON.stringify(data, null, indent)}\n`);
/** Keep the file's own indentation (tabs or spaces) so a hand-edited cloudflare.json is not reformatted. */
const indentOf = (file: string) => (existsSync(file) && /\n\t"/.test(readFileSync(file, "utf8")) ? "\t" : 2);

/** Hosts a route pattern covers, for the conflict check: "example.com/*" → "example.com", "*.example.com/x*" → "*.example.com". */
const patternHost = (pattern: string) => pattern.split("/")[0]?.toLowerCase() ?? "";

/** Robots directives that keep a page out of search: the meta tag and the X-Robots-Tag header. */
export function noindexIn(html: string, xRobotsTag: string | null): string[] {
	const found: string[] = [];
	if (xRobotsTag && /noindex/i.test(xRobotsTag)) found.push(`X-Robots-Tag: ${xRobotsTag}`);
	for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
		if (!/\bname\s*=\s*["']?(robots|googlebot)["'\s>/]/i.test(tag)) continue;
		const content = /\bcontent\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
		if (/noindex/i.test(content)) found.push(`meta robots: ${content}`);
	}
	return found;
}

const canonicalOf = (html: string): string | undefined => {
	for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) if (/\brel\s*=\s*["']?canonical["'\s>/]/i.test(tag)) return /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
	return undefined;
};

/** Audited pages (snapshot/urls.json, HTML pages that answered 200) and whether the source itself was noindex. */
function auditedPages(paths: SitePaths): { path: string; noindex: boolean }[] {
	const urls = readJson<{ path: string; status: number; kind: string; noindex?: boolean }[]>(join(paths.snapshot, "urls.json")) ?? [];
	return urls.filter((u) => u.kind === "page" && u.status === 200).map((u) => ({ path: u.path.startsWith("/") ? u.path : `/${u.path}`, noindex: !!u.noindex }));
}

export interface SmokeResult {
	ok: boolean;
	checked: number;
	failures: string[];
	noindex: string[];
}

/** One pass over the real domain: audited paths answer 200 on the canonical host, the other host and http redirect to it, no noindex. */
export async function smokeOnce(o: { canonical: string; other: string; pages: { path: string; noindex: boolean }[]; fetch: FetchLike; concurrency?: number }): Promise<SmokeResult> {
	const failures: string[] = [];
	const noindex: string[] = [];
	const pages = o.pages.length ? o.pages : [{ path: "/", noindex: false }];
	let next = 0;
	let checked = 0;
	const worker = async () => {
		while (next < pages.length) {
			const p = pages[next++] as { path: string; noindex: boolean };
			const url = `https://${o.canonical}${p.path}`;
			checked++;
			try {
				const res = await o.fetch(url, { redirect: "manual" });
				const html = (res.headers.get("content-type") ?? "text/html").includes("html") ? await res.text() : (await res.body?.cancel().catch(() => {}), "");
				if (res.status !== 200) failures.push(`${url} → ${res.status}${res.headers.get("location") ? ` ${res.headers.get("location")}` : ""}`);
				const ni = noindexIn(html, res.headers.get("x-robots-tag"));
				if (ni.length && !p.noindex) noindex.push(`${url}: ${ni.join("; ")}`);
				if (p.path === "/" && res.status === 200) {
					const c = canonicalOf(html);
					if (c) {
						let host = "";
						try {
							host = new URL(c, url).hostname;
						} catch {}
						if (host !== o.canonical) failures.push(`${url}: rel=canonical points at ${c}, not ${o.canonical}`);
					}
				}
			} catch (e) {
				failures.push(`${url} → no response (${(e as Error).message.split("\n")[0]})`);
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 6) }, worker));
	for (const from of [`https://${o.other}/`, `http://${o.canonical}/`]) {
		checked++;
		try {
			const res = await o.fetch(from, { redirect: "manual" });
			await res.body?.cancel().catch(() => {});
			const to = res.headers.get("location") ?? "";
			if (!(res.status >= 300 && res.status < 400 && to.startsWith(`https://${o.canonical}`))) failures.push(`${from} → ${res.status} ${to || "(no redirect)"}, expected a redirect to https://${o.canonical}/`);
		} catch (e) {
			failures.push(`${from} → no response (${(e as Error).message.split("\n")[0]})`);
		}
	}
	failures.sort();
	noindex.sort();
	return { ok: failures.length === 0 && noindex.length === 0, checked, failures, noindex };
}

const recordKey = (r: { type: string; name: string; content: string; ttl?: number; priority?: number; proxied?: boolean }) => `${r.type} ${r.name} ${r.content}${r.ttl !== undefined ? ` ttl=${r.ttl}` : ""}${r.priority !== undefined ? ` prio=${r.priority}` : ""}${r.proxied !== undefined ? ` proxied=${r.proxied}` : ""}`;

/** Records added and removed between two lists (a changed record shows as one removed + one added). Never lists content of more than a few. */
export function dnsDiff(before: string[], after: string[]): { added: string[]; removed: string[] } {
	const b = new Map<string, number>();
	for (const k of before) b.set(k, (b.get(k) ?? 0) + 1);
	const added: string[] = [];
	for (const k of after) {
		const n = b.get(k) ?? 0;
		if (n > 0) b.set(k, n - 1);
		else added.push(k);
	}
	const removed = [...b.entries()].flatMap(([k, n]) => Array.from({ length: n }, () => k));
	return { added, removed };
}

const diffDetail = (d: { added: string[]; removed: string[] }) => {
	const short = (k: string) => k.split(" ").slice(0, 2).join(" ");
	return [d.added.length ? `added: ${d.added.map(short).join(", ")}` : "", d.removed.length ? `removed: ${d.removed.map(short).join(", ")}` : ""].filter(Boolean).join("; ");
};

/** Primary zone: everything must equal cutover/dns-before.json (the web records and every other record). */
async function primaryDnsCheck(call: Call, zoneId: string, domain: string, outDir: string): Promise<GateCheck> {
	const label = "DNS unchanged since the preflight (cutover/dns-before.json)";
	const before = readJson<{ web: { type: string; name: string; content: string; proxied?: boolean }[]; keep: DnsRecord[] }>(join(outDir, "dns-before.json"));
	if (!before) return { id: "dns-unchanged", label, ok: false, detail: "cutover/dns-before.json missing: rerun the cutover preflight" };
	const r = await call<DnsRecord[]>("GET", `/zones/${zoneId}/dns_records?per_page=500`);
	if (!r.ok) return { id: "dns-unchanged", label, ok: false, detail: r.error ?? "" };
	const records = r.result ?? [];
	const isWeb = (x: DnsRecord) => (x.name === domain || x.name === `www.${domain}`) && ["A", "AAAA", "CNAME"].includes(x.type);
	const web = dnsDiff(before.web.map(({ type, name, content, proxied }) => recordKey({ type, name, content, proxied })), records.filter(isWeb).map(({ type, name, content, proxied }) => recordKey({ type, name, content, proxied })));
	const keep = dnsDiff(before.keep.map(recordKey), records.filter((x) => !isWeb(x)).map(({ type, name, content, ttl, priority, proxied }) => recordKey({ type, name, content, ttl, priority, proxied })));
	const added = [...web.added, ...keep.added];
	const removed = [...web.removed, ...keep.removed];
	return { id: "dns-unchanged", label, ok: !added.length && !removed.length, detail: added.length || removed.length ? `${diffDetail({ added, removed })} — the switch changes no DNS: find out who changed these` : `${records.length} records identical` };
}

/** Alias zone: every record must equal cutover/dns-before.<alias>.json. */
async function aliasDnsCheck(call: Call, zoneId: string, alias: string, outDir: string): Promise<GateCheck> {
	const id = `dns-unchanged:${alias}`;
	const label = `${alias}: DNS unchanged since the preflight (mail records included)`;
	const before = readJson<{ records: (DnsRecord & { mail?: boolean })[] }>(join(outDir, `dns-before.${alias}.json`));
	if (!before) return { id, label, ok: false, detail: `cutover/dns-before.${alias}.json missing: rerun the cutover preflight` };
	const r = await call<DnsRecord[]>("GET", `/zones/${zoneId}/dns_records?per_page=500`);
	if (!r.ok) return { id, label, ok: false, detail: r.error ?? "" };
	const d = dnsDiff(before.records.map(({ type, name, content, ttl, priority, proxied }) => recordKey({ type, name, content, ttl, priority, proxied })), (r.result ?? []).map(({ type, name, content, ttl, priority, proxied }) => recordKey({ type, name, content, ttl, priority, proxied })));
	return { id, label, ok: !d.added.length && !d.removed.length, detail: d.added.length || d.removed.length ? diffDetail(d) : `${(r.result ?? []).length} records identical` };
}

interface Ctx {
	slug: string;
	paths: SitePaths;
	config: KitConfig;
	domain: string;
	canonical: string;
	other: string;
	worker: string;
	outDir: string;
	cfFile: string;
	recordFile: string;
	call: Call;
	f: FetchLike;
	log: (line: string) => void;
	sleep: (ms: number) => Promise<void>;
	attempts: number;
	retryMs: number;
	now: () => Date;
	merged: Record<string, string | undefined>;
}

function loadRecord(c: Ctx): GoliveRecord {
	return readJson<GoliveRecord>(c.recordFile) ?? { domain: c.domain, worker: c.worker, routes: [], aliasRules: [], history: [] };
}
function saveRecord(c: Ctx, r: GoliveRecord) {
	mkdirSync(c.outDir, { recursive: true });
	writeJson(c.recordFile, r);
}
function setLive(c: Ctx, live: boolean) {
	const cf = readJson<CfFile>(c.cfFile) ?? {};
	const indent = indentOf(c.cfFile);
	cf.production = { ...(cf.production ?? {}), live };
	if (live) cf.production.liveSince ??= c.now().toISOString().slice(0, 10);
	else delete cf.production.liveSince;
	writeJson(c.cfFile, cf, indent);
}

export async function golive(slug: string, opts: GoliveOptions = {}): Promise<GoliveResult> {
	const paths = opts.sitesDir ? sitePaths(slug, opts.sitesDir) : sitePaths(slug);
	if (!existsSync(paths.config)) throw new Error(`No site "${slug}"`);
	const config = await loadConfig(paths.config);
	const site = opts.vars?.site ?? loadEnv(join(paths.root, ".env"));
	const merged = opts.vars?.merged ?? { ...process.env, ...loadSiteEnv(paths.root) };
	const token = site.CLOUDFLARE_GOLIVE_TOKEN;
	if (!token) throw new Error(`CLOUDFLARE_GOLIVE_TOKEN is not set in sites/${slug}/.env (docs/cloudflare-api-token.md, token B)`);
	const same = sameAsBuildToken(token, merged);
	if (same.length) throw new Error(`CLOUDFLARE_GOLIVE_TOKEN is identical to ${same.join(", ")}: create a separate go-live token scoped to this site's zones (docs/cloudflare-api-token.md, token B)`);
	const cfFile = join(paths.root, "cloudflare.json");
	const cf = readJson<CfFile>(cfFile) ?? {};
	const domain = new URL(config.target.productionUrl).hostname.replace(/^www\./, "");
	const canonical = primaryHost(config.target.productionUrl, config.target.canonicalHost);
	const f = opts.fetch ?? fetch;
	const outDir = join(paths.root, "cutover");
	const c: Ctx = {
		slug,
		paths,
		config,
		domain,
		canonical,
		other: canonical === domain ? `www.${domain}` : domain,
		worker: cf.production?.worker?.name ?? slug.replace(/[^a-z0-9-]/g, "-"),
		outDir,
		cfFile,
		recordFile: join(outDir, "golive.json"),
		call: cfClient(f, token),
		f,
		log: opts.log ?? (() => {}),
		sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
		attempts: Math.max(1, opts.attempts ?? 4),
		retryMs: opts.retryMs ?? 20_000,
		now: opts.now ?? (() => new Date()),
		merged,
	};
	if (opts.rollback) return rollback(c, opts);
	// The switch needs the last cutover preflight green (or accepted by the owner with `wp2emdash accept`).
	const cut = existsSync(paths.state) ? phaseState(readState(paths.state), "cutover") : undefined;
	if (!cut || !["passed", "accepted"].includes(cut.status)) throw new Error(`The last cutover preflight did not pass (status: ${cut?.status ?? "never run"}). Run \`wp2emdash run ${slug} cutover\` and fix every red check first.`);
	return opts.aliases ? aliasSwitch(c, opts) : primarySwitch(c, opts);
}

const refuse = (c: Ctx, plan: string[], blockers: string[], checks: GateCheck[] = []): GoliveResult => {
	for (const b of blockers) c.log(`✖ ${b}`);
	c.log("Nothing changed.");
	return { applied: false, ok: false, plan, blockers, checks, next: [] };
};
const notApproved = (c: Ctx, plan: string[], checks: GateCheck[], flags: string): GoliveResult => {
	c.log("");
	c.log(`Nothing changed. After the owner's explicit go-ahead in this conversation, rerun with: wp2emdash golive ${c.slug}${flags} --yes`);
	return { applied: false, ok: false, plan, blockers: [], checks, next: [] };
};

/** EmDash's staging flag (noindex everywhere) must be off on production before the switch. */
async function indexableCheck(c: Ctx): Promise<GateCheck> {
	const label = "Production is not marked staging (no noindex on every page)";
	const t = remoteTarget(c.paths.root, c.config, c.merged as Record<string, string>, "production");
	if ("error" in t) return { id: "indexable", label, ok: false, detail: t.error };
	try {
		if (t.token) {
			const res = await c.f(`${t.url}/_emdash/api/settings`, { headers: { Authorization: `Bearer ${t.token}` } });
			const body = (await res.json().catch(() => ({}))) as { data?: { staging?: boolean }; staging?: boolean };
			const staging = (body.data ?? body).staging;
			return { id: "indexable", label, ok: res.ok && staging !== true, ...(!res.ok ? { detail: `settings: HTTP ${res.status}` } : staging === true ? { detail: "Reload production (pnpm wp2emdash run <slug> load; WP2EMDASH_LOAD_TARGET=production on a site with staging), which clears it, then redeploy" } : {}) };
		}
		// No admin token: the home page's robots meta (the workers.dev host itself always sends X-Robots-Tag: noindex).
		const res = await c.f(`${t.url}/`, { redirect: "follow" });
		const ni = noindexIn(await res.text(), null);
		return { id: "indexable", label, ok: res.ok && !ni.length, detail: !res.ok ? `${t.url}/ → HTTP ${res.status}` : ni.length ? `${t.url}/ carries ${ni.join("; ")}: reload production, then redeploy` : "home page has no robots noindex (EMDASH_TOKEN_PRODUCTION not set: settings not read)" };
	} catch (e) {
		return { id: "indexable", label, ok: false, detail: (e as Error).message };
	}
}

async function primarySwitch(c: Ctx, opts: GoliveOptions): Promise<GoliveResult> {
	const plan: string[] = [];
	const blockers: string[] = [];
	const checks: GateCheck[] = [];
	const z = await c.call<{ id: string; status: string }[]>("GET", `/zones?name=${encodeURIComponent(c.domain)}`);
	const zone = z.result?.[0];
	if (!zone) return refuse(c, plan, [`Zone ${c.domain} not visible to the go-live token (${z.error ?? "no such zone"})`]);
	if (zone.status !== "active") blockers.push(`Zone ${c.domain} is ${zone.status}, not active`);
	const routes = await c.call<{ id: string; pattern: string; script?: string }[]>("GET", `/zones/${zone.id}/workers/routes`);
	if (!routes.ok) return refuse(c, plan, [`Cannot read the zone's Worker routes: ${routes.error}`]);
	const hosts = new Set([c.domain, `www.${c.domain}`, `*.${c.domain}`, `*${c.domain}`]);
	const ours = (routes.result ?? []).filter((r) => hosts.has(patternHost(r.pattern)));
	for (const r of ours) if (r.script !== c.worker) blockers.push(`Route ${r.pattern} points at ${r.script ? `"${r.script}"` : "no Worker"}, not "${c.worker}": remove or change it by hand (owner decision) first`);
	const want = [`${c.domain}/*`, `www.${c.domain}/*`];
	const adopt = want.map((p) => ours.find((r) => r.pattern === p && r.script === c.worker)).filter((r): r is { id: string; pattern: string; script?: string } => !!r);
	const create = want.filter((p) => !adopt.some((r) => r.pattern === p));
	for (const p of create) plan.push(`Create Worker route ${p} → ${c.worker} (zone ${c.domain})`);
	for (const r of adopt) plan.push(`Keep route ${r.pattern} → ${c.worker} (already in place, id ${r.id}; recorded for rollback)`);
	plan.push(`Smoke-test https://${c.canonical}: audited paths answer 200, ${c.other} and http redirect to it, no robots noindex (up to ${c.attempts} attempts)`);
	plan.push("Compare the zone's DNS with cutover/dns-before.json (nothing may be added, removed or changed)");
	plan.push("Set cloudflare.json → production.live = true and liveSince (remote targets switch to the real domain; IndexNow turns live on the next scaffold)");
	plan.push("Record route ids and times in cutover/golive.json (rollback: wp2emdash golive <slug> --rollback --yes)");
	const idx = await indexableCheck(c);
	checks.push(idx);
	if (!idx.ok) blockers.push(`${idx.label}: ${idx.detail ?? "failed"}`);
	c.log(`Go-live for ${c.domain} → Worker "${c.worker}"${opts.yes ? "" : " (plan only)"}:`);
	for (const p of plan) c.log(`  - ${p}`);
	if (blockers.length) return refuse(c, plan, blockers, checks);
	if (!opts.yes) return notApproved(c, plan, checks, "");

	// Apply. Every route id is written to golive.json as soon as it exists, so a rollback always knows it.
	const record = loadRecord(c);
	record.zoneId = zone.id;
	record.worker = c.worker;
	const at = () => c.now().toISOString();
	for (const r of adopt) if (!record.routes.some((x) => x.id === r.id)) record.routes.push({ id: r.id, pattern: r.pattern, adopted: true, at: at() });
	saveRecord(c, record);
	for (const pattern of create) {
		const made = await c.call<{ id: string }>("POST", `/zones/${zone.id}/workers/routes`, { pattern, script: c.worker });
		if (!made.ok || !made.result?.id) {
			record.history.push({ at: at(), action: `route ${pattern} failed: ${made.error}` });
			saveRecord(c, record);
			c.log(`✖ Creating route ${pattern}: ${made.error}. Routes created so far are recorded; rollback: wp2emdash golive ${c.slug} --rollback --yes`);
			return { applied: record.routes.length > 0, ok: false, plan, blockers: [`route ${pattern}: ${made.error}`], checks, next: [], record };
		}
		record.routes.push({ id: made.result.id, pattern, adopted: false, at: at() });
		record.history.push({ at: at(), action: `route ${pattern} created (${made.result.id})` });
		saveRecord(c, record);
		c.log(`✔ Route ${pattern} → ${c.worker} (${made.result.id})`);
	}
	record.switchedAt ??= at();
	saveRecord(c, record);

	// Smoke test on the real domain; retried, because running isolates can keep an old (staging) setting for a while.
	const pages = auditedPages(c.paths);
	const smokePages = opts.limit ? pages.slice(0, opts.limit) : pages;
	let smoke: SmokeResult = { ok: false, checked: 0, failures: [], noindex: [] };
	for (let i = 1; i <= c.attempts; i++) {
		smoke = await smokeOnce({ canonical: c.canonical, other: c.other, pages: smokePages, fetch: c.f });
		c.log(`${smoke.ok ? "✔" : "…"} Smoke ${i}/${c.attempts}: ${smoke.checked} requests, ${smoke.failures.length} failing, ${smoke.noindex.length} noindex`);
		if (smoke.ok) break;
		if (i < c.attempts) await c.sleep(c.retryMs);
	}
	checks.push({ id: "smoke", label: `https://${c.canonical}: audited paths answer 200, other host and http redirect to it`, ok: smoke.failures.length === 0, ...(smoke.failures.length ? { detail: smoke.failures.slice(0, 10).join("; ") + (smoke.failures.length > 10 ? ` … ${smoke.failures.length - 10} more` : "") } : { detail: `${smoke.checked} requests` }) });
	checks.push({
		id: "no-noindex",
		label: `No robots noindex on ${c.canonical} (meta or X-Robots-Tag)`,
		ok: smoke.noindex.length === 0,
		...(smoke.noindex.length ? { detail: `${smoke.noindex.slice(0, 5).join("; ")}${smoke.noindex.length > 5 ? ` … ${smoke.noindex.length - 5} more` : ""}. Still there after ${c.attempts} attempts: redeploy production (pnpm deploy:production in the project) so running isolates drop the cached setting, then rerun wp2emdash golive ${c.slug} --yes (routes already in place are kept).` } : {}),
	});
	checks.push(await primaryDnsCheck(c.call, zone.id, c.domain, c.outDir));
	record.smoke = { at: at(), ok: smoke.ok, checked: smoke.checked, failures: [...smoke.failures, ...smoke.noindex].slice(0, 50) };
	const next: string[] = [];
	if (smoke.ok) {
		setLive(c, true);
		record.liveSince = (readJson<CfFile>(c.cfFile)?.production?.liveSince as string | undefined) ?? at().slice(0, 10);
		record.history.push({ at: at(), action: "production.live = true" });
		c.log("✔ cloudflare.json → production.live = true");
		// EmDash's Site URL builds sign-in links, invites and password resets; before the switch it pointed at
		// workers.dev, so a magic-link sign-in landed there instead of on the real domain.
		const t = remoteTarget(c.paths.root, c.config, c.merged as Record<string, string>, "production");
		if (!("error" in t) && t.token) {
			try {
				const res = await c.f(`https://${c.canonical}/_emdash/api/settings`, { method: "POST", headers: { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json", "X-EmDash-Request": "1" }, body: JSON.stringify({ url: `https://${c.canonical}` }) });
				checks.push({ id: "site-url", label: `EmDash Site URL is https://${c.canonical} (sign-in links)`, ok: res.ok, ...(res.ok ? {} : { detail: `settings: HTTP ${res.status}; set it in the admin (Settings → Site URL)` }) });
			} catch (e) {
				checks.push({ id: "site-url", label: `EmDash Site URL is https://${c.canonical} (sign-in links)`, ok: false, detail: (e as Error).message });
			}
		} else next.push(`Set EmDash's Site URL to https://${c.canonical} (admin → Settings), so sign-in links use the real domain`);
		const single = !siteEnvironments(c.config, readJson<CfFile>(c.cfFile) as never).staging;
		next.push(
			`pnpm wp2emdash run ${c.slug} scaffold, then pnpm deploy:production in the project (IndexNow and the client docs pick up "live"${single ? "; the client CI stops deploying on push to main (target.ciDeploy)" : ""})`,
			...(single
				? [
						`Forms: messages sent from https://${c.canonical} now go to email.to — no redeploy needed (FORM_LIVE_HOST); messages from workers.dev or preview links stay tests (email.stagingTo only), including any still queued from before launch. Send one test form from the domain`,
						`Content now lives in production: a reload needs --force (pnpm wp2emdash run ${c.slug} load --force) and records a D1 Time Travel bookmark first. Code changes: pnpm versions:upload → preview URL → pnpm versions:deploy (client docs/deployment.md)`,
					]
				: []),
			`WP2EMDASH_TARGET=production pnpm wp2emdash run ${c.slug} verify --preview (now against https://${c.canonical})`,
			`Submit https://${c.canonical}/sitemap.xml in Search Console; send a test form`,
			...(c.config.target.aliasDomains.length ? [`Alias domains, a separate step after the owner's go-ahead: pnpm wp2emdash golive ${c.slug} --aliases`] : []),
			`Rollback at any time during monitoring: pnpm wp2emdash golive ${c.slug} --rollback --yes`,
		);
	} else {
		record.history.push({ at: at(), action: "smoke failed; production.live not set" });
		next.push(`Routes are in place but the smoke test failed: fix and rerun \`wp2emdash golive ${c.slug} --yes\`, or roll back now: wp2emdash golive ${c.slug} --rollback --yes`);
	}
	saveRecord(c, record);
	return { applied: true, ok: checks.every((x) => x.ok), plan, blockers: [], checks, next, record };
}

async function aliasSwitch(c: Ctx, opts: GoliveOptions): Promise<GoliveResult> {
	const plan: string[] = [];
	const blockers: string[] = [];
	const aliases = c.config.target.aliasDomains;
	if (!aliases.length) return refuse(c, plan, ["No target.aliasDomains in kit.config.ts"]);
	if (!readJson<CfFile>(c.cfFile)?.production?.live) return refuse(c, plan, [`The primary is not live yet: switch it first (wp2emdash golive ${c.slug} --yes) and verify it; aliases come after`]);
	const targets: { alias: string; zoneId: string; rulesetId?: string; existing: RedirectRule[]; ours?: RedirectRule }[] = [];
	for (const alias of aliases) {
		const z = await c.call<{ id: string; status: string }[]>("GET", `/zones?name=${encodeURIComponent(alias)}`);
		const zone = z.result?.[0];
		if (!zone) {
			blockers.push(`${alias}: zone not visible to the go-live token (${z.error ?? "no such zone"})`);
			continue;
		}
		const e = await c.call<{ id: string; rules?: RedirectRule[] }>("GET", `/zones/${zone.id}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`);
		if (!e.ok && e.status !== 404) {
			blockers.push(`${alias}: cannot read the redirect rules (${e.error}); the go-live token needs Single Redirect Read/Edit on ${alias}`);
			continue;
		}
		const existing = e.result?.rules ?? [];
		const ours = existing.find((r) => r.ref === ruleRef(alias));
		targets.push({ alias, zoneId: zone.id, ...(e.ok && e.result?.id ? { rulesetId: e.result.id } : {}), existing, ...(ours ? { ours } : {}) });
		if (ours) plan.push(`${alias}: keep the kit's redirect rule (already in place, id ${ours.id}; recorded for rollback)`);
		else if (e.ok && e.result?.id) plan.push(`${alias}: append one Single Redirect rule (apex + www → https://${c.canonical}<same path>, 301, query kept) to ruleset ${e.result.id}; its ${existing.length} other rule(s) stay`);
		else plan.push(`${alias}: create the zone's redirect entry point with that one rule (the zone has none yet)`);
	}
	plan.push(`Check every audited path on ${aliases.map((a) => `${a} and www.${a}`).join(", ")} answers 301 to the same path on https://${c.canonical} (up to ${c.attempts} attempts)`);
	plan.push("Compare each alias zone's DNS with cutover/dns-before.<alias>.json (mail records included; nothing may change)");
	plan.push("Record rule ids in cutover/golive.json (rollback: wp2emdash golive <slug> --rollback --aliases --yes)");
	c.log(`Alias domains → https://${c.canonical}${opts.yes ? "" : " (plan only)"}:`);
	for (const p of plan) c.log(`  - ${p}`);
	if (blockers.length) return refuse(c, plan, blockers);
	if (!opts.yes) return notApproved(c, plan, [], " --aliases");

	const record = loadRecord(c);
	const at = () => c.now().toISOString();
	const checks: GateCheck[] = [];
	for (const t of targets) {
		const ref = ruleRef(t.alias);
		if (t.ours?.id) {
			if (!record.aliasRules.some((x) => x.ruleId === t.ours?.id)) record.aliasRules.push({ alias: t.alias, zoneId: t.zoneId, rulesetId: t.rulesetId as string, ruleId: t.ours.id, ref, adopted: true, createdEntrypoint: false, at: at() });
			saveRecord(c, record);
			continue;
		}
		const rule = redirectRule(t.alias, c.canonical);
		// Existing entry point: add the rule (POST …/rules appends; the other rules stay). None yet: create it (PUT) with this rule only.
		const r = t.rulesetId
			? await c.call<{ id: string; rules?: RedirectRule[] }>("POST", `/zones/${t.zoneId}/rulesets/${t.rulesetId}/rules`, rule)
			: await c.call<{ id: string; rules?: RedirectRule[] }>("PUT", `/zones/${t.zoneId}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`, { rules: [rule] });
		const made = r.result?.rules?.find((x) => x.ref === ref);
		if (!r.ok || !r.result?.id || !made?.id) {
			record.history.push({ at: at(), action: `${t.alias}: redirect rule failed: ${r.error ?? "rule not in the response"}` });
			saveRecord(c, record);
			c.log(`✖ ${t.alias}: ${r.error ?? "rule not in the response"}. Rules created so far are recorded; rollback: wp2emdash golive ${c.slug} --rollback --aliases --yes`);
			return { applied: record.aliasRules.length > 0, ok: false, plan, blockers: [`${t.alias}: ${r.error ?? "rule not in the response"}`], checks, next: [], record };
		}
		record.aliasRules.push({ alias: t.alias, zoneId: t.zoneId, rulesetId: r.result.id, ruleId: made.id, ref, adopted: false, createdEntrypoint: !t.rulesetId, at: at() });
		record.history.push({ at: at(), action: `${t.alias}: redirect rule ${made.id} in ruleset ${r.result.id}` });
		saveRecord(c, record);
		c.log(`✔ ${t.alias}: redirect rule ${made.id}`);
	}

	let probe: Awaited<ReturnType<typeof checkAliases>> | undefined;
	for (let i = 1; i <= c.attempts; i++) {
		probe = await checkAliases(c.slug, { ...(opts.sitesDir ? { sitesDir: opts.sitesDir } : {}), fetch: c.f });
		c.log(`${probe.result.ok ? "✔" : "…"} Alias check ${i}/${c.attempts}: ${probe.result.checked - probe.result.failures.length}/${probe.result.checked} redirect correctly`);
		if (probe.result.ok) break;
		if (i < c.attempts) await c.sleep(c.retryMs);
	}
	const res = probe?.result;
	checks.push({ id: "alias-redirects", label: `Every audited path on the alias domains answers 301 to the same path on ${c.canonical}`, ok: !!res?.ok, detail: res ? (res.ok ? `${res.checked} requests; report cutover/aliases-check.md` : `${res.failures.length} failing, e.g. ${res.failures.slice(0, 3).map((x) => `${x.url}: ${x.problem}`).join("; ")} (cutover/aliases-check.md)`) : "not run" });
	for (const t of targets) checks.push(await aliasDnsCheck(c.call, t.zoneId, t.alias, c.outDir));
	saveRecord(c, record);
	return {
		applied: true,
		ok: checks.every((x) => x.ok),
		plan,
		blockers: [],
		checks,
		next: [`Search Console: Change of Address in each alias property → https://${c.canonical} (README "Two sites, one domain" §9)`, "Send a test email to and from an address on each alias domain", `Rollback of the alias rules only: pnpm wp2emdash golive ${c.slug} --rollback --aliases --yes`],
		record,
	};
}

async function rollback(c: Ctx, opts: GoliveOptions): Promise<GoliveResult> {
	const record = readJson<GoliveRecord>(c.recordFile);
	if (!record || (!record.routes.length && !record.aliasRules.length)) return refuse(c, [], ["Nothing recorded in cutover/golive.json: nothing to roll back (routes made by hand: see cutover/runbook.md §2)"]);
	const routes = opts.aliases ? [] : record.routes;
	const rules = record.aliasRules;
	const plan = [
		...rules.map((r) => `${r.alias}: delete redirect rule ${r.ruleId} from ruleset ${r.rulesetId} (other rules and DNS untouched)`),
		...routes.map((r) => `Delete Worker route ${r.pattern} (${r.id})${r.adopted ? " — it was made by hand before golive and recorded" : ""}; traffic returns to the proxied WordPress records`),
		...(opts.aliases ? [] : ["Set cloudflare.json → production.live = false"]),
	];
	c.log(`Rollback for ${c.domain}${opts.yes ? "" : " (plan only)"}:`);
	for (const p of plan) c.log(`  - ${p}`);
	if (!plan.length) return refuse(c, plan, ["Nothing to roll back"]);
	if (!opts.yes) return notApproved(c, plan, [], ` --rollback${opts.aliases ? " --aliases" : ""}`);
	const at = () => c.now().toISOString();
	const checks: GateCheck[] = [];
	for (const r of [...rules]) {
		const d = await c.call("DELETE", `/zones/${r.zoneId}/rulesets/${r.rulesetId}/rules/${r.ruleId}`);
		const gone = d.ok || d.status === 404;
		checks.push({ id: `rollback-rule:${r.alias}`, label: `${r.alias}: redirect rule removed`, ok: gone, ...(d.ok ? {} : { detail: d.status === 404 ? "already gone" : d.error ?? "" }) });
		if (gone) {
			record.aliasRules = record.aliasRules.filter((x) => x.ruleId !== r.ruleId);
			record.history.push({ at: at(), action: `${r.alias}: rule ${r.ruleId} deleted` });
		}
		saveRecord(c, record);
		c.log(`${gone ? "✔" : "✖"} ${r.alias}: rule ${r.ruleId}${gone ? " removed" : `: ${d.error}`}`);
	}
	for (const r of [...routes]) {
		const zoneId = record.zoneId as string;
		const d = await c.call("DELETE", `/zones/${zoneId}/workers/routes/${r.id}`);
		const gone = d.ok || d.status === 404;
		checks.push({ id: `rollback-route:${r.pattern}`, label: `Route ${r.pattern} removed`, ok: gone, ...(d.ok ? {} : { detail: d.status === 404 ? "already gone" : d.error ?? "" }) });
		if (gone) {
			record.routes = record.routes.filter((x) => x.id !== r.id);
			record.history.push({ at: at(), action: `route ${r.pattern} (${r.id}) deleted` });
		}
		saveRecord(c, record);
		c.log(`${gone ? "✔" : "✖"} Route ${r.pattern}${gone ? " removed" : `: ${d.error}`}`);
	}
	if (!opts.aliases && checks.every((x) => x.ok)) {
		setLive(c, false);
		delete record.liveSince;
		delete record.switchedAt;
		record.history.push({ at: at(), action: "rolled back; production.live = false" });
		saveRecord(c, record);
		c.log("✔ cloudflare.json → production.live = false");
	}
	return {
		applied: true,
		ok: checks.every((x) => x.ok),
		plan,
		blockers: [],
		checks,
		next: opts.aliases ? ["A 301 is cached by browsers: visitors who already followed one may keep landing on the primary until their cache clears"] : [`List any content edited in EmDash since the switch so it can be copied back to WordPress if the rollback lasts; rerun scaffold so IndexNow is off again (pnpm wp2emdash run ${c.slug} scaffold)`],
		record,
	};
}
