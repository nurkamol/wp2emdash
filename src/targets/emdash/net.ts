/**
 * fetch with a DNS fallback. A brand-new *.workers.dev hostname is often cached as "not found" by the
 * local resolver (macOS, routers, ISPs) for a while after the first deploy, while it already resolves
 * publicly. On ENOTFOUND we ask Cloudflare's DNS over HTTPS and connect to the answer; TLS still
 * verifies the certificate for the original hostname, so this changes routing only, not trust.
 */
import { lookup as systemLookup, type LookupAddress } from "node:dns";
import { Agent, fetch as undiciFetch } from "undici";

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

const dohCache = new Map<string, { address: string; family: number; until: number }>();
const pinned = new Map<string, string[]>();

/**
 * Pin a hostname to known addresses (like `curl --resolve`), e.g. a staging Worker's Cloudflare
 * addresses recorded in sites/<slug>/cloudflare.json. TLS still verifies the hostname's certificate.
 */
export function pinHost(host: string, addresses: string[]): void {
	if (addresses.length) pinned.set(host.toLowerCase(), addresses);
}

/**
 * Resolve through Cloudflare DNS over HTTPS. Answers for new workers.dev names can flap (SERVFAIL
 * "No Reachable Authority" one request, the right answer the next), so retry a few times and keep a
 * good answer for at least 10 minutes — the run then never depends on DNS again.
 */
export async function resolveViaDoh(host: string, attempts = 6): Promise<{ address: string; family: number } | undefined> {
	const hit = dohCache.get(host);
	if (hit && hit.until > Date.now()) return hit;
	for (let i = 0; i < attempts; i++) {
		for (const [type, family] of [["A", 4], ["AAAA", 6]] as const) {
			try {
				const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(10_000) });
				const j = (await r.json()) as { Status?: number; Answer?: { type: number; data: string; TTL: number }[] };
				const rec = j.Status === 0 ? j.Answer?.find((a) => a.type === (family === 4 ? 1 : 28)) : undefined;
				if (rec) {
					const out = { address: rec.data, family, until: Date.now() + Math.max(600, rec.TTL) * 1000 };
					dohCache.set(host, out);
					return out;
				}
			} catch {}
		}
		await new Promise((r) => setTimeout(r, 500 * (i + 1)));
	}
	return undefined;
}

function lookupWithFallback(hostname: string, options: { all?: boolean } & Record<string, unknown>, callback: LookupCb): void {
	const pins = pinned.get(hostname.toLowerCase());
	if (pins?.length) {
		const list = pins.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
		const first = list[0] as LookupAddress;
		return options.all ? callback(null, list) : callback(null, first.address, first.family);
	}
	systemLookup(hostname, { ...options, all: false }, (err, address, family) => {
		if (!err) return options.all ? callback(null, [{ address: address as string, family: family as number }]) : callback(null, address as string, family);
		if (err.code !== "ENOTFOUND" && err.code !== "EAI_AGAIN") return callback(err, "");
		resolveViaDoh(hostname).then(
			(r) => {
				if (!r) return callback(err, "");
				return options.all ? callback(null, [{ address: r.address, family: r.family }]) : callback(null, r.address, r.family);
			},
			() => callback(err, ""),
		);
	});
}

// The connect timeout includes the lookup; DoH retries can take several seconds.
const agent = new Agent({ connect: { lookup: lookupWithFallback as never, timeout: 60_000 } });

/**
 * Drop-in for global fetch, used for every request to an EmDash target.
 * The undici package does not recognise Node's built-in FormData (a different class), so form bodies
 * are encoded with Node's own Request first and sent as bytes with their multipart boundary.
 */
export const kitFetch = (async (input: string | URL, init?: RequestInit) => {
	let body = init?.body;
	let headers = init?.headers;
	if (typeof FormData !== "undefined" && body instanceof FormData) {
		const encoded = new Request("http://encode.invalid", { method: "POST", body });
		const h = new Headers(headers);
		h.set("content-type", encoded.headers.get("content-type") as string);
		headers = h;
		body = new Uint8Array(await encoded.arrayBuffer());
	}
	return undiciFetch(input, { ...(init as object), ...(body !== undefined ? { body } : {}), ...(headers ? { headers } : {}), dispatcher: agent } as never);
}) as unknown as typeof fetch;
