/**
 * Test stand-in for `emdash` (installed only in generated projects): definePlugin returns its definition. The route
 * context is the part of EmDash's RouteContext the starter's plugins use; the real types are checked by `astro check`
 * in the generated project.
 */
interface RouteContext {
	input: unknown;
	user?: { id: string; role: number };
	log: { info(message: string, data?: Record<string, unknown>): void };
}
interface PluginDefinition {
	id: string;
	version: string;
	admin?: { pages?: { path: string; label: string; icon?: string }[] };
	routes?: Record<string, { permission?: string; public?: boolean; handler: (ctx: RouteContext) => Promise<unknown> }>;
}
export const definePlugin = <T extends PluginDefinition>(def: T): T => def;
