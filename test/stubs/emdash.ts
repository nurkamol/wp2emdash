/**
 * Test stand-in for `emdash` (installed only in generated projects): definePlugin returns its definition. The route
 * context is the part of EmDash's RouteContext the starter's plugins use; the real types are checked by `astro check`
 * in the generated project.
 */
export interface KvStub {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
}
interface PageContext {
	url: string;
	path?: string;
	siteUrl?: string;
	content?: { collection: string; id: string; slug?: string | null };
	title: string | null;
	pageTitle?: string | null;
	image?: string | null;
	seo?: { ogImage?: string | null; ogTitle?: string | null };
}
type Contribution = { kind: "property"; property: string; content: string } | { kind: "meta"; name: string; content: string };
interface RouteContext {
	input: unknown;
	kv: KvStub;
	request: Request;
	user?: { id: string; email: string; name: string | null; role: number };
	ui?: { surface: string };
	log: { info(message: string, data?: Record<string, unknown>): void };
}
interface Route {
	permission?: string;
	public?: boolean;
	methods?: string[];
	request?: { body: string; maxBytes?: number };
	response?: "json" | "raw";
	cacheControl?: string;
	handler: (ctx: RouteContext) => Promise<unknown>;
}
interface PluginDefinition {
	id: string;
	version: string;
	admin?: { pages?: { path: string; label: string; icon?: string }[]; widgets?: { id: string; title?: string; size?: string }[]; editorPanels?: { id: string; title: string; route: string; collections?: string[]; order?: number; draft?: { read?: { fields?: string[] }; patch?: { fields?: string[] } } }[]; settingsSchema?: Record<string, { type: string; label: string }> };
	capabilities?: string[];
	routes?: Record<string, Route>;
	hooks?: {
		/** A handler, or { priority, handler } (EmDash HookConfig: lower priority runs first, default 100). */
		"page:metadata"?: ((event: { page: PageContext }, ctx: { kv: KvStub }) => Promise<Contribution[] | null>) | { priority?: number; timeout?: number; handler: (event: { page: PageContext }, ctx: { kv: KvStub }) => Promise<Contribution[] | null> };
		"content:afterPublish"?: (event: { content: Record<string, unknown>; collection: string }, ctx: { kv: KvStub }) => Promise<void>;
		"plugin:install"?: (event: unknown, ctx: unknown) => Promise<void>;
		"plugin:activate"?: (event: unknown, ctx: unknown) => Promise<void>;
		/** EmDash's plugin cron hook: a handler, or { handler, timeout } (HookConfig). */
		cron?: ((event: { name: string; data?: Record<string, unknown>; scheduledAt?: string }, ctx: unknown) => Promise<void>) | { timeout?: number; handler: (event: { name: string; data?: Record<string, unknown>; scheduledAt?: string }, ctx: unknown) => Promise<void> };
	};
}
export const definePlugin = <T extends PluginDefinition>(def: T): T => def;
export interface PluginResponse {
	__emdashPluginResponse: true;
	status: number;
	headers: [string, string][];
	body: { kind: "text"; value: string } | { kind: "bytes"; value: Uint8Array } | null;
}
export function pluginResponse(init: { status?: number; headers?: Record<string, string>; body?: { kind: "text"; value: string } | { kind: "bytes"; value: Uint8Array } }): PluginResponse {
	return { __emdashPluginResponse: true, status: init.status ?? 200, headers: Object.entries(init.headers ?? {}), body: init.body ?? null };
}
/** EmDash invalidates its comment object cache after writing comments; tests count the calls. */
export const commentCacheInvalidations = { count: 0 };
export function invalidateCommentObjectCache(): void {
	commentCacheInvalidations.count++;
}
