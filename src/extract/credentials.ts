import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_ROOT } from "../core/paths.js";

/** Parse a dotenv file. Values are never logged. */
export function loadEnv(file: string): Record<string, string> {
	if (!existsSync(file)) return {};
	const out: Record<string, string> = {};
	for (const raw of readFileSync(file, "utf8").split("\n")) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq < 1) continue;
		let value = line.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
		out[line.slice(0, eq).trim()] = value;
	}
	return out;
}

/**
 * Secrets for one site: the kit-level `.env` (shared, e.g. the agency's Cloudflare token — see
 * docs/cloudflare-api-token.md) overlaid by `sites/<slug>/.env` (per-site values win). Both gitignored.
 */
export function loadSiteEnv(siteRoot: string, kitRoot = KIT_ROOT): Record<string, string> {
	return { ...loadEnv(join(kitRoot, ".env")), ...loadEnv(join(siteRoot, ".env")) };
}

export interface WpCredentials {
	/** Site URL the credentials belong to (from the migration key), if known. */
	url?: string;
	user: string;
	/** Application password, spaces removed. */
	password: string;
	source: "migration-key" | "app-password";
}

/**
 * EmDash Exporter migration key: `em1.` + base64url(JSON {v, url, user, pass}).
 * Format observed on exporter 1.2.0 (see docs/spikes/M3-findings.md).
 */
export function parseMigrationKey(key: string): { url: string; user: string; pass: string } {
	const trimmed = key.trim();
	if (!trimmed.startsWith("em1.")) throw new Error("Migration key must start with 'em1.'");
	let data: unknown;
	try {
		data = JSON.parse(Buffer.from(trimmed.slice(4), "base64url").toString("utf8"));
	} catch {
		throw new Error("Migration key is not valid base64url JSON");
	}
	const d = data as Record<string, unknown>;
	if (typeof d.url !== "string" || typeof d.user !== "string" || typeof d.pass !== "string") {
		throw new Error("Migration key is missing url/user/pass");
	}
	return { url: d.url, user: d.user, pass: d.pass };
}

/** Migration key first, then WP_APP_USER / WP_APP_PASSWORD. Returns undefined when neither is set. */
export function resolveCredentials(env: Record<string, string>): WpCredentials | undefined {
	if (env.EMDASH_WP_MIGRATION_KEY) {
		const k = parseMigrationKey(env.EMDASH_WP_MIGRATION_KEY);
		return { url: k.url, user: k.user, password: k.pass.replace(/\s/g, ""), source: "migration-key" };
	}
	if (env.WP_APP_USER && env.WP_APP_PASSWORD) {
		return { user: env.WP_APP_USER, password: env.WP_APP_PASSWORD.replace(/\s/g, ""), source: "app-password" };
	}
	return undefined;
}

/** Remove anything that looks like a credential from a message before it is logged. */
export function redact(message: string, creds?: WpCredentials): string {
	let m = message.replace(/em1\.[A-Za-z0-9_-]{10,}/g, "em1.[redacted]").replace(/Basic\s+[A-Za-z0-9+/=]{8,}/g, "Basic [redacted]");
	if (creds?.password) m = m.split(creds.password).join("[redacted]");
	return m;
}
