/**
 * Environment and Worker-secret views (docs/PLAN.md §7a): which environments a site has, their addresses, live state
 * and rules; for each environment the runtime secrets its Worker needs ("saved locally" from .env, "set on Worker" from
 * the Cloudflare API — names only) and a "Set on Worker" action that pipes the local value into
 * `wrangler secret put` on stdin. Operator credentials (build / go-live tokens, EmDash tokens, the WordPress key) are
 * local-only: presence, fingerprint and, for Cloudflare tokens, the token-verify status and expiry. No value ever leaves
 * the server.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { credentialsFor } from "../commands/provision.js";
import { phaseState, readState } from "../core/state.js";
import { type ActionDeps, type ActionRun, BusyError, type SiteLocks, startAction } from "./actions.js";
import { UserError } from "./data.js";
import { monitorEnd, requireConfirmation, type SiteContext } from "./launch.js";
import { fingerprint } from "./secrets.js";

const API = "https://api.cloudflare.com/client/v4";
type EnvName = "production" | "staging";

interface CfEnvRecord {
	accountId?: string;
	accountName?: string;
	live?: boolean;
	liveSince?: string;
	deployedAt?: string;
	d1?: { name?: string; id?: string };
	r2?: { bucket?: string };
	worker?: { name?: string; url?: string; deployedAt?: string };
	session?: { name?: string; id?: string };
	kv?: { name?: string; id?: string };
	outbox?: { name?: string; id?: string };
}

const envRecord = (ctx: SiteContext, env: EnvName) => (ctx.cf as Record<string, unknown>)[env] as CfEnvRecord | undefined;

export const siteEnvNames = (ctx: SiteContext): EnvName[] => (ctx.envs.staging ? ["production", "staging"] : ["production"]);

// ── Environment view ─────────────────────────────────────────────────────────────────────────────────────────

export interface EnvironmentCard {
	name: EnvName;
	provisioned: boolean;
	worker?: string;
	workersDev?: string;
	/** The public address: the domain once live, else the workers.dev address. */
	publicUrl?: string;
	live: boolean;
	liveSince?: string;
	accountName?: string;
	resources: { label: string; value: string }[];
	lastDeploy?: { at: string; source: string };
	lastLoad?: { at?: string; status: string };
	/** Backups (@wp2emdash/backups): the last marker the kit recorded, and (when readable) the site's last nightly backup. */
	lastBackup?: { marker?: { at: string; reason: string }; nightly?: { at: string | null; ok: boolean; source: string } };
}

export interface EnvironmentView {
	mode: "single" | "staging";
	why: string;
	domain: string;
	canonical: string;
	environments: EnvironmentCard[];
	rules: { title: string; text: string; command?: string }[];
	monitorEndsOn?: string;
}

const WHY: Record<string, string> = {
	default: "Single environment (the default): production, on its workers.dev address until go-live.",
	disabled: "Single environment: target.staging is false in kit.config.ts.",
	config: "Staging is on (target.staging in kit.config.ts).",
	stagingUrl: "Staging is on (target.stagingUrl is set).",
	"cloudflare.json": "Staging is on (staging resources are recorded in cloudflare.json).",
};

