/**
 * Secrets form (docs/PLAN.md §10b): writes one allow-listed key at a time to `sites/<slug>/.env`.
 *
 * - Write-only: values are never returned, logged or streamed. The dashboard only learns "set / not set" and a short
 *   fingerprint (first 8 hex of sha256), enough to tell two values apart without revealing either.
 * - Only the keys in SECRET_KEYS; a format check where the format is known; CR/LF and other control characters refused,
 *   so a value can never add a line to the file.
 * - Every other line (comments, blank lines, other keys) is kept as it was; duplicates of the key are folded into one.
 * - The file is written atomically and stays mode 600; a symlinked .env is refused.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SITES_DIR, sitePaths } from "../core/paths.js";
import { phaseState, readState } from "../core/state.js";
import { loadEnv, parseMigrationKey } from "../extract/credentials.js";
import { UserError } from "./data.js";

export interface SecretSpec {
	key: string;
	label: string;
	help: string;
	group: "wordpress" | "emdash" | "email" | "production" | "go-live";
	/** Human description of the accepted format, when one is checked. */
	format?: string;
	check?: (v: string) => boolean;
}

const ENC = /^emdash_enc_v1_[A-Za-z0-9_-]{43}$/;
// Turnstile keys start with 0x (real) or 1x/2x/3x (Cloudflare's documented dummy test keys).
const TURNSTILE = /^[0-3]x[A-Za-z0-9_-]{10,}$/;

export const SECRET_KEYS: SecretSpec[] = [
	{
		key: "EMDASH_WP_MIGRATION_KEY",
		label: "EmDash Exporter migration key",
		help: "From the EmDash Exporter plugin in WordPress admin. Used by extract (GET only).",
		group: "wordpress",
		format: "em1.<base64url JSON with url, user, pass>",
		check: (v) => {
			try {
				parseMigrationKey(v);
				return true;
			} catch {
				return false;
			}
		},
	},
	{ key: "WP_APP_USER", label: "WordPress user (application password)", help: "The dedicated WordPress user the application password belongs to.", group: "wordpress", format: "a WordPress user name (no spaces at the ends)", check: (v) => v.length <= 120 && !/^\s|\s$/.test(v) },
	{
		key: "WP_APP_PASSWORD",
		label: "WordPress application password",
		help: "Users → Profile → Application Passwords. Revoke it once the import is done.",
		group: "wordpress",
		format: "24 letters and digits, optionally in groups of 4 separated by spaces",
		check: (v) => /^[A-Za-z0-9]{4}(?: ?[A-Za-z0-9]{4}){5}$/.test(v),
	},
	{ key: "EMDASH_TOKEN", label: "EmDash API token (staging, or the only site)", help: "EmDash admin → API tokens, with the load scopes. Opt-in staging: the staging token. Single-environment site: accepted for production when EMDASH_TOKEN_PRODUCTION is not set.", group: "emdash" },
	{ key: "EMDASH_TOKEN_PRODUCTION", label: "EmDash API token (production)", help: "Same scopes, created in the production admin. Used by load and verify against production (the default target of a single-environment site).", group: "emdash" },
	{ key: "EMDASH_ENCRYPTION_KEY_STAGING", label: "EmDash encryption key (staging)", help: "Encrypts stored plugin secrets on staging. Keep a copy in the password manager.", group: "emdash", format: "emdash_enc_v1_ + 43 base64url characters", check: (v) => ENC.test(v) },
	{ key: "EMDASH_ENCRYPTION_KEY_PRODUCTION", label: "EmDash encryption key (production)", help: "Separate from staging. Keep a copy in the password manager.", group: "production", format: "emdash_enc_v1_ + 43 base64url characters", check: (v) => ENC.test(v) },
	{ key: "EMAIL_API_KEY", label: "Email provider API key", help: "The provider set in kit.config.ts (email.provider). Form messages wait in the outbox until it is set.", group: "email" },
	{ key: "TURNSTILE_SITE_KEY_PRODUCTION", label: "Turnstile site key (production)", help: "Cloudflare Turnstile widget for the production domain.", group: "production", format: "starts with 0x", check: (v) => TURNSTILE.test(v) },
	{ key: "TURNSTILE_SECRET_KEY_PRODUCTION", label: "Turnstile secret key (production)", help: "The same widget's secret key.", group: "production", format: "starts with 0x", check: (v) => TURNSTILE.test(v) },
	{ key: "CF_ANALYTICS_TOKEN", label: "Cloudflare Web Analytics read token", help: "For the admin's Visits widget (SEO & Analytics, @wp2emdash/seo): a custom token with only Account → Account Analytics → Read on the account that holds the site. Set it on the Worker from the Environment view.", group: "production", format: "40 or more letters, digits, - or _", check: (v) => /^[A-Za-z0-9_-]{40,}$/.test(v) },
	{ key: "CRUX_API_KEY", label: "Google Chrome UX Report API key (optional)", help: "For Site health (@wp2emdash/health): real-visitor Core Web Vitals in the admin and the monthly report. A free Google Cloud API key with the Chrome UX Report API enabled (restrict it to that API). Optional: without it the speed check uses the page build time only. Set it on the Worker from the Environment view.", group: "production", format: "AIza + 35 letters, digits, - or _", check: (v) => /^AIza[0-9A-Za-z_-]{35}$/.test(v) },
	{ key: "CF_ZONE_READ_TOKEN", label: "Cloudflare zone read token for certificate expiry (optional)", help: "For Site health: lets the Worker read the domain's certificate expiry. A custom token with only Zone → Zone → Read and Zone → SSL and Certificates → Read, on this zone. Optional: Cloudflare renews the certificate on its own. Not the go-live token. Set it on the Worker from the Environment view.", group: "production", format: "40 or more letters, digits, - or _", check: (v) => /^[A-Za-z0-9_-]{40,}$/.test(v) },
	{ key: "CLOUDFLARE_API_TOKEN_PRODUCTION", label: "Cloudflare API token (production account)", help: "Only when production runs in another Cloudflare account than staging (docs/cloudflare-api-token.md).", group: "production", format: "40 or more letters, digits, - or _", check: (v) => /^[A-Za-z0-9_-]{40,}$/.test(v) },
	{ key: "CLOUDFLARE_ACCOUNT_ID_PRODUCTION", label: "Cloudflare account id (production)", help: "Dashboard → account home → Account ID.", group: "production", format: "32 hex characters", check: (v) => /^[0-9a-f]{32}$/.test(v) },
	{ key: "CLOUDFLARE_GOLIVE_TOKEN", label: "Cloudflare go-live token", help: "Zone-scoped token B for cutover only (docs/cloudflare-api-token.md). Revoke it after the monitoring window.", group: "go-live", format: "40 or more letters, digits, - or _", check: (v) => /^[A-Za-z0-9_-]{40,}$/.test(v) },
];

