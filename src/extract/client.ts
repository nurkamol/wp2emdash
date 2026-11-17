/**
 * Read-only authenticated WordPress REST client. GET only — the kit never writes to WordPress.
 * Tries the pretty `/wp-json/` route and falls back to `?rest_route=` on 404 (plain permalinks),
 * the same rule the EmDash importer uses.
 */
import { redact, type WpCredentials } from "./credentials.js";

const UA = "EmDash-Importer/1.0 (wp2emdash extract; read-only)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class WpHttpError extends Error {
	constructor(
		public status: number,
		public path: string,
		message: string,
	) {
		super(message);
	}
}

export interface Paged<T> {
	items: T[];
	total: number;
	pages: number;
}

export class WpClient {
	private auth: string;
	readonly requests: { path: string; status: number; ms: number }[] = [];

	constructor(
		readonly siteUrl: string,
		private creds: WpCredentials | undefined,
		private opts: { timeoutMs?: number; retries?: number } = {},
	) {
		this.siteUrl = siteUrl.replace(/\/+$/, "");
		this.auth = creds ? `Basic ${Buffer.from(`${creds.user}:${creds.password}`).toString("base64")}` : "";
	}

	private url(path: string, params: Record<string, string | number>, restRoute: boolean): string {
		const u = restRoute ? new URL(`${this.siteUrl}/`) : new URL(`${this.siteUrl}/wp-json/${path}`);
		if (restRoute) u.searchParams.set("rest_route", `/${path}`);
		for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
		return u.href;
	}

	private async once(url: string, authed: boolean): Promise<Response> {
		const { timeoutMs = 60_000, retries = 3 } = this.opts;
		let last: unknown;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const res = await fetch(url, {
					method: "GET",
					headers: { Accept: "application/json", "User-Agent": UA, ...(authed && this.auth ? { Authorization: this.auth } : {}) },
					signal: AbortSignal.timeout(timeoutMs),
				});
				if ((res.status === 429 || res.status >= 500) && attempt < retries) {
					await res.body?.cancel();
					await sleep(Math.min(Number(res.headers.get("retry-after")) || 2 ** attempt * 2, 30) * 1000);
					continue;
				}
				return res;
			} catch (e) {
				last = e;
				if (attempt < retries) await sleep(1000 * (attempt + 1));
			}
		}
		throw new Error(redact(`request failed: ${last instanceof Error ? last.message : String(last)}`, this.creds));
	}

	/** GET JSON. `authed: false` for public endpoints (probe). */
	async get<T>(path: string, params: Record<string, string | number> = {}, authed = true): Promise<T> {
		const started = Date.now();
		let res = await this.once(this.url(path, params, false), authed);
		if (res.status === 404) {
			await res.body?.cancel();
			res = await this.once(this.url(path, params, true), authed);
		}
		this.requests.push({ path, status: res.status, ms: Date.now() - started });
		const text = await res.text();
		if (!res.ok) {
			let msg = text.slice(0, 200);
			try {
				const j = JSON.parse(text) as { code?: string; message?: string };
				msg = [j.code, j.message].filter(Boolean).join(": ");
			} catch {}
			throw new WpHttpError(res.status, path, redact(`${path} → HTTP ${res.status} ${msg}`, this.creds));
		}
		try {
			return JSON.parse(text) as T;
		} catch {
			throw new WpHttpError(res.status, path, `${path} → response is not JSON (security plugin or cache page?)`);
		}
	}

	/** Like get() but returns undefined on 404 (optional endpoints / plugins). */
	async tryGet<T>(path: string, params: Record<string, string | number> = {}): Promise<T | undefined> {
		try {
			return await this.get<T>(path, params);
		} catch (e) {
			if (e instanceof WpHttpError && (e.status === 404 || e.status === 400)) return undefined;
			throw e;
		}
	}

	/** Walk an exporter-style paged endpoint ({items,total,pages}). */
	async all<T>(path: string, params: Record<string, string | number>, perPage: number, onPage?: (page: number, pages: number) => void): Promise<Paged<T>> {
		const items: T[] = [];
		let page = 1;
		let pages = 1;
		let total = 0;
		do {
			const r = await this.get<{ items: T[]; total: number; pages: number }>(path, { ...params, per_page: perPage, page });
			items.push(...r.items);
			pages = r.pages || 1;
			total = r.total ?? items.length;
			onPage?.(page, pages);
			page++;
		} while (page <= pages);
		return { items, total, pages };
	}

	/** Download a public file (media). Never sends credentials. */
	async download(url: string): Promise<{ status: number; bytes?: Buffer; contentType?: string }> {
		const res = await this.once(url, false);
		if (!res.ok) {
			await res.body?.cancel();
			return { status: res.status };
		}
		return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? undefined };
	}
}

export function versionAtLeast(v: string, min: string): boolean {
	const a = v.split(".").map((n) => Number.parseInt(n, 10) || 0);
	const b = min.split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
	}
	return true;
}
