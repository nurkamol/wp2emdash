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
	admin?: { pages?: { path: string; label: string; icon?: string }[]; widgets?: { id: string; title?: string; size?: string }[] };
	capabilities?: string[];
	routes?: Record<string, Route>;
	hooks?: { "page:metadata"?: (event: { page: PageContext }, ctx: { kv: KvStub }) => Promise<Contribution[] | null> };
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
