/**
 * Alias domains (`target.aliasDomains`): other domains that become a permanent, path-preserving 301 to the primary.
 *
 * - `aliasPreflight`: read-only (go-live token): zone visible and active, DNS snapshot with mail records flagged, apex
 *   and www proxied, existing Single Redirect rules listed. Never writes to Cloudflare.
 * - `aliasRunbook`: the exact Single Redirect API calls (create one rule per alias, verify, rollback by rule id),
 *   Search Console Change of Address and the off-site checklist. Nothing in it is run by the kit.
 * - `checkAliasRedirects`: after the switch, every audited path on each alias (apex and www) must answer 301 to the
 *   same path on the primary, without following redirects.
 *
 * Cloudflare API calls verified against developers.cloudflare.com on 2026-11-20: docs/cloudflare-api-token.md.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateCheck } from "../core/state.js";

const API = "https://api.cloudflare.com/client/v4";
export const REDIRECT_PHASE = "http_request_dynamic_redirect";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DnsRecord {
	id: string;
	type: string;
	name: string;
	content: string;
	proxied?: boolean;
	ttl: number;
	priority?: number;
}

export interface RedirectRule {
	id?: string;
	ref?: string;
	description?: string;
	expression: string;
	action?: string;
	enabled?: boolean;
	action_parameters?: unknown;
}

export interface AliasPlan {
	alias: string;
	zoneId?: string;
	/** Id of the zone's http_request_dynamic_redirect entry point ruleset, when it already exists. */
	rulesetId?: string;
	/** False when the entry point could not be read (then the runbook shows both ways to add the rule). */
	rulesetKnown: boolean;
	existingRules: RedirectRule[];
	/** The kit's rule for this alias, when it was already added. */
	ours?: RedirectRule;
	/** Web hostnames (apex, www) without any A/AAAA/CNAME record. */
	missingWeb: string[];
	/** Web records that exist but are DNS-only (grey cloud): a redirect rule never sees their traffic. */
	unproxied: string[];
	mailRecords: number;
}

