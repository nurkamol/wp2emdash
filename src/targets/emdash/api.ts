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
	/** EmDash 1.5: +1 on every write to the entry (save, draft revision, publish…); with updatedAt, how load spots an admin edit. */
	version?: number;
	updatedAt?: string;
}
export interface MediaItem {
	id: string;
	filename: string;
	mimeType: string;
	url?: string;
	storageKey?: string;
	contentHash?: string | null;
	alt?: string | null;
	/** EmDash ≥ 1.5: the media folder, null = Main library. */
	folderId?: string | null;
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
	/** `references`: reference field slug → entry ids, in order (EmDash writes them as relation links; emdash 1.5 contentUpdateBody). */
	async update(collection: string, id: string, input: { data?: Record<string, unknown>; slug?: string; seo?: Record<string, unknown>; _rev?: string; bylines?: { bylineId: string }[]; taxonomies?: Record<string, string[]>; publishedAt?: string; references?: Record<string, string[]> }): Promise<ContentItem> {
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
	/** GET /schema/collections/{c}/fields → { items } (schema:read); each field has its database `id`. */
	async fields(collection: string): Promise<{ id: string; slug: string; type: string; validation?: { allowedMimeTypes?: string[] } | null }[]> {
		return (await this.request<{ items: { id: string; slug: string; type: string; validation?: { allowedMimeTypes?: string[] } | null }[] }>("GET", `/schema/collections/${encodeURIComponent(collection)}/fields`)).items;
	}
	async createField(collection: string, field: Record<string, unknown>): Promise<void> {
		await this.request("POST", `/schema/collections/${encodeURIComponent(collection)}/fields`, { validation: null, ...field });
	}
	/** A collection with its fields and comment settings (GET /schema/collections/{slug}?includeFields=true). */
	async collection(slug: string): Promise<{ slug: string; commentsEnabled?: boolean; commentsModeration?: string; commentsClosedAfterDays?: number; fields?: { slug: string }[] }> {
		return (await this.request<{ item: never }>("GET", `/schema/collections/${encodeURIComponent(slug)}?includeFields=true`)).item;
	}
	/** Collection settings (`updateCollectionBody`): here only the comment settings. Needs schema:write. */
	async updateCollection(slug: string, input: { commentsEnabled?: boolean; commentsModeration?: "all" | "first_time" | "none"; commentsClosedAfterDays?: number }): Promise<void> {
		await this.request("PUT", `/schema/collections/${encodeURIComponent(slug)}`, input);
	}

	// ── comments (admin routes need the admin scope) ──
	/** The kit's import plugin (@wp2emdash/comments); NOT_FOUND when it is not registered on the target. */
	async commentsPluginStatus(): Promise<{ plugin: string; version: string }> {
		// POST: EmDash's private plugin routes want the X-EmDash-Request header from a session even on GET, which this
		// client only sends on writes (the route answers any method).
		return this.request("POST", "/plugins/wp2emdash-comments/status", {});
	}
	/** Write a batch of migrated comments as pending (packages/comments/src/import.ts). */
	async importComments(comments: unknown[]): Promise<{ results: ({ id: string; outcome: "created" } | { id: string; outcome: "exists"; status: string } | { id: string; outcome: "rejected"; reason: string })[]; created: number; error?: string }> {
		return this.request("POST", "/plugins/wp2emdash-comments/import", { comments });
	}
	/** Sharing text and archive SEO into the SEO plugin's stores (@wp2emdash/seo `seo-import`; admins / admin scope). */
	async seoImport(payload: { entries: unknown[]; terms: unknown[] }): Promise<{ error?: string; entries?: { written: number; kept: number; rejected: number }; terms?: { written: number; kept: number; rejected: number } }> {
		return this.request("POST", "/plugins/site-seo/seo-import", payload);
	}
	/** EmDash's bulk moderation (at most 100 ids): approve also purges the cached pages of the entries. */
	async moderateComments(ids: string[], action: "approve" | "spam" | "trash"): Promise<number> {
		return (await this.request<{ affected: number }>("POST", "/admin/comments/bulk", { ids, action })).affected;
	}
	/** Every comment with this status (admin inbox, paged by 100). Only ids, entries and status are kept. */
	async commentIds(status: "approved" | "pending" | "spam" | "trash", collection?: string): Promise<{ id: string; contentId: string; status: string }[]> {
		const out: { id: string; contentId: string; status: string }[] = [];
		let cursor: string | undefined;
		do {
			const q = new URLSearchParams({ status, limit: "100", ...(collection ? { collection } : {}), ...(cursor ? { cursor } : {}) });
			const r = await this.request<{ items: { id: string; contentId: string; status: string }[]; nextCursor?: string }>("GET", `/admin/comments?${q}`);
			for (const c of r.items) out.push({ id: c.id, contentId: c.contentId, status: c.status });
			cursor = r.nextCursor;
		} while (cursor);
		return out;
	}

	// ── taxonomies (WRITE needs taxonomies:manage, which content:write grants) ──
	async taxonomies(): Promise<{ name: string; collections: string[]; hierarchical: boolean }[]> {
		return (await this.request<{ taxonomies: { name: string; collections: string[]; hierarchical: boolean }[] }>("GET", "/taxonomies")).taxonomies;
	}
	async createTaxonomy(input: { name: string; label: string; labelSingular?: string; hierarchical?: boolean; collections?: string[] }): Promise<void> {
		await this.request("POST", "/taxonomies", input);
	}
	/** PUT /taxonomies/{name}: e.g. add a collection to an existing taxonomy (emdash 1.5 updateTaxonomyDefBody). */
	async updateTaxonomy(name: string, input: { label?: string; labelSingular?: string; collections?: string[] }): Promise<void> {
		await this.request("PUT", `/taxonomies/${encodeURIComponent(name)}`, input);
	}
	/** Every term, flat. EmDash 1.5 answers a hierarchical taxonomy as a tree (children nested), so flatten it. */
	async terms(taxonomy: string): Promise<EmDashTerm[]> {
		return flattenTerms((await this.request<{ terms: EmDashTerm[] }>("GET", `/taxonomies/${encodeURIComponent(taxonomy)}/terms?includeCounts=false`)).terms);
	}
	async updateTerm(taxonomy: string, slug: string, input: { label?: string; description?: string }): Promise<void> {
		await this.request("PUT", `/taxonomies/${encodeURIComponent(taxonomy)}/terms/${encodeURIComponent(slug)}`, input);
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
	/**
	 * POST /media (multipart): `alt` and `caption` are the only text EmDash 1.5 stores with a file (mediaUploadMetadataForm).
	 * `fieldId`: a file field's id, whose `validation.allowedMimeTypes` replaces the global allowlist (images, audio,
	 * video, PDF) for this upload — how Word, Excel, ZIP… files get in (api/handlers/media-allowlist.ts).
	 */
	async mediaUpload(bytes: Uint8Array, filename: string, mime: string, alt?: string, opts: { caption?: string; fieldId?: string; folderId?: string } = {}): Promise<MediaItem> {
		const form = new FormData();
		form.append("file", new Blob([bytes as BlobPart], { type: mime }), filename);
		if (alt) form.append("alt", alt);
		if (opts.caption) form.append("caption", opts.caption);
		if (opts.fieldId) form.append("fieldId", opts.fieldId);
		if (opts.folderId) form.append("folderId", opts.folderId);
		return (await this.request<{ item: MediaItem }>("POST", "/media", form)).item;
	}
	/** PUT /media/{id}: here only `folderId` (mediaUpdateBody; null or "unfiled" = Main library). */
	async mediaSetFolder(id: string, folderId: string | null): Promise<MediaItem> {
		return (await this.request<{ item: MediaItem }>("PUT", `/media/${encodeURIComponent(id)}`, { folderId })).item;
	}
	/** GET /media/folders (flat; cursor-paged). */
	async mediaFolders(): Promise<{ id: string; name: string }[]> {
		const out: { id: string; name: string }[] = [];
		let cursor: string | undefined;
		do {
			const r = await this.request<{ items: { id: string; name: string }[]; nextCursor?: string }>("GET", `/media/folders?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
			out.push(...r.items);
			cursor = r.nextCursor;
		} while (cursor);
		return out;
	}
	/** POST /media/folders { name } (409 CONFLICT when the name exists, case-insensitively). */
	async createMediaFolder(name: string): Promise<{ id: string; name: string }> {
		return (await this.request<{ item: { id: string; name: string } }>("POST", "/media/folders", { name })).item;
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
	// ── invites (EmDash 1.5 POST /_emdash/api/auth/invite: admin user, token scope admin) ──
	/** Creates an invite. EmDash e-mails it when the site has an e-mail provider; otherwise it returns the link instead. */
	async invite(email: string, role: number): Promise<{ message?: string; inviteUrl?: string }> {
		return await this.request<{ message?: string; inviteUrl?: string }>("POST", "/auth/invite", { email, role });
	}
	// ── sections (EmDash 1.5 /_emdash/api/sections: GET content:read, WRITE content:write; role EDITOR for sections:manage) ──
	/** The section with this slug, or undefined when there is none (404). */
	async section(slug: string): Promise<{ id: string; slug: string; title: string; source?: string } | undefined> {
		try {
			return await this.request<{ id: string; slug: string; title: string; source?: string }>("GET", `/sections/${encodeURIComponent(slug)}`);
		} catch (e) {
			if (e instanceof EmDashHttpError && e.status === 404) return undefined;
			throw e;
		}
	}
	async createSection(input: { slug: string; title: string; description?: string; content: unknown[]; source: "import" }): Promise<void> {
		await this.request("POST", "/sections", input);
	}
	async updateSection(slug: string, input: { title?: string; description?: string; content?: unknown[] }): Promise<void> {
		await this.request("PUT", `/sections/${encodeURIComponent(slug)}`, input);
	}
	// ── widget areas (EmDash 1.5 /_emdash/api/widget-areas: GET content:read, WRITE content:write + widgets:manage role) ──
	async widgetAreas(): Promise<{ name: string; widgets?: unknown[] }[]> {
		return (await this.request<{ items: { name: string; widgets?: unknown[] }[] }>("GET", "/widget-areas")).items;
	}
	async createWidgetArea(input: { name: string; label: string; description?: string }): Promise<void> {
		await this.request("POST", "/widget-areas", input);
	}
	async deleteWidgetArea(name: string): Promise<void> {
		await this.request("DELETE", `/widget-areas/${encodeURIComponent(name)}`);
	}
	async createWidget(area: string, widget: { type: string; title?: string; content?: unknown[]; menuName?: string; componentId?: string; componentProps?: Record<string, unknown> }): Promise<void> {
		await this.request("POST", `/widget-areas/${encodeURIComponent(area)}/widgets`, widget);
	}

	// ── search (fields marked searchable + POST /search/enable, admin scope) ──
	async collectionFields(collection: string): Promise<{ slug: string; type: string; searchable?: boolean; validation?: unknown }[]> {
		const r = await this.request<{ item?: { fields?: { slug: string; type: string; searchable?: boolean; validation?: unknown }[] }; fields?: never[] }>("GET", `/schema/collections/${encodeURIComponent(collection)}?includeFields=true`);
		return r.item?.fields ?? r.fields ?? [];
	}
	/** `validation` is required by the field update body (nullable): the field's own value is sent back unchanged. */
	async updateField(collection: string, field: string, input: { searchable?: boolean; validation: unknown }): Promise<void> {
		await this.request("PUT", `/schema/collections/${encodeURIComponent(collection)}/fields/${encodeURIComponent(field)}`, input);
	}
	/** Collections with full-text search on (GET /search/stats, admin scope). */
	async searchStats(): Promise<Record<string, { indexed: number }>> {
		return (await this.request<{ collections?: Record<string, { indexed: number }> }>("GET", "/search/stats")).collections ?? {};
	}
	async enableSearch(collection: string): Promise<void> {
		await this.request("POST", "/search/enable", { collection, enabled: true });
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
	children?: EmDashTerm[];
}

export function flattenTerms(terms: EmDashTerm[]): EmDashTerm[] {
	return terms.flatMap(({ children, ...t }) => [t, ...flattenTerms(children ?? [])]);
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
