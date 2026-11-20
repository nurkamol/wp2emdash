/** Test stand-in for `cloudflare:workers`: tests put the bindings they need on `env`, and a purge function on `cache`. */
export const env: Record<string, unknown> = {};
export const cache: { purge?: (options: { tags?: string[] }) => Promise<{ success: boolean; errors: { code: number; message: string }[] }> } = {};