async function cfGet<T>(fetchImpl: FetchLike, token: string, path: string): Promise<{ ok: boolean; status: number; result?: T; error?: string }> {
	try {
		const res = await fetchImpl(`${API}${path}`, { headers: { authorization: `Bearer ${token}` } });
		const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { message: string }[] };
		return j.success ? { ok: true, status: res.status, result: j.result as T } : { ok: false, status: res.status, error: j.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}` };
	} catch (e) {
		return { ok: false, status: 0, error: (e as Error).message };
	}
}

/** The host every alias redirects to: the production domain in its canonical form (no second hop). */
export function primaryHost(productionUrl: string, canonicalHost: "apex" | "www"): string {
	const bare = new URL(productionUrl).hostname.replace(/^www\./, "");
	return canonicalHost === "www" ? `www.${bare}` : bare;
}

/**
 * Records that carry email (Microsoft 365 / any provider) or identity: MX, SPF, DKIM, DMARC, autodiscover and the
 * Microsoft 365 client records. They must stay exactly as they are; the alias switch changes no DNS at all.
 */
export function isMailRecord(r: Pick<DnsRecord, "type" | "name" | "content">, zone: string): boolean {
	const label = r.name.toLowerCase() === zone ? "@" : r.name.toLowerCase().replace(new RegExp(`\\.${zone.replace(/\./g, "\\.")}$`), "");
	if (r.type === "MX") return true;
	if (r.type === "TXT" && /v=spf1|v=DMARC1|v=DKIM1/i.test(r.content)) return true;
	if (/(^|\.)_domainkey$|^_dmarc$|_domainkey\./.test(label)) return true;
	if (/^(autodiscover|_autodiscover\._tcp|lyncdiscover|sip|_sip\._tls|_sipfederationtls\._tcp|enterpriseregistration|enterpriseenrollment|msoid)$/.test(label)) return true;
	if (r.type === "SRV" && /autodiscover|_sip/.test(label)) return true;
	return false;
}

const WEB_TYPES = ["A", "AAAA", "CNAME"];

/** Read-only checks for one alias zone; writes cutover/dns-before.<alias>.json. */
export async function aliasPreflight(alias: string, o: { token: string; primary: string; outDir: string; fetch?: FetchLike }): Promise<{ checks: GateCheck[]; plan: AliasPlan }> {
	const f = o.fetch ?? fetch;
	const checks: GateCheck[] = [];
	const check = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id: `${id}:${alias}`, label, ok, ...(detail ? { detail } : {}) });
	const plan: AliasPlan = { alias, rulesetKnown: false, existingRules: [], missingWeb: [], unproxied: [], mailRecords: 0 };
	if (alias === o.primary.replace(/^www\./, "")) {
		check("alias-zone", `Alias ${alias} differs from the primary domain`, false, "target.aliasDomains lists the production domain itself");
		return { checks, plan };
	}
	const z = await cfGet<{ id: string; status: string; name: string }[]>(f, o.token, `/zones?name=${encodeURIComponent(alias)}`);
	const zone = z.result?.[0];
	plan.zoneId = zone?.id;
	check("alias-zone", `Alias zone ${alias} on Cloudflare and active (go-live token)`, !!zone && zone.status === "active", zone ? `status ${zone.status}` : (z.error ?? "zone not visible to the go-live token: add it under Zone Resources (docs/cloudflare-api-token.md)"));
	if (!zone) return { checks, plan };

	// DNS: snapshot everything; the switch must leave every record as it is.
	const r = await cfGet<DnsRecord[]>(f, o.token, `/zones/${zone.id}/dns_records?per_page=500`);
	const records = r.result ?? [];
	const web = records.filter((x) => WEB_TYPES.includes(x.type) && (x.name === alias || x.name === `www.${alias}` || x.name === `*.${alias}`));
	for (const host of [alias, `www.${alias}`]) {
		const own = web.filter((x) => x.name === host);
		const covering = own.length ? own : host.startsWith("www.") ? web.filter((x) => x.name === `*.${alias}`) : [];
		if (!covering.length) plan.missingWeb.push(host);
		else if (!covering.some((x) => x.proxied)) plan.unproxied.push(...covering.map((x) => `${x.name} ${x.type}`));
	}
	const mail = records.filter((x) => isMailRecord(x, alias));
	plan.mailRecords = mail.length;
	if (r.ok) {
		mkdirSync(o.outDir, { recursive: true });
		const snap = records.map(({ type, name, content, ttl, priority, proxied }) => ({ type, name, content, ttl, ...(priority !== undefined ? { priority } : {}), ...(proxied !== undefined ? { proxied } : {}), ...(isMailRecord({ type, name, content }, alias) ? { mail: true } : {}) }));
		writeFileSync(join(o.outDir, `dns-before.${alias}.json`), `${JSON.stringify({ zone: alias, at: new Date().toISOString(), note: "Mail records (mail: true) must stay untouched; the alias switch changes no DNS.", records: snap }, null, 2)}\n`);
	}
	check(
		"alias-dns-proxied",
		`${alias}: apex and www records exist and are proxied (a redirect rule only sees proxied traffic)`,
		r.ok && !plan.missingWeb.length && !plan.unproxied.length,
		!r.ok ? r.error : [plan.missingWeb.length ? `missing: ${plan.missingWeb.join(", ")} (runbook: proxied placeholder)` : "", plan.unproxied.length ? `DNS only: ${plan.unproxied.join(", ")} (runbook: turn the proxy on)` : ""].filter(Boolean).join("; ") || `${web.length} web records, proxied`,
	);
	const types = [...new Set(mail.map((x) => (x.type === "MX" ? "MX" : /v=spf1/i.test(x.content) ? "SPF" : /_dmarc/.test(x.name) ? "DMARC" : /_domainkey/.test(x.name) ? "DKIM" : /autodiscover/.test(x.name) ? "autodiscover" : x.type)))];
	check("alias-dns-snapshot", `${alias}: DNS recorded, mail records flagged (they stay untouched)`, r.ok, r.ok ? `${records.length} records in cutover/dns-before.${alias}.json; ${mail.length} mail-related (${types.join(", ") || "none"})${mail.some((x) => x.type === "MX") ? "" : " — no MX record found"}` : r.error);

	// Existing Single Redirect rules (entry point ruleset of the dynamic redirect phase; 404 = none yet).
	const e = await cfGet<{ id: string; rules?: RedirectRule[] }>(f, o.token, `/zones/${zone.id}/rulesets/phases/${REDIRECT_PHASE}/entrypoint`);
	if (e.ok) {
		plan.rulesetKnown = true;
		plan.rulesetId = e.result?.id;
		plan.existingRules = e.result?.rules ?? [];
		plan.ours = plan.existingRules.find((x) => x.ref === ruleRef(alias));
	} else if (e.status === 404) plan.rulesetKnown = true;
	const listed = plan.existingRules.map((x) => `${x.enabled === false ? "(off) " : ""}${x.description ?? x.ref ?? x.id}: ${x.expression}`);
	check(
		"alias-redirect-rules",
		`${alias}: existing redirect rules read`,
		plan.rulesetKnown,
		!plan.rulesetKnown ? `${e.error} — the go-live token needs Zone → Single Redirect → Read on ${alias}` : plan.ours ? `the kit's rule is already in place (id ${plan.ours.id})` : listed.length ? `${listed.length} existing: ${listed.join(" · ")}` : "none yet",
	);
	return { checks, plan };
}

