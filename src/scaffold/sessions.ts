/**
 * Astro sessions (EmDash admin sign-in) for the generated project — kit.config `sessions`, default R2.
 * Verified against Astro 7.4.12, @astrojs/cloudflare 14.4.8, unstorage 1.17.6, Wrangler 4.163, EmDash 1.5.0:
 * docs/spikes/sessions-findings.md.
 *
 * - R2: `session.driver` = unstorage's cloudflare-r2-binding on the `SESSIONS` bucket binding, and the adapter's
 *   `sessionKVBindingName: "SESSIONS"`. The adapter injects `env[sessionKVBindingName]` as the driver's `binding`
 *   option on every request (utils/cf.js injectSessionBinding); without it the driver looks the name up on
 *   globalThis, which holds no bindings in a module Worker, and every session read fails (= nobody can sign in).
 *   A non-KV driver also stops the adapter from adding a bare SESSION KV binding.
 * - The R2 driver is used only when every environment the build serves has its bucket recorded in cloudflare.json:
 *   one astro.config serves all environments, and a build without the binding could not sign anyone in. Otherwise
 *   KV, as before (the explicitly bound SESSION namespace), with a warning.
 */
export type Env = "staging" | "production";
export interface SessionsConfig {
	store: "r2" | "kv";
	days: number;
}
/** Binding name of the sessions bucket in wrangler.jsonc (and the adapter's sessionKVBindingName). */
export const SESSIONS_BINDING = "SESSIONS";

/** The store the generated project uses, and the environments that keep it on KV for now (bucket not provisioned). */
export function sessionStore(sessions: SessionsConfig, cf: Partial<Record<Env, { sessions?: { bucket?: string } }>>, envs: Env[]): { store: "r2" | "kv"; missing: Env[] } {
	if (sessions.store === "kv") return { store: "kv", missing: [] };
	const missing = envs.filter((e) => !cf[e]?.sessions?.bucket);
	return { store: missing.length ? "kv" : "r2", missing };
}

/** astro.config.mjs: the adapter call and the `session` option. KV: the adapter's default, unchanged. */
export function astroSessions(store: "r2" | "kv", days: number): { adapter: string; options: string } {
	if (store === "kv") return { adapter: "cloudflare()", options: "" };
	return {
		adapter: `cloudflare({ sessionKVBindingName: ${JSON.stringify(SESSIONS_BINDING)} })`,
		options: `\t// Sign-in sessions in a private R2 bucket (strongly consistent; Workers KV's edge-cached reads logged editors out at
	// random). The adapter injects the ${SESSIONS_BINDING} binding (sessionKVBindingName only names it). ttl = the bucket's
	// lifecycle rule (${days} days, kit.config sessions.days): editors sign in again after ${days} days.
	session: { driver: sessionDrivers.cloudflareR2Binding({ binding: ${JSON.stringify(SESSIONS_BINDING)} }), ttl: ${days * 86400} },
`,
	};
}

/** wrangler.jsonc r2_buckets entry for the sessions bucket of one environment (undefined when not recorded). */
export function sessionsBucketBinding(cf: Partial<Record<Env, { sessions?: { bucket?: string } }>>, e: Env): { binding: string; bucket_name: string } | undefined {
	const bucket = cf[e]?.sessions?.bucket;
	return bucket ? { binding: SESSIONS_BINDING, bucket_name: bucket } : undefined;
}
