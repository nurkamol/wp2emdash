/**
 * The opt-in off-site copy: one PUT per backup to an S3-compatible bucket (another Cloudflare account's R2, AWS S3,
 * Backblaze B2, Wasabi, …), signed with AWS Signature Version 4 (path-style URL, payload hash in the request). Web
 * Crypto only, no SDK. Credentials come from Worker secrets and appear only in the signature, never in logs or errors.
 * The Worker never deletes off-site copies: give the key write access only and set a lifecycle rule on that bucket.
 */
import { hex, sha256Hex } from "./util.js";

export interface S3Target {
	endpoint: string;
	bucket: string;
	region?: string;
	prefix?: string;
}
export interface S3Credentials {
	accessKeyId: string;
	secretAccessKey: string;
}

const enc = new TextEncoder();
async function hmac(key: ArrayBuffer | Uint8Array<ArrayBuffer>, data: string): Promise<ArrayBuffer> {
	const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** RFC 3986 encoding per path segment, as SigV4 wants it. */
const encodeSegment = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Signs a request (SigV4, service "s3"). Returns the headers to send. `headers` must hold every header to sign except
 * host, x-amz-date and x-amz-content-sha256, which are added.
 */
export async function signV4(o: { method: string; url: string; region: string; credentials: S3Credentials; payloadHash: string; headers?: Record<string, string>; amzDate: string }): Promise<Record<string, string>> {
	const u = new URL(o.url);
	const date = o.amzDate.slice(0, 8);
	const all: Record<string, string> = { ...Object.fromEntries(Object.entries(o.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()])), host: u.host, "x-amz-content-sha256": o.payloadHash, "x-amz-date": o.amzDate };
	const names = Object.keys(all).sort();
	const canonicalQuery = [...u.searchParams.entries()].map(([k, v]): [string, string] => [encodeSegment(k), encodeSegment(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("&");
	const canonical = [o.method, u.pathname.split("/").map((s) => encodeSegment(decodeURIComponent(s))).join("/"), canonicalQuery, ...names.map((n) => `${n}:${all[n]}`), "", names.join(";"), o.payloadHash].join("\n");
	const scope = `${date}/${o.region}/s3/aws4_request`;
	const toSign = ["AWS4-HMAC-SHA256", o.amzDate, scope, await sha256Hex(canonical)].join("\n");
	let key = await hmac(enc.encode(`AWS4${o.credentials.secretAccessKey}`), date);
	key = await hmac(key, o.region);
	key = await hmac(key, "s3");
	key = await hmac(key, "aws4_request");
	const signature = hex(await hmac(key, toSign));
	const out: Record<string, string> = { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${o.credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
	delete out.host;
	return out;
}

export function offsiteUrl(t: S3Target, key: string): string {
	const base = t.endpoint.replace(/\/+$/, "");
	const prefix = (t.prefix ?? "").replace(/^\/+|\/+$/g, "");
	return `${base}/${encodeSegment(t.bucket)}/${[...(prefix ? prefix.split("/") : []), ...key.split("/")].map(encodeSegment).join("/")}`;
}

/** Copies one backup off-site. Never throws; the reason carries no credentials. */
export async function putOffsite(t: S3Target, c: S3Credentials, key: string, body: Uint8Array<ArrayBuffer>, fetcher: (url: string, init: RequestInit) => Promise<Response>, now = new Date()): Promise<{ ok: true } | { ok: false; reason: string }> {
	try {
		if (!/^https:\/\//.test(t.endpoint)) return { ok: false, reason: "the off-site endpoint must be https" };
		const url = offsiteUrl(t, key);
		const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
		const headers = await signV4({ method: "PUT", url, region: t.region || "auto", credentials: c, payloadHash: await sha256Hex(body), headers: { "content-type": "application/gzip" }, amzDate });
		const res = await fetcher(url, { method: "PUT", headers, body, signal: AbortSignal.timeout(30_000) });
		await res.body?.cancel();
		return res.ok ? { ok: true } : { ok: false, reason: `off-site storage answered HTTP ${res.status}` };
	} catch (e) {
		return { ok: false, reason: `off-site copy failed (${(e as Error)?.name ?? "Error"})` };
	}
}
