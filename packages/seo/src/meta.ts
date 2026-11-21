/** Plugin identity, in its own module so Worker-side modules (analytics/store.ts) need not import the descriptor. */
export const SEO_PLUGIN = { id: "site-seo", version: "0.4.0" } as const;
