/**
 * Minimal EmDash REST client for the load phase (endpoints verified against emdash 1.5 —
 * docs/spikes/M6-findings.md). Local dev: dev-bypass session cookie. Staging: API token
 * (EMDASH_TOKEN). Mutations carry X-EmDash-Request + Origin (EmDash's CSRF rule).
 */

import { kitFetch } from "./net.js";

export class EmDashHttpError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
	}
}

export interface ContentItem {
	id: string;
	slug: string | null;
	status: string;
	data: Record<string, unknown>;
	seo?: Record<string, unknown>;
	_rev?: string;
}
export interface MediaItem {
	id: string;
	filename: string;
	mimeType: string;
	url?: string;
	storageKey?: string;
	contentHash?: string | null;
	alt?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class EmDashApi {
	private cookie?: string;
	readonly baseUrl: string;

	private fetchImpl: typeof fetch;

	constructor(
		baseUrl: string,
		private auth: { token?: string; devBypass?: boolean },
		/** Defaults to kitFetch (DNS fallback for fresh workers.dev hosts); tests inject a stub. */
		fetchImpl?: typeof fetch,
	) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.fetchImpl = fetchImpl ?? kitFetch;
	}

	/** Local dev only: GET /_emdash/api/auth/dev-bypass → session cookie. */
	async login(): Promise<void> {
		if (!this.auth.devBypass || this.cookie) return;
		const res = await this.fetchImpl(`${this.baseUrl}/_emdash/api/auth/dev-bypass`, { redirect: "manual" });
		const set = res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie") ?? ""];
		this.cookie = set.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
		await res.body?.cancel();
		if (!this.cookie) throw new Error(`dev-bypass login failed (HTTP ${res.status}) — is the site set up and running in dev mode?`);
	}

	private headers(method: string, json: boolean): Record<string, string> {
		const h: Record<string, string> = { Accept: "application/json" };
		if (json) h["Content-Type"] = "application/json";
		if (method !== "GET" && method !== "HEAD") {
			h["X-EmDash-Request"] = "1";
			h.Origin = new URL(this.baseUrl).origin;
		}
		if (this.auth.token) h.Authorization = `Bearer ${this.auth.token}`;
		if (this.cookie) h.Cookie = this.cookie;
		return h;
	}

	async request<T>(method: string, path: string, body?: unknown, attempt = 0): Promise<T> {
		await this.login();
		const isForm = typeof FormData !== "undefined" && body instanceof FormData;
		const res = await this.fetchImpl(`${this.baseUrl}/_emdash/api${path}`, {
			method,
			headers: this.headers(method, body !== undefined && !isForm),
			...(body !== undefined ? { body: isForm ? (body as FormData) : JSON.stringify(body) } : {}),
			signal: AbortSignal.timeout(120_000),
		});
		if ((res.status === 429 || res.status >= 502) && attempt < 3) {
			await res.body?.cancel();
			await sleep(1000 * 2 ** attempt);
			return this.request<T>(method, path, body, attempt + 1);
		}
		const text = await res.text();
		let json: { data?: T; error?: { code?: string; message?: string } } = {};
		try {
			json = text ? JSON.parse(text) : {};
		} catch {
			throw new EmDashHttpError(res.status, "NOT_JSON", `${method} ${path} → HTTP ${res.status}: ${text.slice(0, 160)}`);
		}
		if (!res.ok) throw new EmDashHttpError(res.status, json.error?.code ?? `HTTP_${res.status}`, `${method} ${path} → ${json.error?.code ?? res.status}: ${json.error?.message ?? text.slice(0, 200)}`);
		return json.data as T;
	}

	// ── schema ──
	async blockTypes(): Promise<{ slug: string }[]> {
		return (await this.request<{ items: { slug: string }[] }>("GET", "/schema/block-types")).items;
	}
	/** Block types with their versions (active fields + fingerprint). */
	async blockTypesFull(): Promise<{ slug: string; currentVersion: number; versions: { version: number; fields: unknown[]; fingerprint: string; active?: boolean }[] }[]> {
		return (await this.request<{ items: never[] }>("GET", "/schema/block-types")).items;
	}
	async createBlockType(input: { slug: string; label: string; description?: string; category?: string; fields: unknown[] }): Promise<void> {
		await this.request("POST", "/schema/block-types", input);
	}
	/** Compatible changes update the active version in place; incompatible ones need `breaking` (a new version). */
	async updateBlockType(slug: string, input: { expectedFingerprint: string; fields: unknown[]; label?: string; description?: string | null; breaking?: boolean }): Promise<void> {
		await this.request("PUT", `/schema/block-types/${encodeURIComponent(slug)}`, input);
	}
	async collections(): Promise<{ slug: string }[]> {
		return (await this.request<{ items: { slug: string }[] }>("GET", "/schema/collections")).items;
	}

