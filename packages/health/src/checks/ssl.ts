/**
 * The domain's security certificate. A Worker cannot see the certificate of its own domain (fetch exposes no TLS
 * details, and Cloudflare terminates TLS before the Worker runs). Cloudflare issues and renews the edge certificate
 * itself (Universal SSL / Custom Domain certificates), so without a token this check only reports that.
 *
 * Optional: the Worker secret CF_ZONE_READ_TOKEN — a custom Cloudflare token with Zone → Zone → Read and Zone → SSL and
 * Certificates → Read for this one zone — lets the check read the certificate packs (GET /zones?name=…, then
 * /zones/{id}/ssl/certificate_packs) and warn before an expiry. The token goes only to api.cloudflare.com in the
 * Authorization header and never into a result, a log or KV. Not yet run against the live API (mocked in tests).
 */
import type { Fetcher } from "../probe.js";
import type { CheckState } from "../store.js";
import { DAY } from "../util.js";

const API = "https://api.cloudflare.com/client/v4";

export interface CertFacts {
	/** Earliest expiry among active certificates covering the host (ISO). */
	expiresOn?: string;
	issuer?: string;
	error?: string;
	packs: number;
}

/** The registrable zone of a host for the lookup (example.co.uk is not handled: the zone is tried from the right). */
const zoneCandidates = (host: string) => {
	const parts = host.replace(/^www\./, "").split(".");
	return parts.map((_, i) => parts.slice(i).join(".")).filter((z) => z.includes(".")).reverse();
};

const covers = (hosts: string[], host: string) => hosts.some((h) => h === host || (h.startsWith("*.") && host.endsWith(h.slice(1)) && host.split(".").length === h.split(".").length));

export async function readCertificates(host: string, token: string, fetcher: Fetcher): Promise<CertFacts> {
	const get = async <T>(path: string): Promise<T | undefined> => {
		const res = await fetcher(`${API}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) });
		if (res.status === 401 || res.status === 403) throw new Error("Cloudflare refused the token: it needs Zone → Zone → Read and Zone → SSL and Certificates → Read for this zone.");
		const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: T };
		if (!res.ok || j.success === false) throw new Error(`Cloudflare answered HTTP ${res.status}.`);
		return j.result;
	};
	try {
		let zoneId: string | undefined;
		for (const name of zoneCandidates(host)) {
			zoneId = (await get<{ id: string }[]>(`/zones?name=${encodeURIComponent(name)}`))?.[0]?.id;
			if (zoneId) break;
		}
		if (!zoneId) return { packs: 0, error: `The token cannot see a zone for ${host}.` };
		const packs = (await get<{ status?: string; certificate_authority?: string; certificates?: { hosts?: string[]; expires_on?: string; status?: string }[]; hosts?: string[] }[]>(`/zones/${zoneId}/ssl/certificate_packs?status=all`)) ?? [];
		let best: { at: string; ca?: string } | undefined;
		for (const p of packs) {
			if (p.status && p.status !== "active") continue;
			for (const c of p.certificates ?? []) {
				if (!c.expires_on || !covers(c.hosts ?? p.hosts ?? [], host)) continue;
				if (!best || c.expires_on < best.at) best = { at: c.expires_on, ...(p.certificate_authority ? { ca: p.certificate_authority } : {}) };
			}
		}
		return { packs: packs.length, ...(best ? { expiresOn: best.at, ...(best.ca ? { issuer: best.ca } : {}) } : {}) };
	} catch (e) {
		// Messages are ours or an HTTP status: the token never appears in them.
		return { packs: 0, error: (e as Error).name === "TimeoutError" ? "Cloudflare did not answer in time." : (e as Error).message.split(token).join("[token]").slice(0, 200) };
	}
}

export function sslCheck(f: CertFacts | undefined, httpsOk: boolean, at: string, now = Date.now()): CheckState {
	if (!f) return { status: httpsOk ? "ok" : "unknown", summary: httpsOk ? "Cloudflare issues and renews the certificate automatically. Its expiry date is not readable from the site (optional token CF_ZONE_READ_TOKEN)." : "Not checked.", at };
	if (f.error) return { status: "unknown", summary: `Certificate not checked: ${f.error}`, at };
	if (!f.expiresOn) return { status: "warn", summary: "No active certificate covering the domain was found in Cloudflare.", at, detail: [`${f.packs} certificate packs on the zone.`] };
	const days = Math.floor((Date.parse(f.expiresOn) - now) / DAY);
	const detail = [`Expires ${f.expiresOn.slice(0, 10)}${f.issuer ? ` (${f.issuer})` : ""}; Cloudflare renews it before then.`];
	if (days < 0) return { status: "fail", summary: "The certificate has expired: browsers show a security warning.", at, detail };
	if (days < 7) return { status: "fail", summary: `The certificate expires in ${days} days and has not been renewed.`, at, detail };
	if (days < 14) return { status: "warn", summary: `The certificate expires in ${days} days; Cloudflare normally renews it about 30 days before.`, at, detail };
	return { status: "ok", summary: `Valid for ${days} more days.`, at, detail };
}
