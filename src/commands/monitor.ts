/**
 * `wp2emdash monitor init|build`: the agency's outside-in monitor (packages/monitor, docs/monitor.md).
 *
 * Where it lives: `<kit>/monitor/` by default (gitignored: it names client domains and the agency's alert address),
 * or `--dir <path>` / WP2EMDASH_MONITOR_DIR — e.g. its own private repository. `init` writes the operator's
 * `monitor.config.json` there (never overwritten); `build` regenerates the deployable Worker next to it:
 * `wrangler.jsonc`, `package.json`, `src/*.ts` (copied from packages/monitor + @wp2emdash/forms' deliver.ts) and
 * `src/monitor-config.ts` — the site list (production domain once cloudflare.json says production.live, else the
 * workers.dev address) plus the extra URLs, and the alert addresses. No token is ever written: secrets are set with
 * `wrangler secret put`. Nothing is deployed and no Cloudflare resource is created here.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { MonitorConfig, MonitorSite } from "../../packages/monitor/src/types.js";
import { loadConfig } from "../config/load.js";
import { KIT_ROOT, SITES_DIR, sitePaths } from "../core/paths.js";
import { STACK } from "../phases/scaffold.js";
import { listSites } from "./status.js";

export const MONITOR_DIR = process.env.WP2EMDASH_MONITOR_DIR ? resolve(process.env.WP2EMDASH_MONITOR_DIR) : join(KIT_ROOT, "monitor");
export const OPERATOR_FILE = "monitor.config.json";
const PACKAGE_SRC = join(KIT_ROOT, "packages", "monitor", "src");
const DELIVER_SRC = join(KIT_ROOT, "packages", "forms", "src", "deliver.ts");

const extraSchema = z.union([
	z.url(),
	z.object({ url: z.url(), id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,62}$/).optional(), keyword: z.string().min(1).max(100).optional(), domain: z.string().optional(), expiry: z.boolean().optional() }),
]);

/** monitor.config.json — the operator's settings. URLs and addresses only; secrets never go here. */
export const operatorSchema = z.object({
	$comment: z.string().optional(),
	label: z.string().max(60).optional(),
	alertTo: z.array(z.email()).default([]),
	from: z.string().optional(),
	emailProvider: z.enum(["brevo", "resend", "postmark", "sendgrid", "mailgun"]).default("brevo"),
	telegramChatId: z.string().regex(/^(-?\d{1,20}|@[A-Za-z][\w]{3,31})$/).optional(),
	extraUrls: z.array(extraSchema).default([]),
	/** Per-site keyword the home page must contain, by slug. */
	keywords: z.record(z.string(), z.string().min(1).max(100)).default({}),
	/** Slugs not to monitor. */
	exclude: z.array(z.string()).default([]),
	timeoutSeconds: z.number().int().min(2).max(30).default(10),
	expiryWarnDays: z.number().int().min(1).max(60).default(14),
	maxAlertsPerDay: z.number().int().min(1).max(200).default(20),
	weeklySummary: z.boolean().default(false),
	workerName: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).default("wp2emdash-monitor"),
	/** The Cloudflare account the monitor deploys to — ideally not the one the sites run in (docs/monitor.md). */
	accountId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
	/** `wrangler kv namespace create MONITOR_KV` → its id. */
	kvNamespaceId: z.string().regex(/^[0-9a-f]{32}$/).optional(),
	/** free: warns when the site list may exceed 50 subrequests per tick. */
	plan: z.enum(["free", "paid"]).default("free"),
});
export type OperatorConfig = z.infer<typeof operatorSchema>;

export const OPERATOR_TEMPLATE = {
	$comment: "wp2emdash outside-in monitor. URLs and addresses only: secrets go in Wrangler secrets (docs/monitor.md). Then: pnpm wp2emdash monitor build",
	label: "",
	alertTo: [],
	from: "",
	emailProvider: "brevo",
	extraUrls: [],
	keywords: {},
	exclude: [],
	timeoutSeconds: 10,
	expiryWarnDays: 14,
	maxAlertsPerDay: 20,
	weeklySummary: false,
	workerName: "wp2emdash-monitor",
	plan: "free",
};

interface Cf {
	production?: { live?: boolean; worker?: { url?: string } };
}

/** The address to monitor for one site: the production domain once live, else its workers.dev address. Pure. */
export function siteUrl(productionUrl: string | undefined, cf: Cf): { url: string; live: boolean } | { skip: string } {
	if (cf.production?.live) return productionUrl ? { url: productionUrl, live: true } : { skip: "live but no target.productionUrl" };
	const w = cf.production?.worker?.url;
	return w ? { url: w, live: false } : { skip: "not deployed yet (no production.worker.url in cloudflare.json)" };
}