	// ── content ──
	async list(collection: string): Promise<ContentItem[]> {
		const out: ContentItem[] = [];
		let cursor: string | undefined;
		do {
			const r = await this.request<{ items: ContentItem[]; nextCursor?: string }>("GET", `/content/${encodeURIComponent(collection)}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
			out.push(...r.items);
			cursor = r.nextCursor;
		} while (cursor);
		return out;
	}
	async get(collection: string, id: string): Promise<ContentItem> {
		const r = await this.request<{ item: ContentItem; _rev?: string }>("GET", `/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`);
		return { ...r.item, ...(r._rev ? { _rev: r._rev } : {}) };
	}
	async create(collection: string, input: { data: Record<string, unknown>; slug?: string; seo?: Record<string, unknown>; bylines?: { bylineId: string }[]; taxonomies?: Record<string, string[]>; publishedAt?: string }): Promise<ContentItem> {
		return (await this.request<{ item: ContentItem }>("POST", `/content/${encodeURIComponent(collection)}`, input)).item;
	}
	async update(collection: string, id: string, input: { data?: Record<string, unknown>; slug?: string; seo?: Record<string, unknown>; _rev?: string; bylines?: { bylineId: string }[]; taxonomies?: Record<string, string[]>; publishedAt?: string }): Promise<ContentItem> {
		return (await this.request<{ item: ContentItem }>("PUT", `/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, input)).item;
	}
	/** `publishedAt` backdates the publish (migration); EmDash requires content:publish_any (Editor role) for it. */
	async publish(collection: string, id: string, publishedAt?: string): Promise<void> {
		await this.request("POST", `/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/publish`, publishedAt ? { publishedAt } : {});
	}
	/** Scheduled publishing (EmDash publishes it from the Worker's cron at `scheduledAt`). */
	async schedule(collection: string, id: string, scheduledAt: string): Promise<void> {
		await this.request("POST", `/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/schedule`, { scheduledAt });
	}

	// ── collections (schema) ──
	async createCollection(input: { slug: string; label: string; labelSingular?: string; description?: string; supports?: string[]; urlPattern?: string; routable?: boolean; hasSeo?: boolean; sortOrder?: number }): Promise<void> {
		await this.request("POST", "/schema/collections", input);
	}
	async createField(collection: string, field: Record<string, unknown>): Promise<void> {
		await this.request("POST", `/schema/collections/${encodeURIComponent(collection)}/fields`, { validation: null, ...field });
	}

	// ── taxonomies (WRITE needs taxonomies:manage, which content:write grants) ──
	async taxonomies(): Promise<{ name: string; collections: string[]; hierarchical: boolean }[]> {
		return (await this.request<{ taxonomies: { name: string; collections: string[]; hierarchical: boolean }[] }>("GET", "/taxonomies")).taxonomies;
	}
	async createTaxonomy(input: { name: string; label: string; labelSingular?: string; hierarchical?: boolean; collections?: string[] }): Promise<void> {
		await this.request("POST", "/taxonomies", input);
	}
	async terms(taxonomy: string): Promise<EmDashTerm[]> {
		return (await this.request<{ terms: EmDashTerm[] }>("GET", `/taxonomies/${encodeURIComponent(taxonomy)}/terms?includeCounts=false`)).terms;
	}
	async createTerm(taxonomy: string, input: { slug: string; label: string; parentId?: string | null; description?: string }): Promise<EmDashTerm> {
		return (await this.request<{ term: EmDashTerm }>("POST", `/taxonomies/${encodeURIComponent(taxonomy)}/terms`, input)).term;
	}

