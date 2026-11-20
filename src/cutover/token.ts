/**
 * Go-live token hygiene (cutover preflight). The go-live token (CLOUDFLARE_GOLIVE_TOKEN) must be a separate token,
 * scoped to the site's own zones: a launch should never be done with the reusable build token, nor with a token that
 * can reach other clients' domains. Token values are only ever compared as SHA-256 hashes and never printed.
 */
import { createHash } from "node:crypto";
import type { GateCheck } from "../core/state.js";

const API = "https://api.cloudflare.com/client/v4";
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const sha = (v: string) => createHash("sha256").update(v.trim()).digest("hex");

/** Names of the build tokens the go-live token must differ from (only names are reported, never values). */
export const BUILD_TOKEN_VARS = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_API_TOKEN_PRODUCTION", "CLOUDFLARE_API_TOKEN_STAGING"] as const;

/** The variable names whose (non-empty) value is identical to the go-live token, compared by hash. */
export function sameAsBuildToken(golive: string, vars: Record<string, string | undefined>): string[] {
	const g = sha(golive);
	return BUILD_TOKEN_VARS.filter((n) => !!vars[n]?.trim() && sha(vars[n] as string) === g);
}

/**
 * Two checks:
 * - `golive-token-separate`: CLOUDFLARE_GOLIVE_TOKEN is not one of the build tokens.
 * - `golive-token-scope`: GET /zones sees only the primary zone and the alias zones. More means the token was created
 *   with "All zones" (or an account-wide include) and could change any of them.
 */
export async function goliveTokenChecks(o: { golive: string; vars: Record<string, string | undefined>; allowedZones: string[]; fetch?: FetchLike }): Promise<GateCheck[]> {
	const f = o.fetch ?? fetch;
	const checks: GateCheck[] = [];
	const same = sameAsBuildToken(o.golive, o.vars);
	checks.push({
		id: "golive-token-separate",
		label: "Go-live token is its own token (not the build token)",
		ok: same.length === 0,
		detail: same.length
			? `CLOUDFLARE_GOLIVE_TOKEN is identical to ${same.join(", ")} (compared by hash). Create a separate token: docs/cloudflare-api-token.md, token B (Zone Resources → Include → Specific zone).`
			: "differs from the build token(s) (compared by hash)",
	});
	const allowed = new Set(o.allowedZones.map((z) => z.toLowerCase().replace(/^www\./, "")));
	try {
		const names: string[] = [];
		let total = 0;
		for (let page = 1; page <= 20; page++) {
			const res = await f(`${API}/zones?per_page=50&page=${page}`, { headers: { authorization: `Bearer ${o.golive}` } });
			const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { name: string }[]; result_info?: { total_pages?: number; total_count?: number }; errors?: { message: string }[] };
			if (!j.success) throw new Error(j.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}`);
			names.push(...(j.result ?? []).map((z) => z.name.toLowerCase()));
			total = j.result_info?.total_count ?? names.length;
			if (page >= (j.result_info?.total_pages ?? 1)) break;
		}
		const extra = Math.max(total - names.filter((n) => allowed.has(n)).length, names.filter((n) => !allowed.has(n)).length);
		checks.push({
			id: "golive-token-scope",
			label: "Go-live token reaches only this site's zones",
			ok: extra === 0,
			detail: extra
				? `The token can read ${extra} other zone${extra === 1 ? "" : "s"} besides ${[...allowed].join(", ")}. Edit it in the dashboard (My Profile → API Tokens) and set Zone Resources to Include → Specific zone → ${[...allowed].join(", ")} only (docs/cloudflare-api-token.md, token B).`
				: `${names.length} zone${names.length === 1 ? "" : "s"} visible, all of them this site's`,
		});
	} catch (e) {
		checks.push({ id: "golive-token-scope", label: "Go-live token reaches only this site's zones", ok: false, detail: `could not list zones: ${(e as Error).message}` });
	}
	return checks;
}