/** The newest backup marker / D1 bookmark the kit recorded (load/d1-bookmarks.jsonl), if any. */
function lastMarker(ctx: SiteContext): { at: string; reason: string } | undefined {
	const file = join(ctx.paths.root, "load", "d1-bookmarks.jsonl");
	if (!existsSync(file)) return undefined;
	const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
	try {
		const b = JSON.parse(lines.at(-1) ?? "") as { at?: string; reason?: string; bookmark?: string };
		return b.at ? { at: b.at, reason: `${b.reason ?? "change"}${b.bookmark ? ` (D1 bookmark ${b.bookmark.slice(0, 12)}…)` : ""}` } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The Environment view plus the production site's last nightly backup, read from the Backups plugin's public heartbeat
 * (time of the last good backup and whether the last attempt worked — nothing else). 4 s at most; left out when the
 * site does not answer.
 */
export async function environmentViewLive(ctx: SiteContext, fetcher: (url: string, init?: RequestInit) => Promise<Response>): Promise<EnvironmentView> {
	const view = environmentView(ctx);
	if (ctx.config.backups === false) return view;
	const prod = view.environments.find((e) => e.name === "production");
	if (!prod?.publicUrl || !prod.provisioned) return view;
	try {
		const res = await fetcher(`${prod.publicUrl.replace(/\/$/, "")}/_emdash/api/plugins/site-backups/heartbeat`, { signal: AbortSignal.timeout(4_000) });
		if (!res.ok) {
			await res.body?.cancel();
			return view;
		}
		const d = ((await res.json().catch(() => ({}))) as { data?: { lastBackupAt?: string | null; ok?: boolean } }).data;
		if (!d) return view;
		prod.lastBackup = { ...(prod.lastBackup ?? {}), nightly: { at: d.lastBackupAt ?? null, ok: d.ok !== false, source: "Backups plugin heartbeat" } };
		prod.resources.push({ label: "Last backup", value: d.lastBackupAt ? `${d.lastBackupAt.slice(0, 16).replace("T", " ")} UTC${d.ok === false ? " (last attempt failed)" : ""}` : "none yet" });
	} catch {}
	return view;
}

export function environmentView(ctx: SiteContext): EnvironmentView {
	let loadStatus: { at?: string; status: string } | undefined;
	try {
		const s = phaseState(readState(ctx.paths.state), "load");
		loadStatus = { ...(s.finishedAt ? { at: s.finishedAt } : {}), status: s.status };
	} catch {
		loadStatus = undefined;
	}
	const cards: EnvironmentCard[] = siteEnvNames(ctx).map((name) => {
		const r = envRecord(ctx, name);
		const live = name === "production" && !!r?.live;
		const deployedAt = r?.worker?.deployedAt ?? r?.deployedAt;
		const resources: { label: string; value: string }[] = [];
		if (r?.d1?.name) resources.push({ label: "D1", value: r.d1.name });
		if (r?.r2?.bucket) resources.push({ label: "R2", value: r.r2.bucket });
		const session = r?.session ?? (r?.kv as { binding?: string; name?: string } | undefined);
		if (session?.name) resources.push({ label: "Session KV", value: session.name });
		if (r?.outbox?.name) resources.push({ label: "Form outbox KV", value: r.outbox.name });
		const mk = name === "production" ? lastMarker(ctx) : undefined;
		if (mk) resources.push({ label: "Last backup marker", value: `${mk.at.slice(0, 16).replace("T", " ")} UTC — ${mk.reason}` });
		return {
			name,
			provisioned: !!r?.d1?.id && !!r?.worker?.url,
			...(r?.worker?.name ? { worker: r.worker.name } : {}),
			...(r?.worker?.url ? { workersDev: r.worker.url } : {}),
			...(live ? { publicUrl: `https://${ctx.canonical}` } : r?.worker?.url ? { publicUrl: r.worker.url } : {}),
			live,
			...(live && r?.liveSince ? { liveSince: r.liveSince } : {}),
			...(r?.accountName ?? (ctx.cf as { accountName?: string }).accountName ? { accountName: (r?.accountName ?? (ctx.cf as { accountName?: string }).accountName) as string } : {}),
			resources,
			...(deployedAt ? { lastDeploy: { at: deployedAt, source: "cloudflare.json" } } : {}),
			...(loadStatus && name === "production" && !ctx.envs.staging ? { lastLoad: loadStatus } : {}),
			...(name === "production" && lastMarker(ctx) ? { lastBackup: { marker: lastMarker(ctx) as { at: string; reason: string } } } : {}),
		};
	});
	const prod = envRecord(ctx, "production");
	const live = !!prod?.live;
	const rules: EnvironmentView["rules"] = [];
	if (live)
		rules.push({
			title: "Production is live: reloading content needs --force",
			text: "Content is now edited in the EmDash admin. A reload overwrites those edits, so load refuses without --force and takes a D1 Time Travel bookmark first (restore command printed).",
			command: `${ctx.envs.staging ? "WP2EMDASH_LOAD_TARGET=production " : ""}pnpm wp2emdash run ${ctx.slug} load --force`,
		});
	else
		rules.push({
			title: ctx.envs.staging ? "Load targets" : "Load goes to production (workers.dev) until go-live",
			text: ctx.envs.staging ? "load: local by default (WP2EMDASH_LOAD_TARGET=staging for staging); verify: staging." : "Once provisioned, load and verify use production on its workers.dev address. Nothing public changes until go-live adds the routes.",
			command: `pnpm wp2emdash run ${ctx.slug} load`,
		});
	rules.push({
		title: "Code changes: preview URL first",
		text: "Upload a new version without deploying it, review it on its preview URL, then deploy it. Previews share production's data (D1, R2): code and layout review only.",
		command: "pnpm versions:upload   # → preview URL; then: pnpm versions:deploy",
	});
	rules.push({
		title: "Form messages",
		text: live
			? `Messages sent from https://${ctx.canonical} go to the client (email.to). Messages from workers.dev or preview links stay tests: email.stagingTo only, [Test] subject.`
			: "Before go-live every message is a test: it goes to email.stagingTo only ([Test] subject), never to the client.",
	});
	if (!ctx.envs.staging) rules.push({ title: "Staging is opt-in", text: "Add target.staging: true to kit.config.ts for a separate staging Worker with its own D1/R2/KV and secrets (bookings, payments, sensitive data, big redesigns)." });
	return {
		mode: ctx.envs.staging ? "staging" : "single",
		why: WHY[ctx.envs.why] ?? ctx.envs.why,
		domain: ctx.domain,
		canonical: ctx.canonical,
		environments: cards,
		rules,
		...(live && prod?.liveSince ? { monitorEndsOn: monitorEnd(prod.liveSince, ctx.config.target.cutover.monitorDays) } : {}),
	};
}

// ── Worker secrets ───────────────────────────────────────────────────────────────────────────────────────────

export interface RuntimeSecret {
	name: string;
	required: boolean;
	why: string;
	/** The .env key the value would come from (name only), and where it was found. */
	local: { saved: boolean; key?: string; source?: "site .env" | "kit .env"; fingerprint?: string; candidates: string[] };
	/** undefined when the Worker could not be asked. */
	onWorker?: boolean;
}

export interface WorkerSecretsEnv {
	name: EnvName;
	worker?: string;
	live: boolean;
	/** "Set on Worker" needs the typed domain (production once live). */
	needsTypedDomain: boolean;
	remote: { checked: boolean; ok: boolean; error?: string; names?: number };
	secrets: RuntimeSecret[];
	/** Names set on the Worker that the kit does not know (shown, never touched). */
	others: string[];
}

export interface CredentialStatus {
	key: string;
	label: string;
	present: boolean;
	source?: "site .env" | "kit .env";
	fingerprint?: string;
	verify?: { ok: boolean; status?: string; expiresOn?: string; detail?: string };
	reminder?: string;
}

export interface WorkerSecretsView {
	domain: string;
	environments: WorkerSecretsEnv[];
	operator: CredentialStatus[];
	note: string;
}

/** Runtime secrets the generated project's Worker needs in one environment (src/phases/cutover.ts checks the same). */
export function runtimeSecrets(ctx: SiteContext, env: EnvName): { name: string; required: boolean; why: string }[] {
	const hasForms = existsSync(join(ctx.paths.project, "src", "forms"));
	const held = !!ctx.config.forms.outbox?.hold;
	const needKey = !held && ctx.config.email.provider !== "emdash";
	const out = [
		{ name: "EMDASH_ENCRYPTION_KEY", required: true, why: "Encrypts settings stored in the admin (email credentials). Separate per environment; keep a copy in the password manager." },
		{ name: "EMAIL_API_KEY", required: hasForms && needKey, why: held ? "Form email is held in the outbox (forms.outbox.hold): not needed until it is released." : ctx.config.email.provider === "emdash" ? "EMAIL_PROVIDER=emdash sends through EmDash's Settings → Email: no key secret." : `${ctx.config.email.provider} API key for form emails.` },
		{ name: "TURNSTILE_SECRET_KEY", required: hasForms && env === "production", why: env === "production" ? "The production Turnstile widget's secret (forms)." : "Staging uses Cloudflare's test keys: not needed." },
		...(ctx.config.seo?.panel !== false && ctx.config.analytics !== false ? [{ name: "CF_ANALYTICS_TOKEN", required: false, why: `Optional: the admin dashboard's Visits widget (Cloudflare Web Analytics, last 7 days)${ctx.config.health !== false ? " and the visits in Site health's monthly report" : ""}. A token with only Account Analytics: Read.` }] : []),
		...(ctx.config.health !== false
			? [
					{ name: "CRUX_API_KEY", required: false, why: "Optional: Site health's real-visitor Core Web Vitals (Google Chrome UX Report API key). Without it the speed check uses the page build time only." },
					{ name: "CF_ZONE_READ_TOKEN", required: false, why: "Optional: Site health reads the certificate expiry (Zone Read + SSL and Certificates Read on this zone only). Cloudflare renews certificates itself." },
				]
			: []),
		...(ctx.config.backups !== false && ctx.config.backups?.offsite
			? [
					{ name: "BACKUP_S3_ACCESS_KEY_ID", required: true, why: `Off-site backup copy (backups.offsite → ${ctx.config.backups.offsite.bucket}): the access key id. Write access is enough; the site never deletes there.` },
					{ name: "BACKUP_S3_SECRET_ACCESS_KEY", required: true, why: "Off-site backup copy: the same key's secret." },
				]
			: []),
		...(ctx.config.media !== false && ctx.config.media?.autoOptimize ? [{ name: "MEDIA_API_TOKEN", required: false, why: "Optional: lets Media optimize queued uploads every hour (an EmDash API token from this admin with media write access). Without it an editor optimizes the queue with one click." }] : []),
	];
	// Anything else the project declares for local development (.dev.vars.example): names only.
	const example = join(ctx.paths.project, ".dev.vars.example");
	if (existsSync(example)) {
		for (const line of readFileSync(example, "utf8").split("\n")) {
			const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,63})\s*=/.exec(line);
			if (m?.[1] && !out.some((s) => s.name === m[1])) out.push({ name: m[1], required: false, why: "Declared in the project's .dev.vars.example." });
		}
	}
	return out;
}

