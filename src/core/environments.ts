/**
 * Which Cloudflare environments a site has (owner decision 2026-11-20, docs/PLAN.md §7a).
 *
 * Default: ONE environment — production, deployed to its workers.dev address until go-live. Staging is opt-in:
 * `target.staging: true` (or `{ enabled: true }`). A site that already runs staging keeps it without a config change:
 * `target.stagingUrl` set, or staging resources recorded in cloudflare.json, count as opted in — unless the config says
 * `target.staging: false` (or `{ enabled: false }`).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KitConfig } from "../config/schema.js";

export type TargetName = "local" | "staging" | "production";

interface CfEnv {
	d1?: { id?: string; name?: string; fingerprint?: string; location?: string };
	worker?: { url?: string };
	live?: boolean;
}
export interface CfFile {
	staging?: CfEnv;
	production?: CfEnv;
	[k: string]: unknown;
}

export interface SiteEnvironments {
	/** A staging environment exists alongside production (opt-in). */
	staging: boolean;
	/** Why: "config" (target.staging enabled), "stagingUrl", "cloudflare.json" (resources recorded), "default" or "disabled". */
	why: "config" | "stagingUrl" | "cloudflare.json" | "default" | "disabled";
	/** Production resources and its workers.dev address are recorded (provision ran). */
	productionProvisioned: boolean;
	/** The production domain serves this site (golive recorded production.live). */
	live: boolean;
}

export function readCf(root: string): CfFile {
	const file = join(root, "cloudflare.json");
	if (!existsSync(file)) return {};
	try {
		return JSON.parse(readFileSync(file, "utf8")) as CfFile;
	} catch {
		return {};
	}
}

/** The site's environments from its config and (optionally) cloudflare.json. */
export function siteEnvironments(config: Pick<KitConfig, "target">, cf: CfFile = {}): SiteEnvironments {
	const s = config.target.staging as { enabled?: boolean } | boolean | undefined;
	const enabled = typeof s === "boolean" ? s : s?.enabled;
	const productionProvisioned = !!cf.production?.d1?.id && !!cf.production?.worker?.url;
	const live = !!cf.production?.live;
	const base = { productionProvisioned, live };
	if (enabled === false) return { staging: false, why: "disabled", ...base };
	if (enabled === true) return { staging: true, why: "config", ...base };
	if (config.target.stagingUrl) return { staging: true, why: "stagingUrl", ...base };
	if (cf.staging?.d1?.id || cf.staging?.worker?.url) return { staging: true, why: "cloudflare.json", ...base };
	return { staging: false, why: "default", ...base };
}

/** Same, reading sites/<slug>/cloudflare.json. */
export function siteEnvironmentsAt(root: string, config: Pick<KitConfig, "target">): SiteEnvironments {
	return siteEnvironments(config, readCf(root));
}

/**
 * The target load / verify use when none is named (WP2EMDASH_LOAD_TARGET / WP2EMDASH_TARGET unset).
 * - Opt-in staging: load → local (as before); verify → staging once its address is known, else local.
 * - Single environment: production once provisioned (its workers.dev address before go-live), else local.
 * `noProduction` (the MCP server: the agent never targets production) falls back to local.
 */
export function defaultTarget(phase: "load" | "verify", envs: SiteEnvironments, opts: { stagingKnown?: boolean; noProduction?: boolean } = {}): TargetName {
	if (envs.staging) return phase === "verify" && opts.stagingKnown ? "staging" : "local";
	return envs.productionProvisioned && !opts.noProduction ? "production" : "local";
}

/** WP2EMDASH_NO_PRODUCTION=1: set by the MCP server; a default never resolves to production and production is refused. */
export const noProductionTargets = (env: NodeJS.ProcessEnv = process.env) => env.WP2EMDASH_NO_PRODUCTION === "1";
