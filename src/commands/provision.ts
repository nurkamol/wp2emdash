/**
 * `wp2emdash provision <slug> [production|staging]`: create the Cloudflare resources an environment needs — D1
 * database, R2 media bucket, KV form outbox (when the site keeps one), the Astro sessions store (EmDash sign-in: a
 * private R2 bucket `<worker>-sessions` with a lifecycle rule by default, or the `SESSION` KV namespace with kit.config
 * `sessions: "kv"`; docs/spikes/sessions-findings.md), and for production the backups restore test's empty scratch D1 database
 * `<slug>-restore-drill-db` (docs/spikes/backup-findings.md) — in the account that environment runs in, and record them in sites/<slug>/cloudflare.json. Idempotent (an existing resource with the same name is reused) and
 * never deletes anything: when the environment moves to another account, the old entries are kept under `previous`
 * so they can be removed later, once the new environment serves traffic.
 *
 * Credentials: `CLOUDFLARE_API_TOKEN_<ENV>` / `CLOUDFLARE_ACCOUNT_ID_<ENV>` from the site's .env when set (an
 * environment in a different account, e.g. production in the client's own account), else `CLOUDFLARE_API_TOKEN` /
 * `CLOUDFLARE_ACCOUNT_ID`. Token permissions: docs/cloudflare-api-token.md (token A).
 *
 * Production is the default and, for a single-environment site (the default since 2026-11-20), the only environment;
 * `staging` is refused unless the site opted into staging (src/core/environments.ts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { siteEnvironments } from "../core/environments.js";
import { sitePaths } from "../core/paths.js";
import { loadSiteEnv } from "../extract/credentials.js";

const API = "https://api.cloudflare.com/client/v4";
export type Env = "staging" | "production";

export interface EnvResources {
	accountId?: string;
	accountName?: string;
	d1?: { name: string; id: string; location?: string; fingerprint?: string };
	r2?: { bucket: string; location?: string };
	outbox?: { name: string; id: string };
	/** KV namespace bound as SESSION (Astro sessions); "<worker>-session", the title Wrangler would auto-provision. */
	session?: { name: string; id: string };
	/** Private R2 bucket bound as SESSIONS (Astro sessions, kit.config sessions "r2"); objects deleted after `days`. */
	sessions?: { bucket: string; location?: string; days: number };
	/** Empty D1 database bound as RESTORE_DRILL_DB: backups' monthly restore test (production only). */
	restoreDrill?: { name: string; id: string };
	worker?: { name?: string; url?: string; addresses?: string[] };
	live?: boolean;
	previous?: Omit<EnvResources, "previous">[];
	[k: string]: unknown;
}

/** Token and account for an environment: the environment-specific pair when set, else the shared one. */
export function credentialsFor(env: Env, vars: Record<string, string | undefined>, cf: { accountId?: string } & Partial<Record<Env, EnvResources>> = {}): { token?: string; accountId?: string; scoped: boolean } {
	const suffix = env.toUpperCase();
	const token = vars[`CLOUDFLARE_API_TOKEN_${suffix}`];
	const account = vars[`CLOUDFLARE_ACCOUNT_ID_${suffix}`];
	if (token || account) return { token: token ?? vars.CLOUDFLARE_API_TOKEN, accountId: account ?? cf[env]?.accountId ?? vars.CLOUDFLARE_ACCOUNT_ID, scoped: true };
	return { token: vars.CLOUDFLARE_API_TOKEN, accountId: cf[env]?.accountId ?? vars.CLOUDFLARE_ACCOUNT_ID ?? cf.accountId, scoped: false };
}

export interface ProvisionResult {
	env: Env;
	accountId: string;
	accountName?: string;
	created: string[];
	reused: string[];
	movedFrom?: string;
	workersSubdomain?: string;
	notes: string[];
}

