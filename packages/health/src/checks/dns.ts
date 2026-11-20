/**
 * Email DNS records: the domain's mail records (MX, SPF, DMARC, DKIM) must stay as they were at go-live. Scaffold
 * embeds a baseline from the cutover preflight's snapshot (cutover/dns-before.json): for each record its type, name
 * and a hash of the normalised value — never the value itself. Daily the Worker asks Cloudflare's public resolver
 * (DNS over HTTPS, cloudflare-dns.com, JSON API) for the same names and compares hashes. No token needed.
 *
 * Shared with the kit (scaffold builds the baseline with `mailBaseline`), so both sides normalise the same way.
 */
import type { Fetcher } from "../probe.js";
import type { CheckState } from "../store.js";
import { plural, sha256Hex } from "../util.js";

export const DOH_URL = "https://cloudflare-dns.com/dns-query";
const MAX_NAMES = 8;

export interface MailRecord {
	type: "MX" | "TXT" | "CNAME";
	name: string;
	/** First 16 hex characters of SHA-256 over the normalised value. */
	h: string;
}
export interface MailBaseline {
	zone: string;
	at: string;
	records: MailRecord[];
}

const DNS_TYPE: Record<number, MailRecord["type"]> = { 15: "MX", 16: "TXT", 5: "CNAME" };

/** One record's value as both sides see it: lower-case hosts without the final dot; TXT strings joined, unquoted. */
export function normalise(type: string, content: string, priority?: number): string {
	const c = content.trim();
	if (type === "MX") {
		const parts = c.split(/\s+/);
		const [prio, host] = parts.length > 1 ? [parts[0], parts[1]] : [String(priority ?? ""), parts[0]];
		return `${Number(prio)} ${(host ?? "").toLowerCase().replace(/\.$/, "")}`;
	}
	if (type === "TXT") return c.replace(/"\s+"/g, "").replace(/^"|"$/g, "").replace(/\\"/g, '"');
	return c.toLowerCase().replace(/\.$/, "");
}

/** Whether a record is about email: MX, SPF, DMARC or DKIM (by value or by name). */
export const isMailRecord = (r: { type: string; name: string; content: string }) => r.type === "MX" || (r.type === "TXT" && /v=spf1|v=DMARC1|v=DKIM1|k=rsa/i.test(r.content)) || /(^|\.)_dmarc\.|_domainkey\./i.test(`${r.name}.`);

/** The baseline from Cloudflare DNS records (cutover/dns-before.json `keep`): mail records only, values hashed. */
export async function mailBaseline(zone: string, records: { type: string; name: string; content: string; priority?: number }[], at: string): Promise<MailBaseline> {
	const out: MailRecord[] = [];
	for (const r of records) {
		if (!["MX", "TXT", "CNAME"].includes(r.type) || !isMailRecord(r)) continue;
		out.push({ type: r.type as MailRecord["type"], name: r.name.toLowerCase().replace(/\.$/, ""), h: (await sha256Hex(normalise(r.type, r.content, r.priority))).slice(0, 16) });
	}
	out.sort((a, b) => `${a.type}${a.name}${a.h}`.localeCompare(`${b.type}${b.name}${b.h}`));
	return { zone, at, records: out };
}

export interface MailDiff {
	missing: { type: string; name: string }[];
	added: { type: string; name: string }[];
	unreachable: string[];
	names: number;
}

/** Asks DNS for every (type, name) of the baseline and compares value hashes. */
export async function compareMail(base: MailBaseline, fetcher: Fetcher): Promise<MailDiff> {
	const keys = [...new Map(base.records.map((r) => [`${r.type} ${r.name}`, { type: r.type, name: r.name }])).values()].slice(0, MAX_NAMES);
	const diff: MailDiff = { missing: [], added: [], unreachable: [], names: keys.length };
	for (const k of keys) {
		let live: string[];
		try {
			const res = await fetcher(`${DOH_URL}?name=${encodeURIComponent(k.name)}&type=${k.type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8_000) });
			if (!res.ok) throw new Error(String(res.status));
			const j = (await res.json()) as { Status?: number; Answer?: { type: number; data: string }[] };
			if (j.Status !== 0 && j.Status !== 3) throw new Error(`rcode ${j.Status}`);
			// Only mail values count: other TXT records at the same name (site verification…) are not in the baseline.
			live = (j.Answer ?? []).filter((a) => DNS_TYPE[a.type] === k.type && isMailRecord({ type: k.type, name: k.name, content: a.data })).map((a) => a.data);
		} catch {
			diff.unreachable.push(`${k.type} ${k.name}`);
			continue;
		}
		const liveHashes = new Set(await Promise.all(live.map(async (v) => (await sha256Hex(normalise(k.type, v))).slice(0, 16))));
		const baseHashes = new Set(base.records.filter((r) => r.type === k.type && r.name === k.name).map((r) => r.h));
		if ([...baseHashes].some((h) => !liveHashes.has(h))) diff.missing.push(k);
		if ([...liveHashes].some((h) => !baseHashes.has(h))) diff.added.push(k);
	}
	return diff;
}

export function dnsCheck(base: MailBaseline | undefined, diff: MailDiff | undefined, at: string): CheckState {
	if (!base) return { status: "off", summary: "No baseline: the go-live DNS snapshot (cutover/dns-before.json) was not available when the site was built.", at };
	if (!base.records.length) return { status: "off", summary: `No mail records were found for ${base.zone} at go-live, so there is nothing to compare.`, at };
	if (!diff) return { status: "unknown", summary: "Not checked yet.", at };
	const list = (xs: { type: string; name: string }[]) => xs.map((x) => `${x.type} ${x.name}`).join(", ");
	const detail = [`${plural(base.records.length, "mail record")} recorded ${base.at.slice(0, 10)}; ${plural(diff.names, "name")} compared.`];
	if (diff.missing.length) return { status: "fail", summary: `Email DNS changed since go-live: ${list(diff.missing)}. Email to or from the domain may stop working.`, at, detail };
	if (diff.added.length) return { status: "warn", summary: `New mail records since go-live: ${list(diff.added)} (fine if intended).`, at, detail };
	if (diff.unreachable.length === diff.names) return { status: "unknown", summary: "DNS could not be asked this time; trying again tomorrow.", at, detail };
	return { status: "ok", summary: "Mail records are as they were at go-live.", at, detail };
}
