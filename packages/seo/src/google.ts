/**
 * Google Search Console through a service account (no OAuth screen): the owner adds the service account's email as a
 * user of the Search Console property and pastes its JSON key into the SEO dashboard (stored encrypted by EmDash).
 * The Worker signs a JWT (RS256, WebCrypto) for an access token, then calls Search Analytics, Sitemaps and URL
 * Inspection. `fetcher` is injectable for tests.
 */
export interface ServiceAccount {
	client_email: string;
	private_key: string;
	token_uri?: string;
}
export const SCOPE = "https://www.googleapis.com/auth/webmasters";
const API = "https://www.googleapis.com/webmasters/v3";
const INSPECT = "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect";

export function parseServiceAccount(json: string): ServiceAccount {
	let v: Partial<ServiceAccount> & { type?: string };
	try {
		v = JSON.parse(json);
	} catch {
		throw new Error("That is not a JSON key file. Paste the whole file Google Cloud downloaded.");
	}
	if (v.type && v.type !== "service_account") throw new Error("This key is not for a service account.");
	if (!v.client_email || !v.private_key?.includes("PRIVATE KEY")) throw new Error("The key file has no client_email or private_key.");
	return { client_email: v.client_email, private_key: v.private_key, ...(v.token_uri ? { token_uri: v.token_uri } : {}) };
}

const b64url = (bytes: Uint8Array | string) => {
	const s = typeof bytes === "string" ? btoa(bytes) : btoa(String.fromCharCode(...bytes));
	return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

async function signJwt(sa: ServiceAccount, now: number): Promise<string> {
	const pem = sa.private_key.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
	const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
	const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const body = b64url(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
	const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`)));
	return `${head}.${body}.${b64url(sig)}`;
}

const tokens = new Map<string, { token: string; exp: number }>();

export class GoogleError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export class SearchConsole {
	constructor(
		private sa: ServiceAccount,
		// Wrapped: workerd refuses a global fetch called as a method of another object ("Illegal invocation").
		private fetcher: typeof fetch = (input, init) => fetch(input, init),
	) {}

	private async token(): Promise<string> {
		const now = Math.floor(Date.now() / 1000);
		const have = tokens.get(this.sa.client_email);
		if (have && have.exp > now + 60) return have.token;
		const res = await this.fetcher(this.sa.token_uri ?? "https://oauth2.googleapis.com/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: await signJwt(this.sa, now) }).toString(),
		});
		const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
		if (!res.ok || !j.access_token) throw new GoogleError(`Google sign-in failed: ${j.error_description ?? `HTTP ${res.status}`}`, res.status);
		tokens.set(this.sa.client_email, { token: j.access_token, exp: now + (j.expires_in ?? 3600) });
		return j.access_token;
	}

	private async call<T>(url: string, init: RequestInit = {}): Promise<T> {
		const res = await this.fetcher(url, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...(init.headers as Record<string, string>), authorization: `Bearer ${await this.token()}` } });
		if (res.status === 204) return {} as T;
		const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
		if (!res.ok) {
			const hint = res.status === 403 ? ` Add ${this.sa.client_email} as a user of the property in Search Console.` : "";
			throw new GoogleError(`${j.error?.message ?? `HTTP ${res.status}`}${hint}`, res.status);
		}
		return j;
	}

	/** Properties the service account can read. */
	async sites(): Promise<{ siteUrl: string; permissionLevel: string }[]> {
		return (await this.call<{ siteEntry?: { siteUrl: string; permissionLevel: string }[] }>(`${API}/sites`)).siteEntry ?? [];
	}

	async analytics(site: string, body: { startDate: string; endDate: string; dimensions: string[]; rowLimit?: number; dimensionFilterGroups?: unknown[] }) {
		return (await this.call<{ rows?: { keys?: string[]; clicks: number; impressions: number; ctr: number; position: number }[] }>(`${API}/sites/${encodeURIComponent(site)}/searchAnalytics/query`, { method: "POST", body: JSON.stringify(body) })).rows ?? [];
	}

	async sitemaps(site: string) {
		return (await this.call<{ sitemap?: { path: string; lastSubmitted?: string; lastDownloaded?: string; isPending?: boolean; errors?: string; warnings?: string; contents?: { submitted?: string; indexed?: string }[] }[] }>(`${API}/sites/${encodeURIComponent(site)}/sitemaps`)).sitemap ?? [];
	}

	async submitSitemap(site: string, sitemapUrl: string): Promise<void> {
		await this.call(`${API}/sites/${encodeURIComponent(site)}/sitemaps/${encodeURIComponent(sitemapUrl)}`, { method: "PUT" });
	}

	async inspect(site: string, url: string) {
		const r = await this.call<{ inspectionResult?: { indexStatusResult?: { verdict?: string; coverageState?: string; lastCrawlTime?: string; googleCanonical?: string } } }>(INSPECT, { method: "POST", body: JSON.stringify({ inspectionUrl: url, siteUrl: site }) });
		return r.inspectionResult?.indexStatusResult ?? {};
	}
}

/** The Search Console property for a domain among those the account can read: a domain property first, else the URL prefix. */
export function pickProperty(sites: { siteUrl: string }[], productionUrl: string): string | undefined {
	const host = new URL(productionUrl).host.replace(/^www\./, "");
	return sites.find((s) => s.siteUrl === `sc-domain:${host}`)?.siteUrl ?? sites.find((s) => URL.canParse(s.siteUrl) && new URL(s.siteUrl).host.replace(/^www\./, "") === host)?.siteUrl;
}

/** The last 28 days Search Console has data for (it lags about two days). */
export function dateRange(now = new Date()): { startDate: string; endDate: string } {
	const end = new Date(now.getTime() - 2 * 86_400_000);
	const start = new Date(end.getTime() - 27 * 86_400_000);
	return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) };
}