export async function provision(slug: string, env: Env, opts: { location?: string; sitesDir?: string; vars?: Record<string, string | undefined> } = {}, fetcher: typeof fetch = fetch): Promise<ProvisionResult> {
	const paths = opts.sitesDir ? sitePaths(slug, opts.sitesDir) : sitePaths(slug);
	const config = await loadConfig(paths.config);
	const vars = opts.vars ?? ({ ...process.env, ...loadSiteEnv(paths.root) } as Record<string, string | undefined>);
	const cfFile = join(paths.root, "cloudflare.json");
	const cf = (existsSync(cfFile) ? JSON.parse(readFileSync(cfFile, "utf8")) : {}) as { accountId?: string; accountName?: string } & Partial<Record<Env, EnvResources>>;
	// Staging is opt-in (src/core/environments.ts): a single-environment site gets production resources only.
	if (env === "staging" && !siteEnvironments(config, cf as never).staging) throw new Error(`${slug} has one environment (production); staging is opt-in. To add it, set target.staging: true in sites/${slug}/kit.config.ts first (docs/staging-setup.md).`);
	const { token, accountId } = credentialsFor(env, vars, cf);
	if (!token || !accountId) throw new Error(`No Cloudflare token/account for ${env}: set CLOUDFLARE_API_TOKEN${env === "production" ? "_PRODUCTION" : ""} and CLOUDFLARE_ACCOUNT_ID${env === "production" ? "_PRODUCTION" : ""} (docs/cloudflare-api-token.md).`);
	const call = async <T>(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; result?: T; errors?: { code: number; message: string }[]; info?: { total_pages?: number } }> => {
		const res = await fetcher(`${API}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
		const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { code: number; message: string }[]; result_info?: { total_pages?: number } };
		return { ok: res.ok && j.success !== false, status: res.status, ...(j.result_info ? { info: j.result_info } : {}), ...(j.result !== undefined ? { result: j.result } : {}), ...(j.errors ? { errors: j.errors } : {}) };
	};
	const fail = (what: string, r: { status: number; errors?: { message: string }[] }) => new Error(`${what}: ${r.errors?.map((e) => e.message).join("; ") || `HTTP ${r.status}`}`);

	const account = await call<{ name: string }>("GET", `/accounts/${accountId}`);
	if (!account.ok) throw fail("The token cannot read this account (Account Settings: Read)", account);
	const current: EnvResources = { ...(cf[env] ?? {}) };
	// Legacy files keep one top-level account for every environment.
	const currentAccount = current.accountId ?? cf.accountId;
	const result: ProvisionResult = { env, accountId, ...(account.result?.name ? { accountName: account.result.name } : {}), created: [], reused: [], notes: [] };
	let next: EnvResources = { ...current };
	if (currentAccount && currentAccount !== accountId && (current.d1 || current.r2 || current.worker)) {
		const { previous: _p, ...old } = current;
		next = { ...(current.live !== undefined ? { live: false } : {}), previous: [...(current.previous ?? []), { ...old, accountId: currentAccount, ...(cf.accountName && !current.accountId ? { accountName: cf.accountName } : {}) }] };
		result.movedFrom = currentAccount;
	}
	next.accountId = accountId;
	if (account.result?.name) next.accountName = account.result.name;
	const location = opts.location ?? current.d1?.location ?? current.r2?.location ?? "enam";
	const names = env === "production" ? { d1: `${slug}-db`, r2: `${slug}-media`, kv: `${slug}-form-outbox` } : { d1: `${slug}-staging-db`, r2: `${slug}-stg-media`, kv: `${slug}-staging-form-outbox` };

	// D1
	const d1Name = next.d1?.name ?? names.d1;
	const found = await call<{ uuid: string; name: string }[]>("GET", `/accounts/${accountId}/d1/database?name=${encodeURIComponent(d1Name)}`);
	const hit = found.result?.find((d) => d.name === d1Name);
	if (hit) {
		next.d1 = { ...(next.d1?.id === hit.uuid ? next.d1 : {}), name: d1Name, id: hit.uuid, location };
		result.reused.push(`D1 ${d1Name}`);
	} else {
		const made = await call<{ uuid: string }>("POST", `/accounts/${accountId}/d1/database`, { name: d1Name, primary_location_hint: location });
		if (!made.ok || !made.result) throw fail(`Creating D1 ${d1Name} (D1: Edit)`, made);
		next.d1 = { name: d1Name, id: made.result.uuid, location };
		result.created.push(`D1 ${d1Name}`);
		result.notes.push("New database: after the first `emdash migrate`, record its target fingerprint as d1.fingerprint (docs/staging-setup.md §6).");
	}

	// R2
	const bucket = next.r2?.bucket ?? names.r2;
	const existing = await call("GET", `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}`);
	if (existing.ok) result.reused.push(`R2 ${bucket}`);
	else {
		const made = await call("POST", `/accounts/${accountId}/r2/buckets`, { name: bucket, locationHint: location });
		if (!made.ok) throw fail(`Creating R2 bucket ${bucket} (Workers R2 Storage: Edit)`, made);
		result.created.push(`R2 ${bucket}`);
	}
	next.r2 = { bucket, location };

	// Sessions bucket (kit.config sessions "r2", the default): EmDash sign-in sessions. Private — never public, no
	// custom domain. Same location as the media bucket. A lifecycle rule deletes objects `days` after their last write
	// (Astro's session ttl is the same; Astro stores the expiry in the value, R2 has no TTL of its own).
	const workerName = env === "production" ? slug : `${slug}-staging`;
	if (config.sessions.store === "r2") {
		const sBucket = next.sessions?.bucket ?? `${workerName}-sessions`;
		const days = config.sessions.days;
		const sExisting = await call("GET", `/accounts/${accountId}/r2/buckets/${encodeURIComponent(sBucket)}`);
		if (sExisting.ok) result.reused.push(`R2 ${sBucket}`);
		else {
			const made = await call("POST", `/accounts/${accountId}/r2/buckets`, { name: sBucket, locationHint: location });
			if (!made.ok) throw fail(`Creating R2 bucket ${sBucket} (Workers R2 Storage: Edit)`, made);
			result.created.push(`R2 ${sBucket}`);
		}
		await sessionsLifecycle(call, fail, accountId, sBucket, days, result);
		await keepPrivate(call, fail, accountId, sBucket, result);
		next.sessions = { bucket: sBucket, location, days };
	}

	// KV namespaces: every page of the account's list (the title is the only key to find an existing one by).
	let kvList: { id: string; title: string }[] | undefined;
	const kvNamespaces = async () => {
		if (kvList) return kvList;
		const all: { id: string; title: string }[] = [];
		for (let page = 1; page <= 50; page++) {
			const r = await call<{ id: string; title: string }[]>("GET", `/accounts/${accountId}/storage/kv/namespaces?per_page=100&page=${page}`);
			if (!r.ok) throw fail("Listing KV namespaces (Workers KV Storage: Edit)", r);
			all.push(...(r.result ?? []));
			if ((r.result ?? []).length < 100 || page >= (r.info?.total_pages ?? page)) break;
		}
		kvList = all;
		return all;
	};
	const kv = async (title: string): Promise<{ name: string; id: string }> => {
		const ns = (await kvNamespaces()).find((n) => n.title === title);
		if (ns) {
			result.reused.push(`KV ${title}`);
			return { name: title, id: ns.id };
		}
		const made = await call<{ id: string }>("POST", `/accounts/${accountId}/storage/kv/namespaces`, { title });
		if (!made.ok || !made.result) throw fail(`Creating KV namespace ${title} (Workers KV Storage: Edit)`, made);
		result.created.push(`KV ${title}`);
		return { name: title, id: made.result.id };
	};

	// KV form outbox (only for sites that keep one)
	if (config.forms.outbox) next.outbox = await kv(next.outbox?.name ?? names.kv);

	// KV for Astro sessions (binding SESSION; kit.config sessions "kv"). Bound explicitly in wrangler.jsonc so the first `wrangler deploy` does not
	// auto-provision it: a deploy that fails after that step leaves "<worker>-session" behind and every retry fails with
	// 10014 "namespace already exists" (docs/spikes/M8-findings.md). Same title Wrangler uses, so a namespace an earlier
	// deploy already created is found and reused: nothing changes for an existing site.
	// Sessions on R2: no new namespace; one recorded earlier stays in cloudflare.json (a switch back to "kv" reuses it).
	if (config.sessions.store === "kv") next.session = await kv(next.session?.name ?? `${workerName}-session`);

	// Backups' restore test (production only): an EMPTY scratch D1 database the Worker restores the newest backup into
	// once a month, then empties (bound as RESTORE_DRILL_DB by the next scaffold). A Worker cannot create a database
	// itself without an account token, so it is created here, ahead of time. Not for staging (the test never runs there).
	if (env === "production" && config.backups !== false && config.backups.restoreDrill !== false) {
		const drillName = next.restoreDrill?.name ?? `${slug}-restore-drill-db`;
		const got = await call<{ uuid: string; name: string }[]>("GET", `/accounts/${accountId}/d1/database?name=${encodeURIComponent(drillName)}`);
		const drillHit = got.result?.find((d) => d.name === drillName);
		if (drillHit) {
			next.restoreDrill = { name: drillName, id: drillHit.uuid };
			result.reused.push(`D1 ${drillName}`);
		} else {
			const made = await call<{ uuid: string }>("POST", `/accounts/${accountId}/d1/database`, { name: drillName, primary_location_hint: location });
			if (!made.ok || !made.result) throw fail(`Creating D1 ${drillName} (D1: Edit)`, made);
			next.restoreDrill = { name: drillName, id: made.result.uuid };
			result.created.push(`D1 ${drillName}`);
			result.notes.push(`${drillName}: empty scratch database for the monthly backup restore test (never migrated, never holds live data); rerun the scaffold to bind it as RESTORE_DRILL_DB.`);
		}
	}

	// workers.dev subdomain: the Worker's preview address until the switch.
	const sub = await call<{ subdomain?: string }>("GET", `/accounts/${accountId}/workers/subdomain`);
	if (sub.result?.subdomain) {
		result.workersSubdomain = sub.result.subdomain;
		const worker = workerName;
		next.worker = { name: worker, url: `https://${worker}.${sub.result.subdomain}.workers.dev` };
	} else result.notes.push("The account has no workers.dev subdomain yet: open Workers & Pages once in the dashboard (it offers one) before the first deploy.");

	cf[env] = next;
	writeFileSync(cfFile, `${JSON.stringify(cf, null, 2)}\n`);
	return result;
}