const SPEC = new Map(SECRET_KEYS.map((s) => [s.key, s]));
const MAX = 4096;

export const fingerprint = (value: string): string => createHash("sha256").update(value).digest("hex").slice(0, 8);

export interface SecretStatus {
	key: string;
	label: string;
	help: string;
	group: SecretSpec["group"];
	format?: string;
	set: boolean;
	fingerprint?: string;
}

export interface SecretsView {
	file: string;
	keys: SecretStatus[];
	reminders: string[];
}

/** Status of every allow-listed key in sites/<slug>/.env. Never contains a value. */
export function secretsStatus(slug: string, sitesDir = SITES_DIR): SecretsView {
	const paths = sitePaths(slug, sitesDir);
	const env = loadEnv(join(paths.root, ".env"));
	const keys = SECRET_KEYS.map((s) => {
		const v = env[s.key];
		return { key: s.key, label: s.label, help: s.help, group: s.group, ...(s.format ? { format: s.format } : {}), set: !!v, ...(v ? { fingerprint: fingerprint(v) } : {}) };
	});
	const reminders: string[] = [];
	let extracted = false;
	try {
		const st = phaseState(readState(paths.state), "extract").status;
		extracted = st === "passed" || st === "accepted";
	} catch {
		// no state yet
	}
	if (extracted && env.WP_APP_PASSWORD) reminders.push("The import (extract) has run: revoke the WordPress application password (Users → Profile → Application Passwords) once you no longer need to re-extract, and remove WP_APP_PASSWORD from .env.");
	if (extracted && env.EMDASH_WP_MIGRATION_KEY) reminders.push("Revoke the EmDash Exporter migration key in WordPress once the final (cutover) extract is done.");
	if (env.CLOUDFLARE_GOLIVE_TOKEN) reminders.push("The go-live token is for cutover only: revoke it in Cloudflare after the monitoring window.");
	return { file: `sites/${slug}/.env`, keys, reminders };
}

/** Quote a value for a dotenv line that both loadEnv() and `set -a; . ./.env` read back unchanged. */
function encode(value: string): string {
	if (/^[A-Za-z0-9_\-.:/+=@,]+$/.test(value)) return value;
	if (!value.includes("'")) return `'${value}'`;
	throw new UserError("This value contains a single quote, which the site .env cannot hold safely. Store it as a Wrangler secret instead.");
}

/**
 * Create or replace one key in sites/<slug>/.env. Returns only the new status (set + fingerprint).
 * Error messages never include the value.
 */
export function writeSecret(slug: string, input: { key?: unknown; value?: unknown }, sitesDir = SITES_DIR): { key: string; set: true; fingerprint: string } {
	const key = typeof input.key === "string" ? input.key : "";
	const spec = SPEC.get(key);
	if (!spec) throw new UserError("Unknown key: only the listed keys can be set from the dashboard.");
	if (typeof input.value !== "string") throw new UserError("Value missing.");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
	if (/[\r\n]/.test(input.value) || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(input.value)) throw new UserError("Line breaks and control characters are not allowed in a value.");
	const value = input.value.trim();
	if (!value) throw new UserError("Value is empty.");
	if (value.length > MAX) throw new UserError("Value is too long.");
	if (spec.check && !spec.check(value)) throw new UserError(`${spec.key} does not look right: expected ${spec.format ?? "a different format"}.`);
	const line = `${spec.key}=${encode(value)}`;

	const file = join(sitePaths(slug, sitesDir).root, ".env");
	let text = "";
	if (existsSync(file) || isLink(file)) {
		if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) throw new UserError("sites/<slug>/.env is not a regular file; refusing to write.");
		text = readFileSync(file, "utf8");
	}
	const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
	const re = new RegExp(`^\\s*(?:export\\s+)?${spec.key}\\s*=`);
	const out: string[] = [];
	let placed = false;
	for (const l of lines) {
		if (re.test(l)) {
			if (!placed) out.push(line);
			placed = true;
		} else out.push(l);
	}
	if (!placed) out.push(line);

	const tmp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		writeFileSync(tmp, `${out.join("\n")}\n`, { mode: 0o600, flag: "wx" });
		chmodSync(tmp, 0o600);
		renameSync(tmp, file);
	} catch (e) {
		try {
			unlinkSync(tmp);
		} catch {
			// already gone
		}
		throw new Error(`Could not write .env: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
	}
	chmodSync(file, 0o600);
	return { key: spec.key, set: true, fingerprint: fingerprint(value) };
}

function isLink(file: string): boolean {
	try {
		return lstatSync(file).isSymbolicLink();
	} catch {
		return false;
	}
}