/** .env keys the value for `name` in `env` is read from, in order. Encryption keys never fall back across environments. */
export function localCandidates(name: string, env: EnvName, staging: boolean): string[] {
	const scoped = `${name}_${env.toUpperCase()}`;
	if (name === "EMDASH_ENCRYPTION_KEY" && staging) return [scoped];
	return [scoped, name];
}

function findLocal(e: { kit: Record<string, string>; site: Record<string, string> }, keys: string[]): { key: string; value: string; source: "site .env" | "kit .env" } | undefined {
	for (const k of keys) {
		if (e.site[k]) return { key: k, value: e.site[k] as string, source: "site .env" };
		if (e.kit[k]) return { key: k, value: e.kit[k] as string, source: "kit .env" };
	}
	return undefined;
}

async function workerSecretNames(ctx: SiteContext, env: EnvName, deps: ActionDeps): Promise<{ ok: true; names: string[] } | { ok: false; error: string }> {
	const r = envRecord(ctx, env);
	const worker = r?.worker?.name;
	if (!worker) return { ok: false, error: `No ${env} Worker recorded in cloudflare.json (pnpm wp2emdash provision ${ctx.slug}${env === "staging" ? " staging" : ""})` };
	const e = deps.env(ctx.paths.root);
	const { token, accountId } = credentialsFor(env, { ...e.kit, ...e.site }, ctx.cf as never);
	if (!token || !accountId) return { ok: false, error: "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set (kit or site .env)" };
	try {
		const res = await deps.fetch(`${API}/accounts/${accountId}/workers/scripts/${encodeURIComponent(worker)}/secrets`, { headers: { authorization: `Bearer ${token}` } });
		const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { name: string }[]; errors?: { message: string }[] };
		if (!res.ok || j.success === false) return { ok: false, error: `${res.status === 404 ? `Worker "${worker}" not deployed yet` : (j.errors?.map((x) => x.message).join("; ") ?? "")} (HTTP ${res.status})` };
		return { ok: true, names: (j.result ?? []).map((x) => x.name).filter((n) => typeof n === "string") };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

const OPERATOR: { key: string; label: string; cloudflare?: boolean }[] = [
	{ key: "CLOUDFLARE_API_TOKEN", label: "Cloudflare build token (account; no zone access)", cloudflare: true },
	{ key: "CLOUDFLARE_API_TOKEN_PRODUCTION", label: "Cloudflare build token (production account)", cloudflare: true },
	{ key: "CLOUDFLARE_API_TOKEN_STAGING", label: "Cloudflare build token (staging account)", cloudflare: true },
	{ key: "CLOUDFLARE_GOLIVE_TOKEN", label: "Cloudflare go-live token (zone; cutover only)", cloudflare: true },
	{ key: "EMDASH_TOKEN", label: "EmDash API token (staging, or the only site)" },
	{ key: "EMDASH_TOKEN_PRODUCTION", label: "EmDash API token (production)" },
	{ key: "EMDASH_TOKEN_STAGING", label: "EmDash API token (staging)" },
	{ key: "EMDASH_WP_MIGRATION_KEY", label: "WordPress migration key (EmDash Exporter)" },
	{ key: "WP_APP_PASSWORD", label: "WordPress application password" },
];

/** Cloudflare's token verify endpoint: status and expiry only (user tokens, then account tokens). */
async function verifyCloudflareToken(token: string, accountId: string | undefined, deps: ActionDeps): Promise<CredentialStatus["verify"]> {
	const urls = [`${API}/user/tokens/verify`, ...(accountId ? [`${API}/accounts/${accountId}/tokens/verify`] : [])];
	let last = "";
	for (const url of urls) {
		try {
			const res = await deps.fetch(url, { headers: { authorization: `Bearer ${token}` } });
			const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { status?: string; expires_on?: string } };
			if (res.ok && j.success && j.result?.status) return { ok: j.result.status === "active", status: j.result.status, ...(j.result.expires_on ? { expiresOn: j.result.expires_on.slice(0, 10) } : {}) };
			last = `HTTP ${res.status}`;
		} catch (e) {
			last = (e as Error).message;
		}
	}
	return { ok: false, detail: `could not verify (${last})` };
}