type Call = <T>(method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; result?: T; errors?: { code: number; message: string }[] }>;
type Fail = (what: string, r: { status: number; errors?: { message: string }[] }) => Error;
/** Lifecycle rule id the kit owns on a sessions bucket; other rules (e.g. R2's default multipart abort) are kept. */
export const SESSIONS_RULE_ID = "wp2emdash-sessions-expire";

/**
 * The sessions bucket's expiry rule: objects deleted `days` days after their last write. PUT replaces the whole rule
 * set, so the current rules are read first and only the kit's own rule (by id) is added or replaced — as
 * `wrangler r2 bucket lifecycle add` does. No write when the rule is already as wanted.
 */
async function sessionsLifecycle(call: Call, fail: Fail, accountId: string, bucket: string, days: number, result: ProvisionResult): Promise<void> {
	type Rule = { id: string; enabled: boolean; conditions: { prefix?: string }; deleteObjectsTransition?: { condition: { type: string; maxAge?: number } } };
	const path = `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/lifecycle`;
	const cur = await call<{ rules?: Rule[] }>("GET", path);
	if (!cur.ok) throw fail(`Reading the lifecycle rules of ${bucket} (Workers R2 Storage: Edit)`, cur);
	const rules = cur.result?.rules ?? [];
	const want: Rule = { id: SESSIONS_RULE_ID, enabled: true, conditions: {}, deleteObjectsTransition: { condition: { type: "Age", maxAge: days * 86400 } } };
	const have = rules.find((r) => r.id === SESSIONS_RULE_ID);
	if (have && have.enabled && !have.conditions?.prefix && have.deleteObjectsTransition?.condition.type === "Age" && have.deleteObjectsTransition.condition.maxAge === days * 86400) return;
	const put = await call("PUT", path, { rules: [...rules.filter((r) => r.id !== SESSIONS_RULE_ID), want] });
	if (!put.ok) throw fail(`Setting the lifecycle rule of ${bucket} (Workers R2 Storage: Edit)`, put);
	result.notes.push(`${bucket}: sessions deleted ${days} days after their last write (lifecycle rule ${SESSIONS_RULE_ID}).`);
}

/** Sign-in sessions are never served publicly: r2.dev access is switched off if someone turned it on; a custom domain is refused. */
async function keepPrivate(call: Call, fail: Fail, accountId: string, bucket: string, result: ProvisionResult): Promise<void> {
	const base = `/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/domains`;
	const managed = await call<{ enabled?: boolean }>("GET", `${base}/managed`);
	if (managed.ok && managed.result?.enabled) {
		const off = await call("PUT", `${base}/managed`, { enabled: false });
		if (!off.ok) throw fail(`${bucket} is public on r2.dev and could not be made private (Workers R2 Storage: Edit)`, off);
		result.notes.push(`${bucket}: public r2.dev access was on; switched off (sign-in sessions must never be public).`);
	}
	const custom = await call<{ domains?: { domain: string }[] }>("GET", `${base}/custom`);
	const domains = custom.result?.domains ?? [];
	if (domains.length) throw new Error(`${bucket} holds sign-in sessions but is served on ${domains.map((d) => d.domain).join(", ")}: remove the custom domain in the Cloudflare dashboard (R2 → ${bucket} → Settings), then provision again.`);
}
