/**
 * Remote targets for load and verify. staging (opt-in): target.stagingUrl + EMDASH_TOKEN. production: before the
 * switch its workers.dev address (cloudflare.json → production.worker.url), after it (production.live) the real
 * domain; token EMDASH_TOKEN_PRODUCTION — on a single-environment site EMDASH_TOKEN is accepted as an alias (there is
 * only one EmDash to hold a token for). Optional pinned addresses for a workers.dev host local DNS cannot resolve yet.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KitConfig } from "../config/schema.js";
import { siteEnvironments, type TargetName } from "../core/environments.js";

export type { TargetName } from "../core/environments.js";

interface Cf {
	staging?: { worker?: { addresses?: string[] } };
	production?: { live?: boolean; worker?: { url?: string; addresses?: string[] } };
}

export interface RemoteTarget {
	url: string;
	token?: string;
	/** The variable the token came from (for messages). */
	tokenName: string;
	addresses: string[];
	/** Serving the real domain (traffic switched): indexable, analytics on. */
	live: boolean;
}

/** The token variable(s) a target reads, in order. Single-environment sites accept EMDASH_TOKEN for production. */
export function tokenNames(which: "staging" | "production", singleEnv: boolean): string[] {
	if (which === "staging") return ["EMDASH_TOKEN"];
	return singleEnv ? ["EMDASH_TOKEN_PRODUCTION", "EMDASH_TOKEN"] : ["EMDASH_TOKEN_PRODUCTION"];
}

export function remoteTarget(root: string, config: KitConfig, env: Record<string, string>, which: "staging" | "production"): RemoteTarget | { error: string } {
	const cf = (existsSync(join(root, "cloudflare.json")) ? JSON.parse(readFileSync(join(root, "cloudflare.json"), "utf8")) : {}) as Cf;
	const names = tokenNames(which, !siteEnvironments(config, cf as never).staging);
	const tokenName = names.find((n) => env[n]) ?? (names[0] as string);
	const token = env[tokenName];
	if (which === "staging") {
		// The address provision recorded (cloudflare.json → staging.worker.url) when the config does not set one.
		const stagingUrl = config.target.stagingUrl ?? (cf.staging as { worker?: { url?: string } } | undefined)?.worker?.url;
		if (!stagingUrl) return { error: "Set target.stagingUrl in kit.config.ts (or run wp2emdash provision <slug> staging)" };
		return { url: stagingUrl.replace(/\/$/, ""), ...(token ? { token } : {}), tokenName, addresses: cf.staging?.worker?.addresses ?? [], live: false };
	}
	const live = !!cf.production?.live;
	const url = live ? config.target.productionUrl : cf.production?.worker?.url;
	if (!url) return { error: "Provision and deploy production first (wp2emdash provision <slug> production records its address in cloudflare.json → production.worker.url)" };
	return { url: url.replace(/\/$/, ""), ...(token ? { token } : {}), tokenName, addresses: live ? [] : (cf.production?.worker?.addresses ?? []), live };
}

export function targetName(v: string | undefined, fallback: TargetName): TargetName {
	return v === "staging" || v === "production" || v === "local" ? v : fallback;
}