	// ── bylines (EmDash 1.5 serves them under /admin: the API token needs the `admin` scope) ──
	async bylines(): Promise<EmDashByline[]> {
		const out: EmDashByline[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 100; page++) {
			const r = await this.request<{ items: EmDashByline[]; nextCursor?: string }>("GET", `/admin/bylines?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
			out.push(...(r.items ?? []));
			if (!r.nextCursor) break;
			cursor = r.nextCursor;
		}
		return out;
	}
	async createByline(input: { slug: string; displayName: string; bio?: string | null; avatarMediaId?: string | null; isGuest?: boolean }): Promise<EmDashByline> {
		const r = await this.request<EmDashByline | { item?: EmDashByline; byline?: EmDashByline }>("POST", "/admin/bylines", input);
		return ((r as { byline?: EmDashByline }).byline ?? (r as { item?: EmDashByline }).item ?? r) as EmDashByline;
	}
	async unpublish(collection: string, id: string): Promise<void> {
		await this.request("POST", `/content/${encodeURIComponent(collection)}/${encodeURIComponent(id)}/unpublish`, {});
	}

	// ── media ──
	async mediaList(): Promise<MediaItem[]> {
		const out: MediaItem[] = [];
		let cursor: string | undefined;
		do {
			const r = await this.request<{ items: MediaItem[]; nextCursor?: string }>("GET", `/media?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
			out.push(...r.items);
			cursor = r.nextCursor;
		} while (cursor);
		return out;
	}
	async mediaUpload(bytes: Uint8Array, filename: string, mime: string, alt?: string): Promise<MediaItem> {
		const form = new FormData();
		form.append("file", new Blob([bytes as BlobPart], { type: mime }), filename);
		if (alt) form.append("alt", alt);
		return (await this.request<{ item: MediaItem }>("POST", "/media", form)).item;
	}

	// ── menus & settings ──
	async menu(name: string): Promise<{ name: string; items: { id: string; label: string; parentId?: string | null }[] } | undefined> {
		try {
			return await this.request("GET", `/menus/${encodeURIComponent(name)}`);
		} catch (e) {
			if (e instanceof EmDashHttpError && e.status === 404) return undefined;
			throw e;
		}
	}
	async deleteMenu(name: string): Promise<void> {
		await this.request("DELETE", `/menus/${encodeURIComponent(name)}`);
	}
	async createMenu(name: string, label: string): Promise<void> {
		await this.request("POST", "/menus", { name, label });
	}
	async createMenuItem(menu: string, item: { type: string; label: string; customUrl?: string; target?: string; titleAttr?: string; cssClasses?: string; parentId?: string; sortOrder?: number }): Promise<{ id: string }> {
		const r = await this.request<{ item?: { id: string }; id?: string }>("POST", `/menus/${encodeURIComponent(menu)}/items`, item);
		return { id: r.item?.id ?? (r.id as string) };
	}
	async settings(): Promise<Record<string, unknown>> {
		return this.request("GET", "/settings");
	}
	async updateSettings(input: Record<string, unknown>): Promise<void> {
		await this.request("POST", "/settings", input);
	}

	// ── redirects (EmDash 1.5: /_emdash/api/redirects, cursor-paged, 100 per page) ──
	async listRedirects(): Promise<EmDashRedirect[]> {
		const out: EmDashRedirect[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 200; page++) {
			const r = await this.request<{ items: EmDashRedirect[]; nextCursor?: string }>("GET", `/redirects?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
			out.push(...(r.items ?? []));
			if (!r.nextCursor) break;
			cursor = r.nextCursor;
		}
		return out;
	}
	async createRedirect(input: { source: string; destination: string; type: number; groupName?: string }): Promise<EmDashRedirect> {
		return this.request("POST", "/redirects", input);
	}
	async updateRedirect(id: string, input: { destination?: string; type?: number; enabled?: boolean }): Promise<EmDashRedirect> {
		return this.request("PUT", `/redirects/${encodeURIComponent(id)}`, input);
	}
}

export interface EmDashTerm {
	id: string;
	slug: string;
	label: string;
	parentId: string | null;
	description?: string;
}

export interface EmDashByline {
	id: string;
	slug: string;
	displayName: string;
	bio: string | null;
	avatarMediaId: string | null;
	translationGroup?: string | null;
}

export interface EmDashRedirect {
	id: string;
	source: string;
	destination: string;
	type: number;
	enabled: boolean;
	groupName?: string | null;
}