export async function workerSecretsView(ctx: SiteContext, deps: ActionDeps, o: { remote?: boolean; verify?: boolean } = {}): Promise<WorkerSecretsView> {
	const e = deps.env(ctx.paths.root);
	const environments: WorkerSecretsEnv[] = [];
	for (const name of siteEnvNames(ctx)) {
		const r = envRecord(ctx, name);
		const live = name === "production" && !!r?.live;
		const remote = o.remote === false ? undefined : await workerSecretNames(ctx, name, deps);
		const have = remote?.ok ? new Set(remote.names) : undefined;
		const secrets = runtimeSecrets(ctx, name).map((s) => {
			const candidates = localCandidates(s.name, name, ctx.envs.staging);
			const found = findLocal(e, candidates);
			return {
				...s,
				local: { saved: !!found, candidates, ...(found ? { key: found.key, source: found.source, fingerprint: fingerprint(found.value) } : {}) },
				...(have ? { onWorker: have.has(s.name) } : {}),
			};
		});
		environments.push({
			name,
			...(r?.worker?.name ? { worker: r.worker.name } : {}),
			live,
			needsTypedDomain: live,
			remote: remote === undefined ? { checked: false, ok: false } : remote.ok ? { checked: true, ok: true, names: remote.names.length } : { checked: true, ok: false, error: remote.error },
			secrets,
			others: have ? [...have].filter((n) => !secrets.some((s) => s.name === n)).sort() : [],
		});
	}

	const prod = envRecord(ctx, "production");
	const ends = monitorEnd(prod?.liveSince, ctx.config.target.cutover.monitorDays);
	const today = deps.now().toISOString().slice(0, 10);
	const operator: CredentialStatus[] = [];
	for (const c of OPERATOR) {
		const v = e.site[c.key] ? { value: e.site[c.key] as string, source: "site .env" as const } : e.kit[c.key] ? { value: e.kit[c.key] as string, source: "kit .env" as const } : undefined;
		const item: CredentialStatus = { key: c.key, label: c.label, present: !!v, ...(v ? { source: v.source, fingerprint: fingerprint(v.value) } : {}) };
		if (v && c.cloudflare && o.verify) {
			const env = c.key.endsWith("_STAGING") ? "staging" : "production";
			item.verify = await verifyCloudflareToken(v.value, credentialsFor(env, { ...e.kit, ...e.site }, ctx.cf as never).accountId, deps);
		}
		if (c.key === "CLOUDFLARE_GOLIVE_TOKEN" && v) {
			item.reminder = !prod?.live
				? `For the switch only: revoke it in Cloudflare (My Profile → API Tokens) after the monitoring window (${ctx.config.target.cutover.monitorDays} days after go-live), then remove it from .env.`
				: ends && ends <= today
					? `The monitoring window ended on ${ends}: revoke this token in Cloudflare now (My Profile → API Tokens) and remove it from sites/${ctx.slug}/.env.`
					: `Live since ${prod.liveSince}: revoke it after the monitoring window ends${ends ? ` on ${ends}` : ""} (rollback needs it until then).`;
		}
		if (c.key === "WP_APP_PASSWORD" && v) item.reminder = "Revoke it in WordPress (Users → Profile → Application Passwords) once you no longer need to re-extract.";
		if (c.key === "EMDASH_WP_MIGRATION_KEY" && v) item.reminder = "Revoke it in WordPress once the final (cutover) extract is done.";
		operator.push(item);
	}
	return {
		domain: ctx.domain,
		environments,
		operator,
		note: "Values never leave this machine: the page shows names, “saved locally”, a fingerprint (first 8 hex of SHA-256) and what the Cloudflare API lists by name. “Set on Worker” pipes the local value into wrangler secret put on stdin.",
	};
}