export const ruleRef = (alias: string) => `wp2emdash_alias_${alias.replace(/[^a-z0-9]+/gi, "_")}`;

/** One Single Redirect rule: alias apex + www → https://<primary><same path>, query string kept, 301. */
export function redirectRule(alias: string, primary: string): Required<Pick<RedirectRule, "ref" | "description" | "expression" | "action" | "enabled">> & { action_parameters: unknown } {
	return {
		ref: ruleRef(alias),
		description: `wp2emdash: ${alias} and www → ${primary} (301, path and query kept)`,
		expression: `(http.host in {"${alias}" "www.${alias}"})`,
		action: "redirect",
		action_parameters: {
			from_value: {
				status_code: 301,
				target_url: { expression: `concat("https://${primary}", http.request.uri.path)` },
				preserve_query_string: true,
			},
		},
		enabled: true,
	};
}

/** Runbook section for the alias domains (appended to cutover/runbook.md). Never changes DNS. */
export function aliasRunbook(plans: AliasPlan[], primary: string): string {
	if (!plans.length) return "";
	const L: string[] = [];
	L.push(`## 4. Alias domains → ${primary}`, "");
	L.push(
		`Each alias gets **one Single Redirect rule** in its own zone: apex and \`www\` answer \`301\` to the same path on`,
		`\`https://${primary}\`, query string kept. Do this **after** the primary is live and verified (section 1), one alias at`,
		"a time. No DNS record is created, changed or deleted: mail (MX, SPF, DKIM, DMARC, autodiscover) keeps working, and",
		"the alias's WordPress keeps running behind the rule, so deleting the rule restores it.",
		"",
		"Token: the go-live token, which must also include each alias zone with Zone → Zone → Read, Zone → DNS → Read and",
		"Zone → Single Redirect → Edit (docs/cloudflare-api-token.md). A 301 is cached by browsers: rollback stops new",
		"redirects at once, but visitors who already followed one may keep being sent to the primary until their cache clears.",
		"",
	);
	for (const p of plans) {
		const rule = redirectRule(p.alias, primary);
		const json = JSON.stringify(rule);
		const out = `cutover/alias-rule.${p.alias}.json`;
		L.push(`### ${p.alias}`, "");
		if (p.missingWeb.length || p.unproxied.length) {
			L.push("**Before the rule — proxied records.** A redirect rule only runs on traffic proxied through Cloudflare.");
			if (p.missingWeb.length)
				L.push(
					`Missing: ${p.missingWeb.map((h) => `\`${h}\``).join(", ")}. In the dashboard (${p.alias} → DNS → Records → Add record), add a proxied`,
					"placeholder per missing host: type `A`, name `@` (apex) or `www`, IPv4 `192.0.2.1` (reserved documentation",
					"address, never reached because the rule answers first), Proxy status **Proxied**. Owner approval first; the",
					"kit never adds it. Do not touch MX/TXT/CNAME mail records while there.",
				);
			if (p.unproxied.length) L.push(`DNS only (grey cloud): ${p.unproxied.map((h) => `\`${h}\``).join(", ")}. Turn the proxy on for these web records only (owner approval first); never for mail records.`);
			L.push("");
		}
		if (p.ours) L.push(`The kit's rule is already in place (id \`${p.ours.id}\`): skip to "Verify".`, "");
		if (p.existingRules.filter((x) => x !== p.ours).length)
			L.push("Existing redirect rules in this zone (they run in order; a rule above ours that matches the alias wins):", ...p.existingRules.filter((x) => x !== p.ours).map((x) => `- \`${x.id ?? "?"}\` ${x.enabled === false ? "(off) " : ""}${x.description ?? x.ref ?? ""} — \`${x.expression}\``), "");
		L.push("**Switch**", "", "```bash", `ALIAS_ZONE=${p.zoneId ?? "<zone id of " + p.alias + ">"}`, `RULE='${json}'`);
		const post = `curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$ALIAS_ZONE/rulesets/$RULESET/rules" \\\n  -H "Authorization: Bearer $CLOUDFLARE_GOLIVE_TOKEN" -H "Content-Type: application/json" --data "$RULE" | tee ${out}`;
		const put = `curl -sS -X PUT "https://api.cloudflare.com/client/v4/zones/$ALIAS_ZONE/rulesets/phases/${REDIRECT_PHASE}/entrypoint" \\\n  -H "Authorization: Bearer $CLOUDFLARE_GOLIVE_TOKEN" -H "Content-Type: application/json" --data "{\\"rules\\":[$RULE]}" | tee ${out}`;
		if (p.rulesetKnown && p.rulesetId) L.push(`RULESET=${p.rulesetId}   # existing entry point: add the rule, the other rules stay`, post);
		else if (p.rulesetKnown) L.push(`# No redirect rules in this zone yet: create the entry point with this one rule.`, put);
		else
			L.push(
				"# The preflight could not read the redirect rules. Check first:",
				`curl -sS "https://api.cloudflare.com/client/v4/zones/$ALIAS_ZONE/rulesets/phases/${REDIRECT_PHASE}/entrypoint" -H "Authorization: Bearer $CLOUDFLARE_GOLIVE_TOKEN"`,
				"# a) it exists: RULESET=<its id>, then add the rule (other rules stay):",
				post,
				"# b) 404: create the entry point with this one rule (PUT replaces the rule list — only when none exists):",
				put,
			);
		L.push(
			"# Ruleset id and rule id of the new rule (keep them for rollback):",
			`node -e 'const r=require("./${out}").result;const x=r.rules.find(x=>x.ref==="${rule.ref}");console.log("RULESET="+r.id+" RULE_ID="+x.id)'`,
			"```",
			"",
			"**Verify** (no redirect followed; expect `301 https://" + primary + "/<same path>?<same query>`)",
			"",
			"```bash",
			`for host in ${p.alias} www.${p.alias}; do curl -sS -o /dev/null -w "%{http_code} %{redirect_url}\\n" "https://$host/some/page/?utm_source=test"; done`,
			"pnpm wp2emdash check-aliases <slug>     # every audited path, apex and www",
			"```",
			"",
			"**Rollback** (deletes only this rule; DNS and other rules untouched)",
			"",
			"```bash",
			`curl -sS -X DELETE "https://api.cloudflare.com/client/v4/zones/$ALIAS_ZONE/rulesets/$RULESET/rules/$RULE_ID" -H "Authorization: Bearer $CLOUDFLARE_GOLIVE_TOKEN"`,
			"```",
			"",
			`After: compare the zone's DNS with \`cutover/dns-before.${p.alias}.json\` (${p.mailRecords} mail records must be identical) and send a test email to and from an address @${p.alias}.`,
			"",
		);
	}
	L.push(
		"### Search Console — Change of Address (per alias)",
		"",
		`1. Both properties verified by the same owner: the alias (Domain property \`${plans[0]?.alias}\` or URL-prefix) and \`${primary}\`.`,
		"2. The 301s are live and `check-aliases` passes (Google checks that the alias homepage and sampled pages redirect).",
		`3. In the **alias** property: Settings → Change of address → pick \`${primary}\` → Validate & update.`,
		`4. Submit \`https://${primary}/sitemap.xml\` in the primary property (Sitemaps). Keep the alias property to watch its pages drop out.`,
		"5. Keep the redirect rules for at least 180 days (Google's minimum for a site move); in practice, for as long as the domain is owned.",
		"6. Bing Webmaster Tools: Configure My Site → Site Move, same idea.",
		"",
		"### Off-site checklist (per alias)",
		"",
		`- [ ] Google Business Profile: website (and appointment link) → \`https://${primary}/…\``,
		"- [ ] Social profiles (Facebook, Instagram, LinkedIn, YouTube, TikTok…): website links",
		"- [ ] Booking / scheduling / payment providers: return URLs, widget allowed domains, email templates with links",
		"- [ ] Ads (Google Ads, Meta): final URLs; analytics: the alias's GA4 stream / referral exclusions",
		"- [ ] Directories, citations, partner sites, email signatures, printed QR codes (they keep working through the 301; update when convenient)",
		"- [ ] Keep each alias domain **registered with auto-renew** and its zone on Cloudflare: the redirects and the domain's email depend on it",
		"- [ ] Keep the mail records untouched (Microsoft 365 or any provider): the switch changes no DNS",
		"",
	);
	return `${L.join("\n")}\n`;
}