export interface CollectedSite {
	slug: string;
	url?: string;
	live?: boolean;
	skip?: string;
}

const readJson = <T>(file: string): T | undefined => {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
};

/** target.productionUrl: the validated config, else read from the text (a partial or older config). */
async function productionUrlOf(configFile: string): Promise<string | undefined> {
	try {
		return (await loadConfig(configFile)).target.productionUrl;
	} catch {
		const m = /productionUrl\s*:\s*(["'`])(https?:\/\/[^"'`\s]+)\1/.exec(readFileSync(configFile, "utf8"));
		return m?.[2];
	}
}

/** Every site under sites/ with the address to watch, or why it is skipped. Reads files only. */
export async function collectSites(sitesDir = SITES_DIR): Promise<CollectedSite[]> {
	const out: CollectedSite[] = [];
	for (const slug of listSites(sitesDir)) {
		const p = sitePaths(slug, sitesDir);
		const cf = readJson<Cf>(join(p.root, "cloudflare.json")) ?? {};
		const r = siteUrl(cf.production?.live ? await productionUrlOf(p.config) : undefined, cf);
		out.push("skip" in r ? { slug, skip: r.skip } : { slug, url: r.url, live: r.live });
	}
	return out;
}

const homeUrl = (u: string) => {
	const x = new URL(u);
	return `${x.protocol === "http:" ? "https:" : x.protocol}//${x.host}/`;
};

/** Operator settings + collected sites → the Worker's config. Pure. */
export function generateMonitorConfig(op: OperatorConfig, sites: CollectedSite[]): { config: MonitorConfig; skipped: { slug: string; why: string }[] } {
	const skipped: { slug: string; why: string }[] = [];
	const out: MonitorSite[] = [];
	const seen = new Set<string>();
	const add = (s: MonitorSite) => {
		const key = s.url.toLowerCase();
		if (seen.has(key) || out.some((o) => o.id === s.id)) return false;
		seen.add(key);
		out.push(s);
		return true;
	};
	for (const s of sites) {
		if (op.exclude.includes(s.slug)) skipped.push({ slug: s.slug, why: "excluded in monitor.config.json" });
		else if (!s.url) skipped.push({ slug: s.slug, why: s.skip ?? "no address" });
		else add({ id: s.slug, url: homeUrl(s.url), source: "site", ...(op.keywords[s.slug] ? { keyword: op.keywords[s.slug] as string } : {}) });
	}
	for (const e of op.extraUrls) {
		const x = typeof e === "string" ? { url: e } : e;
		const url = homeUrl(x.url);
		const id = x.id ?? new URL(url).hostname.replace(/^www\./, "");
		if (!add({ id, url, source: "extra", ...(x.keyword ? { keyword: x.keyword } : {}), ...(x.domain ? { domain: x.domain } : {}), ...(x.expiry === false ? { expiry: false } : {}) })) skipped.push({ slug: id, why: "duplicate address or id" });
	}
	const config: MonitorConfig = {
		version: 1,
		sites: out,
		alertTo: op.alertTo,
		...(op.from ? { from: op.from } : {}),
		emailProvider: op.emailProvider,
		...(op.telegramChatId ? { telegramChatId: op.telegramChatId } : {}),
		timeoutMs: op.timeoutSeconds * 1000,
		expiryWarnDays: op.expiryWarnDays,
		maxAlertsPerDay: op.maxAlertsPerDay,
		weeklySummary: op.weeklySummary,
		...(op.label ? { label: op.label } : {}),
	};
	return { config, skipped };
}

/** Subrequests one tick may need: each site ≤ 2 (one same-site redirect), a few expiry lookups, alerts, heartbeat. */
export const subrequestEstimate = (sites: number) => sites * 2 + Math.max(1, Math.ceil(sites / 288)) * 4 + 4;

export function wranglerConfig(op: OperatorConfig, compatibilityDate: string): string {
	const w = {
		$schema: "node_modules/wrangler/config-schema.json",
		name: op.workerName,
		...(op.accountId ? { account_id: op.accountId } : {}),
		main: "src/worker.ts",
		compatibility_date: compatibilityDate,
		// fetch() goes out through the public internet: sites in the same account / zone are reached like a visitor would.
		compatibility_flags: ["global_fetch_strictly_public"],
		workers_dev: true,
		preview_urls: false,
		triggers: { crons: ["*/5 * * * *"] },
		kv_namespaces: [{ binding: "MONITOR_KV", id: op.kvNamespaceId ?? "REPLACE_WITH_KV_NAMESPACE_ID" }],
		observability: { enabled: true },
	};
	return `// Generated by wp2emdash monitor build. Edit monitor.config.json and rebuild instead of editing this file.\n// Secrets (never here): EMAIL_API_KEY, STATUS_TOKEN, optional TELEGRAM_BOT_TOKEN, SLACK_WEBHOOK_URL, HEARTBEAT_URL, CERTSPOTTER_API_KEY.\n${JSON.stringify(w, null, "\t")}\n`;
}

export function monitorInit(o: { dir?: string } = {}): { file: string; created: boolean } {
	const dir = resolve(o.dir ?? MONITOR_DIR);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, OPERATOR_FILE);
	if (existsSync(file)) return { file, created: false };
	writeFileSync(file, `${JSON.stringify(OPERATOR_TEMPLATE, null, 2)}\n`);
	return { file, created: true };
}

export interface BuildResult {
	dir: string;
	sites: MonitorSite[];
	skipped: { slug: string; why: string }[];
	warnings: string[];
	files: string[];
}

export async function monitorBuild(o: { dir?: string; sitesDir?: string; now?: Date } = {}): Promise<BuildResult> {
	const dir = resolve(o.dir ?? MONITOR_DIR);
	const opFile = join(dir, OPERATOR_FILE);
	if (!existsSync(opFile)) throw new Error(`No ${OPERATOR_FILE} in ${dir}: run wp2emdash monitor init first`);
	const parsed = operatorSchema.safeParse(JSON.parse(readFileSync(opFile, "utf8")));
	if (!parsed.success) throw new Error(`Invalid ${opFile}:\n${parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n")}`);
	const op = parsed.data;
	const { config, skipped } = generateMonitorConfig(op, await collectSites(o.sitesDir));

	const warnings: string[] = [];
	if (!config.sites.length) warnings.push("No site to monitor yet (no deployed site under sites/, no extraUrls).");
	if (!op.alertTo.length) warnings.push('No "alertTo" address: email alerts are off.');
	if (op.alertTo.length && !op.from) warnings.push('No "from" address: email alerts are off (use a sender verified at your email provider).');
	if (!op.kvNamespaceId) warnings.push('No "kvNamespaceId": create it with `npx wrangler kv namespace create MONITOR_KV` and put the id in monitor.config.json, then rebuild (deploy fails until then).');
	if (!op.accountId) warnings.push('No "accountId": wrangler deploys to the account you are logged in to. Prefer an account the client sites do not run in (docs/monitor.md).');
	const est = subrequestEstimate(config.sites.length);
	if (op.plan === "free" && est > 50) warnings.push(`About ${est} subrequests per tick: over the Workers Free limit (50). Use Workers Paid (plan: "paid") or split the list across two monitors.`);

	const src = join(dir, "src");
	mkdirSync(src, { recursive: true });
	const files: string[] = [];
	const write = (rel: string, text: string) => {
		writeFileSync(join(dir, rel), text);
		files.push(rel);
	};
	for (const f of readdirSync(PACKAGE_SRC).filter((f) => f.endsWith(".ts") && f !== "monitor-config.ts")) {
		const text = readFileSync(join(PACKAGE_SRC, f), "utf8").replace(/(["'])@wp2emdash\/forms\/deliver\1/g, '"./deliver.js"');
		write(join("src", f), text);
	}
	copyFileSync(DELIVER_SRC, join(src, "deliver.ts"));
	files.push(join("src", "deliver.ts"));
	write(join("src", "monitor-config.ts"), `// Generated by wp2emdash monitor build (${(o.now ?? new Date()).toISOString().slice(0, 10)}). URLs and alert addresses only.\nimport type { MonitorConfig } from "./types.js";\n\nconst config: MonitorConfig = ${JSON.stringify(config, null, "\t")};\n\nexport default config;\n`);
	const compat = new Date((o.now ?? new Date()).getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
	const prev = existsSync(join(dir, "wrangler.jsonc")) ? readFileSync(join(dir, "wrangler.jsonc"), "utf8") : "";
	const kept = /"compatibility_date":\s*"(\d{4}-\d{2}-\d{2})"/.exec(prev)?.[1];
	write("wrangler.jsonc", wranglerConfig(op, kept ?? compat));
	write("package.json", `${JSON.stringify({ name: op.workerName, private: true, type: "module", scripts: { deploy: "wrangler deploy", dev: "wrangler dev", tail: "wrangler tail" }, devDependencies: { wrangler: STACK.wrangler } }, null, 2)}\n`);
	write(".gitignore", "node_modules/\n.wrangler/\n.dev.vars\n.env\n");
	return { dir, sites: config.sites, skipped, warnings, files };
}