// ── Set on Worker ────────────────────────────────────────────────────────────────────────────────────────────

const NAME_RE = /^[A-Z][A-Z0-9_]{1,63}$/;

/**
 * `wrangler secret put <NAME> [--env staging]` in the project, the value from .env on stdin (never on the command
 * line, never logged). Production needs the typed domain once the site is live; every call needs a name and an
 * explicit `confirm: true`. Single-flight per site; progress in runs/<runId>.jsonl.
 */
export function startSecretPut(ctx: SiteContext, body: Record<string, unknown>, deps: ActionDeps, locks: SiteLocks): { runId: string; done: Promise<boolean> } {
	const env = body.env;
	if (env !== "production" && env !== "staging") throw new UserError("env must be production or staging.");
	if (!siteEnvNames(ctx).includes(env)) throw new UserError("This site has no staging environment (staging is opt-in: target.staging).");
	const name = typeof body.name === "string" ? body.name : "";
	if (!NAME_RE.test(name)) throw new UserError("Unknown secret name.");
	const spec = runtimeSecrets(ctx, env).find((s) => s.name === name);
	if (!spec) throw new UserError(`${name} is not a runtime secret of this project. Operator credentials stay local and are never set on a Worker.`);
	const live = env === "production" && !!envRecord(ctx, "production")?.live;
	if (body.confirm !== true) throw new UserError("Confirm that you want to set this secret on the Worker.");
	const ok = requireConfirmation(body, { domain: ctx.domain, approval: false, typedDomain: live });
	const worker = envRecord(ctx, env)?.worker?.name;
	if (!worker) throw new UserError(`No ${env} Worker recorded in cloudflare.json.`);
	if (!existsSync(join(ctx.paths.project, "package.json"))) throw new UserError("No project yet: run scaffold first.");
	const e = deps.env(ctx.paths.root);
	const found = findLocal(e, localCandidates(name, env, ctx.envs.staging));
	if (!found) throw new UserError(`Not saved locally: set ${localCandidates(name, env, ctx.envs.staging).join(" or ")} in the Secrets tab first.`);
	const { token, accountId } = credentialsFor(env, { ...e.kit, ...e.site }, ctx.cf as never);
	if (!token || !accountId) throw new UserError("CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID not set (kit or site .env).");
	const held = locks.get(ctx.slug);
	if (held) throw new BusyError(held);
	const value = found.value;
	return startAction(locks, ctx.slug, "secret-put", ctx.sitesDir, deps, async (run: ActionRun) => {
		run.log("info", `Set ${name} on Worker "${worker}" (${env}) from ${found.key} in the ${found.source} (fingerprint ${fingerprint(value)}) — by ${ok.by}.`);
		const args = ["--no-install", "wrangler", "secret", "put", name, ...(env === "staging" ? ["--env", "staging"] : [])];
		run.log("info", `$ npx ${args.join(" ")}   # value on stdin`);
		const r = await deps.exec("npx", args, {
			cwd: ctx.paths.project,
			env: { ...process.env, CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: accountId, NO_COLOR: "1", FORCE_COLOR: "0", WRANGLER_SEND_METRICS: "false" },
			input: value,
			timeoutMs: 120_000,
			onLine: (line, stream) => run.log(stream === "stderr" ? "warn" : "info", line),
		});
		run.step(`${name} → ${worker}`, r.code === 0, r.code === 0 ? "set (value not shown)" : `wrangler exited ${r.code}`);
		return r.code === 0;
	});
}