export interface AliasProbe {
	url: string;
	status: number;
	location?: string;
	expected: string;
	ok: boolean;
	problem?: string;
}

export interface AliasCheckResult {
	ranAt: string;
	primary: string;
	aliases: string[];
	paths: number;
	checked: number;
	ok: boolean;
	failures: AliasProbe[];
	byHost: Record<string, { checked: number; ok: number }>;
}

/** Classifies one response against the expected 301 to the same path on the primary. */
export function judgeRedirect(url: string, status: number, location: string | undefined, primary: string, aliases: string[]): AliasProbe {
	const u = new URL(url);
	const expected = `https://${primary}${u.pathname}${u.search}`;
	const probe: AliasProbe = { url, status, ...(location ? { location } : {}), expected, ok: false };
	if (status === 0) return { ...probe, problem: "no response" };
	if (status < 300 || status >= 400) return { ...probe, problem: status === 200 ? "200: serves content instead of redirecting" : `${status}: not a redirect` };
	if (!location) return { ...probe, problem: `${status} without a Location header` };
	let target: URL;
	try {
		target = new URL(location, url);
	} catch {
		return { ...probe, problem: `${status} to an invalid Location` };
	}
	const aliasHosts = new Set(aliases.flatMap((a) => [a, `www.${a}`]));
	if (aliasHosts.has(target.hostname) || (target.hostname === u.hostname && target.protocol !== "https:")) return { ...probe, problem: `chain: ${status} to ${target.href} (another hop before the primary)` };
	if (target.href !== expected) return { ...probe, problem: target.hostname === primary ? `${status} to another path: ${target.href}` : `${status} to ${target.href}, not ${primary}` };
	if (status !== 301) return { ...probe, problem: `${status} instead of 301 (not permanent)` };
	return { ...probe, ok: true };
}

