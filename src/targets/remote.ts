/**
 * Remote targets for load and verify. staging: target.stagingUrl + EMDASH_TOKEN. production: before the switch its
 * workers.dev address (cloudflare.json → production.worker.url), after it (production.live) the real domain;
 * token EMDASH_TOKEN_PRODUCTION. Optional pinned addresses for a workers.dev host local DNS cannot resolve yet.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KitConfig } from "../config/schema.js";

export type TargetName = "local" | "staging" | "production";

interface Cf {
	staging?: { worker?: { addresses?: string[] } };
	production?: { live?: boolean; worker?: { url?: string; addresses?: string[] } };
}

export interface RemoteTarget {
	url: string;
	token?: string;
	addresses: string[];
	/** Serving the real domain (traffic switched): indexable, analytics on. */
	live: boolean;
}

export function remoteTarget(root: string, config: KitConfig, env: Record<string, string>, which: "staging" | "production"): RemoteTarget | { error: string } {
	const cf = (existsSync(join(root, "cloudflare.json")) ? JSON.parse(readFileSync(join(root, "cloudflare.json"), "utf8")) : {}) as Cf;
	if (which === "staging") {
		// The address provision recorded (cloudflare.json → staging.worker.url) when the config does not set one.
		const stagingUrl = config.target.stagingUrl ?? (cf.staging as { worker?: { url?: string } } | undefined)?.worker?.url;
		if (!stagingUrl) return { error: "Set target.stagingUrl in kit.config.ts (or run wp2emdash provision <slug> staging)" };
		return { url: stagingUrl.replace(/\/$/, ""), ...(env.EMDASH_TOKEN ? { token: env.EMDASH_TOKEN } : {}), addresses: cf.staging?.worker?.addresses ?? [], live: false };
	}
	const live = !!cf.production?.live;
	const url = live ? config.target.productionUrl : cf.production?.worker?.url;
	if (!url) return { error: "Deploy production first and record its address in cloudflare.json → production.worker.url" };
	return { url: url.replace(/\/$/, ""), ...(env.EMDASH_TOKEN_PRODUCTION ? { token: env.EMDASH_TOKEN_PRODUCTION } : {}), addresses: live ? [] : (cf.production?.worker?.addresses ?? []), live };
}

export function targetName(v: string | undefined, fallback: TargetName): TargetName {
	return v === "staging" || v === "production" || v === "local" ? v : fallback;
}
