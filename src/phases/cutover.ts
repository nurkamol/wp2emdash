/**
 * Phase 7 — cutover, step 1: preflight (read-only). Nothing here changes Cloudflare, DNS or WordPress.
 *
 * Checks that everything the switch-over needs is in place and records the zone's DNS so the launch can prove it
 * stayed unchanged: the last verify passed (or was accepted), production resources and Worker secrets exist, the
 * production Turnstile key is set, the zone is on Cloudflare with proxied apex/www records and no Worker route in the
 * way (go-live token), and the canonical-host redirects behave. Writes sites/<slug>/cutover/runbook.md with the exact
 * launch and rollback commands. The traffic switch itself is a separate, owner-approved step (docs/PLAN.md §7a).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type GateCheck, phaseState, readState } from "../core/state.js";
import { credentialsFor } from "../commands/provision.js";
import { loadSiteEnv } from "../extract/credentials.js";
import type { PhaseContext } from "./index.js";

const API = "https://api.cloudflare.com/client/v4";
const readJson = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined);

interface CfResources {
	accountId?: string;
	production?: { d1?: { name: string; id: string }; r2?: { bucket: string }; worker?: { name?: string; url?: string } };
}
interface DnsRecord {
	id: string;
	type: string;
	name: string;
	content: string;
	proxied?: boolean;
	ttl: number;
	priority?: number;
}

async function cf<T>(token: string, path: string): Promise<{ ok: boolean; result?: T; error?: string }> {
	try {
		const res = await fetch(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
		const j = (await res.json()) as { success: boolean; result: T; errors?: { message: string }[] };
		return j.success ? { ok: true, result: j.result } : { ok: false, error: j.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}` };
	} catch (e) {
		return { ok: false, error: (e as Error).message };
	}
}

export async function runCutover({ config, paths, reporter }: PhaseContext): Promise<GateCheck[]> {
	const checks: GateCheck[] = [];
	const check = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id, label, ok, ...(detail ? { detail } : {}) });
	const env = loadSiteEnv(paths.root);
	const domain = new URL(config.target.productionUrl).host.replace(/^www\./, "");
	const apexFirst = config.target.canonicalHost === "apex";
	const cfRes = readJson<CfResources>(join(paths.root, "cloudflare.json")) ?? {};
	// Production may run in another account than staging (e.g. the client's own): its own token and account first.
	const prodCreds = credentialsFor("production", env, cfRes as Parameters<typeof credentialsFor>[2]);
	const accountId = prodCreds.accountId;
	const worker = cfRes.production?.worker?.name ?? config.slug.replace(/[^a-z0-9-]/g, "-");
	const outDir = join(paths.root, "cutover");
	mkdirSync(outDir, { recursive: true });
	reporter.emit({ type: "step:start", step: "Preflight" });

	// 1. The last verify run: every check passed (visual differences can be accepted by the owner, never by the kit).
	const verify = readJson<{ target: string; ranAt: string; checks?: GateCheck[] }>(join(paths.reports, "verify", "verify.json"));
	const failed = (verify?.checks ?? []).filter((c) => !c.ok);
	// The owner accepts with `wp2emdash accept <slug> verify --reason … --by …` (recorded in state.json, never by the kit).
	const verifyAccepted = existsSync(paths.state) && phaseState(readState(paths.state), "verify").status === "accepted";
	const open = verifyAccepted ? [] : failed;
	check("verify", "Last verify run passed (failures only if the owner accepted them)", !!verify?.checks && open.length === 0, !verify?.checks ? "Run verify against staging first" : open.length ? `${open.map((c) => c.id).join(", ")} failed on ${verify.target} (${verify.ranAt.slice(0, 10)})` : `${verify.checks.length} checks on ${verify.target}, ${verify.ranAt.slice(0, 10)}${failed.length ? `; failures accepted by the owner: ${failed.map((c) => c.id).join(", ")}` : ""}`);

	// 2. Production resources, separate from staging.
	const prod = cfRes.production;
	check("production-resources", "Production D1 and R2 created (separate from staging)", !!prod?.d1?.id && !!prod?.r2?.bucket, prod?.d1?.id ? `${prod.d1.name}, ${prod.r2?.bucket ?? "no bucket"}` : `Create with the build token: npx wrangler d1 create ${worker}-db --location <loc>; npx wrangler r2 bucket create ${worker}-media --location <loc>; record them in cloudflare.json → production`);

	// 3. Production Worker and its secrets (names only — values are never read).
	const token = prodCreds.token;
	const hasForms = existsSync(join(paths.project, "src", "forms"));
	// Outbox on hold (owner decision): messages wait in KV, so no email key is needed until it is released.
	const held = !!config.forms.outbox?.hold;
	// EMAIL_PROVIDER=emdash sends through EmDash's Settings → Email (credentials stored there): no API key secret.
	const needKey = !held && config.email.provider !== "emdash";
	const needSecrets = ["EMDASH_ENCRYPTION_KEY", ...(hasForms ? [...(needKey ? ["EMAIL_API_KEY"] : []), "TURNSTILE_SECRET_KEY"] : [])];
	if (!token || !accountId) check("production-secrets", "Production Worker deployed with its secrets", false, "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID missing from .env");
	else {
		const s = await cf<{ name: string }[]>(token, `/accounts/${accountId}/workers/scripts/${worker}/secrets`);
		const have = new Set((s.result ?? []).map((x) => x.name));
		const missing = needSecrets.filter((n) => !have.has(n));
		check("production-secrets", "Production Worker deployed with its secrets", s.ok && missing.length === 0, !s.ok ? `Worker "${worker}" not deployed yet (${s.error}). Deploy production to workers.dev first: pnpm deploy:production` : missing.length ? `missing: ${missing.join(", ")} (npx wrangler secret put <NAME>)` : `${needSecrets.join(", ")}${held && hasForms ? "; form email held in the outbox (no EMAIL_API_KEY yet)" : ""}`);
	}

	// 4. Forms: a real Turnstile widget for production (staging uses the always-pass test key).
	if (existsSync(join(paths.project, "src", "forms"))) check("turnstile", "Production Turnstile site key set", !!config.forms.turnstileSiteKey, config.forms.turnstileSiteKey ? undefined : `Create a Turnstile widget for ${domain} and set forms.turnstileSiteKey in kit.config; its secret: npx wrangler secret put TURNSTILE_SECRET_KEY`);

	// 5. Zone and DNS (go-live token, zone-scoped, created per launch: docs/cloudflare-api-token.md).
	const golive = env.CLOUDFLARE_GOLIVE_TOKEN;
	let zoneId: string | undefined;
	let records: DnsRecord[] = [];
	if (!golive) check("zone", `Zone ${domain} on Cloudflare (go-live token)`, false, "Create the go-live token (docs/cloudflare-api-token.md, token B) and set CLOUDFLARE_GOLIVE_TOKEN in sites/<slug>/.env");
	else {
		const z = await cf<{ id: string; status: string; name: string; account?: { id: string; name?: string } }[]>(golive, `/zones?name=${domain}`);
		const zone = z.result?.[0];
		zoneId = zone?.id;
		check("zone", `Zone ${domain} on Cloudflare (go-live token)`, !!zone && zone.status === "active", zone ? `status ${zone.status}` : (z.error ?? "zone not visible to the go-live token"));
		// Worker routes only reach a Worker in the zone's own account.
		if (zone?.account?.id) check("same-account", "Production Worker in the domain's Cloudflare account", zone.account.id === accountId, zone.account.id === accountId ? `${zone.account.name ?? zone.account.id}` : `The domain is in "${zone.account.name ?? zone.account.id}", production in ${accountId ?? "no account"}: provision production there (pnpm wp2emdash provision <slug> production with CLOUDFLARE_API_TOKEN_PRODUCTION / CLOUDFLARE_ACCOUNT_ID_PRODUCTION), deploy, load, verify.`);
		if (zoneId) {
			const r = await cf<DnsRecord[]>(golive, `/zones/${zoneId}/dns_records?per_page=500`);
			records = r.result ?? [];
			// The record the Worker route sits in front of must stay proxied (orange cloud), or traffic bypasses the route.
			const web = records.filter((x) => (x.name === domain || x.name === `www.${domain}`) && ["A", "AAAA", "CNAME"].includes(x.type));
			const unproxied = web.filter((x) => !x.proxied);
			const hosts = new Set(web.map((x) => x.name));
			const both = hosts.has(domain) && hosts.has(`www.${domain}`);
			check("dns-proxied", "Apex and www records exist and are proxied", r.ok && both && unproxied.length === 0, !r.ok ? r.error : !both ? `found ${[...hosts].join(", ") || "none"}; need apex and www` : unproxied.length ? `not proxied: ${unproxied.map((x) => `${x.name} ${x.type}`).join(", ")}` : `${web.length} records, all proxied`);
			// Snapshot: everything except the web records (mail, verification, CAA…) must be identical after launch.
			const keep = records.filter((x) => !web.includes(x)).map(({ type, name, content, ttl, priority, proxied }) => ({ type, name, content, ttl, ...(priority !== undefined ? { priority } : {}), ...(proxied !== undefined ? { proxied } : {}) }));
			writeFileSync(join(outDir, "dns-before.json"), `${JSON.stringify({ zone: domain, at: new Date().toISOString(), web: web.map(({ type, name, content, proxied }) => ({ type, name, content, proxied })), keep }, null, 2)}\n`);
			const mail = keep.filter((x) => x.type === "MX" || /v=spf1|v=DMARC1|DKIM/i.test(x.content) || /_domainkey|_dmarc/.test(x.name));
			check("dns-snapshot", "Mail and verification records recorded (must stay unchanged)", r.ok, `${keep.length} records in cutover/dns-before.json (${mail.length} mail-related)`);
			const routes = await cf<{ id: string; pattern: string; script?: string }[]>(golive, `/zones/${zoneId}/workers/routes`);
			const clash = (routes.result ?? []).filter((x) => x.pattern.includes(domain) && x.script !== worker);
			check("routes-free", "No other Worker route on the domain", routes.ok && clash.length === 0, !routes.ok ? routes.error : clash.length ? clash.map((x) => `${x.pattern} → ${x.script ?? "(none)"}`).join(", ") : `${(routes.result ?? []).length} existing route(s)`);
		}
	}

	// 6. Canonical host and https on the live site (the Worker keeps the same rules after launch).
	const canonical = apexFirst ? `https://${domain}/` : `https://www.${domain}/`;
	const other = apexFirst ? `https://www.${domain}/` : `https://${domain}/`;
	const probes = await Promise.all([other, `http://${domain}/`].map(async (u) => {
		try {
			const res = await fetch(u, { redirect: "manual" });
			await res.body?.cancel();
			return { u, status: res.status, to: res.headers.get("location") ?? "" };
		} catch (e) {
			return { u, status: 0, to: (e as Error).message };
		}
	}));
	const badHost = probes.filter((p) => !(p.status >= 300 && p.status < 400 && p.to.startsWith(canonical.replace(/\/$/, ""))));
	check("canonical-host", `Live site sends ${other.replace(/\/$/, "")} and http to ${canonical}`, badHost.length === 0, badHost.map((p) => `${p.u} → ${p.status} ${p.to}`).join("; ") || "301s in place (keep them: Cloudflare redirect rules or the Worker)");

	writeFileSync(join(outDir, "runbook.md"), runbook({ domain, worker, zoneId, apexFirst, accountId }));
	reporter.emit({ type: "step:end", step: "Preflight", ok: checks.every((c) => c.ok), detail: `runbook: ${join(outDir, "runbook.md")}` });
	return checks;
}

/** Exact launch and rollback commands for the route method. Ids are filled in when the go-live token could read the zone. */
export function runbook(o: { domain: string; worker: string; zoneId?: string; apexFirst: boolean; accountId?: string }): string {
	const zone = o.zoneId ?? "<zone id>";
	return `# Launch runbook — ${o.domain}

Generated by \`wp2emdash run <slug> cutover\` (preflight). Method: Worker routes in front of the existing proxied
WordPress records (docs/PLAN.md §7a). Nothing in this file has been run. Each step needs the owner's go-ahead.

Token: the go-live token (zone-scoped, Workers Routes edit) — \`CLOUDFLARE_GOLIVE_TOKEN\` in the site's \`.env\`.

\`\`\`bash
set -a && . ./.env && set +a      # in sites/<slug>/
ZONE=${zone}
\`\`\`

## 0. The day before

- Content freeze on WordPress; rerun \`extract → transform → load\` against **production** and \`verify\`.
- Production Worker deployed and smoke-tested on its workers.dev address (\`pnpm deploy:production\`).
- Production settings in the admin: site title, SEO, email; editors invited.

## 1. Switch (seconds, no DNS change)

\`\`\`bash
for host in ${o.domain} www.${o.domain}; do
  curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ZONE/workers/routes" \\
    -H "Authorization: Bearer $CLOUDFLARE_GOLIVE_TOKEN" -H "Content-Type: application/json" \\
    --data "{\\"pattern\\":\\"$host/*\\",\\"script\\":\\"${o.worker}\\"}"
done
\`\`\`

Then: \`WP2EMDASH_TARGET=production pnpm wp2emdash run <slug> verify --preview\` (URLs, SEO, forms, redirects,
analytics loading), submit \`https://${o.domain}/sitemap.xml\` in Search Console, send a test form.

## 2. Rollback (any time during monitoring)

\`\`\`bash
curl -sS "https://api.cloudflare.com/client/v4/zones/$ZONE/workers/routes" -H "Authorization: Bearer $CLOUDFLARE_GOLIVE_TOKEN" \\
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const r of JSON.parse(s).result)if(r.script==="${o.worker}")console.log(r.id)})' \\
  | while read id; do curl -sS -X DELETE "https://api.cloudflare.com/client/v4/zones/$ZONE/workers/routes/$id" -H "Authorization: Bearer $CLOUDFLARE_GOLIVE_TOKEN"; done
\`\`\`

The proxied records still point at WordPress, so traffic returns to it immediately. List any content edited in
EmDash after launch so it can be copied back if the rollback lasts.

## 3. After launch

- Compare DNS with \`cutover/dns-before.json\` (mail, SPF, DKIM, DMARC, verification TXT unchanged).
- Watch the 404 log in the admin (Redirects) and add redirects; check form deliveries and Worker errors daily.
- After the monitoring window and the owner's approval: optionally replace the routes with a Worker Custom Domain
  (removes the WordPress record), then retire WordPress after the agreed keep period, keeping the final backup.
`;
}