/** Requests every path on each alias (apex and www) without following redirects. Read-only. */
export async function checkAliasRedirects(o: { aliases: string[]; primary: string; paths: string[]; fetch?: FetchLike; concurrency?: number }): Promise<AliasCheckResult> {
	const f = o.fetch ?? fetch;
	const paths = [...new Set(o.paths.map((p) => (p.startsWith("/") ? p : `/${p}`)))].sort();
	const urls = o.aliases.flatMap((a) => [a, `www.${a}`]).flatMap((h) => paths.map((p) => `https://${h}${p}`));
	const probes: AliasProbe[] = [];
	let next = 0;
	const worker = async () => {
		while (next < urls.length) {
			const url = urls[next++] as string;
			try {
				const res = await f(url, { redirect: "manual", method: "GET" });
				await res.body?.cancel().catch(() => {});
				probes.push(judgeRedirect(url, res.status, res.headers.get("location") ?? undefined, o.primary, o.aliases));
			} catch (e) {
				probes.push({ ...judgeRedirect(url, 0, undefined, o.primary, o.aliases), problem: `no response: ${(e as Error).message.split("\n")[0]}` });
			}
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, o.concurrency ?? 6) }, worker));
	const byHost: AliasCheckResult["byHost"] = {};
	for (const p of probes) {
		const h = new URL(p.url).hostname;
		byHost[h] ??= { checked: 0, ok: 0 };
		byHost[h].checked++;
		if (p.ok) byHost[h].ok++;
	}
	const failures = probes.filter((p) => !p.ok).sort((a, b) => a.url.localeCompare(b.url));
	return { ranAt: new Date().toISOString(), primary: o.primary, aliases: o.aliases, paths: paths.length, checked: probes.length, ok: probes.length > 0 && failures.length === 0, failures, byHost };
}

export function aliasCheckReport(r: AliasCheckResult): string {
	const L = [`# Alias redirects → ${r.primary}`, "", `Checked ${r.ranAt.slice(0, 16).replace("T", " ")} UTC: ${r.paths} audited paths × ${Object.keys(r.byHost).length} hosts = ${r.checked} requests, no redirect followed. Expected: 301 to the same path and query on https://${r.primary}.`, ""];
	L.push("| Host | OK |", "|---|---|", ...Object.entries(r.byHost).map(([h, v]) => `| ${h} | ${v.ok}/${v.checked} |`), "");
	if (!r.failures.length) L.push(r.checked ? "Every path redirects correctly." : "Nothing checked: no audited paths.");
	else L.push(`## Problems (${r.failures.length})`, "", "| URL | Status | Problem |", "|---|---|---|", ...r.failures.map((p) => `| ${p.url} | ${p.status} | ${p.problem ?? ""} |`));
	return `${L.join("\n")}\n`;
}
