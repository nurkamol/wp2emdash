import { beforeEach, describe, expect, it } from "vitest";
import { card, cardTitle, titleSize } from "../packages/og/src/card.js";
import { ogPlugin } from "../packages/og/src/index.js";
import { createPlugin } from "../packages/og/src/plugin/index.js";
import { b64url, fromB64url, sign, verify } from "../packages/og/src/sign.js";
import { ogColors } from "../src/scaffold/og.js";
import type { PluginResponse } from "../test/stubs/emdash.js";
import { env } from "../test/stubs/cloudflare-workers.js";

const options = { siteName: "Acme Clinic", domain: "acme.example", logo: "/brand/logo.svg", colors: { bg: "#f4ece2", text: "#191614", accent: "#ffac66", muted: "rgba(25, 22, 20, 0.62)" }, fonts: { display: "/fonts/og-display.ttf", body: "/fonts/og-body.ttf" } };
type C = { kind: string; property?: string; name?: string; content: string };
const plugin = createPlugin(options) as unknown as { hooks: { "page:metadata": (e: unknown, ctx: unknown) => Promise<C[] | null> }; routes: Record<string, { handler: (ctx: unknown) => Promise<unknown> }> };
function memKv() {
	const m = new Map<string, unknown>();
	return { m, get: async <T>(k: string) => (m.get(k) as T) ?? null, set: async (k: string, v: unknown) => void m.set(k, v) };
}
const page = (extra: Record<string, unknown> = {}) => ({ page: { url: "https://staging.acme.example/services/", title: "Services - Acme Clinic", pageTitle: "Services", ...extra } });
const tag = (cs: C[] | null, p: string) => cs?.find((c) => c.property === p || c.name === p)?.content;

describe("@wp2emdash/og card", () => {
	it("cleans titles and sizes them by length", () => {
		expect(cardTitle("Services - Acme Clinic", "Acme Clinic")).toBe("Services");
		expect(cardTitle("  Book   now | Acme Clinic ", "Acme Clinic")).toBe("Book now");
		expect(cardTitle("x".repeat(200), "S")).toHaveLength(118);
		expect(cardTitle("", "Acme Clinic")).toBe("Acme Clinic");
		expect(cardTitle("Frequently Asked Questions - Acme Clinic Springfield", "Acme Clinic")).toBe("Frequently Asked Questions");
		expect(cardTitle("Pilates - Strength - Recovery", "Acme Clinic")).toBe("Pilates - Strength - Recovery");
		expect([titleSize("short"), titleSize("x".repeat(50)), titleSize("x".repeat(80)), titleSize("x".repeat(100))]).toEqual([88, 76, 64, 56]);
	});
	it("lays out logo, domain, eyebrow, title and accent", () => {
		const tree = JSON.stringify(card({ title: "Services", eyebrow: "Acme Clinic", domain: "acme.example", logo: "data:image/svg+xml;base64,AA", colors: options.colors }));
		for (const s of ["Services", "Acme Clinic", "acme.example", "data:image/svg+xml", "#ffac66", "#f4ece2"]) expect(tree).toContain(s);
	});
	it("signs links and refuses tampering", async () => {
		const t = b64url("Ünïcode title ✓");
		expect(fromB64url(t)).toBe("Ünïcode title ✓");
		const sig = await sign("secret", `${t}.1`);
		expect(await verify("secret", `${t}.1`, sig)).toBe(true);
		expect(await verify("secret", `${t}.2`, sig)).toBe(false);
		expect(await verify("other", `${t}.1`, sig)).toBe(false);
	});
	it("descriptor and colours", () => {
		expect(ogPlugin(options)).toMatchObject({ id: "site-og", format: "native", entrypoint: "@wp2emdash/og/plugin", options });
		expect(ogColors("--color-bg: #fff;\n--color-text: #102030;\n--color-accent: #f60;")).toEqual({ bg: "#fff", text: "#102030", accent: "#f60", muted: "rgba(16, 32, 48, 0.62)" });
	});
});

describe("@wp2emdash/og plugin", () => {
	let kv: ReturnType<typeof memKv>;
	const r2 = new Map<string, Uint8Array>();
	beforeEach(() => {
		kv = memKv();
		r2.clear();
		for (const k of Object.keys(env)) delete env[k];
		const assets = { fetch: async (u: string) => new Response(String(u).endsWith(".svg") ? "<svg xmlns='http://www.w3.org/2000/svg'/>" : new Uint8Array([0, 1, 0, 0])) };
		Object.assign(env, { ASSETS: assets, MEDIA: { get: async (k: string) => (r2.has(k) ? { arrayBuffer: async () => (r2.get(k) as Uint8Array).buffer } : null), put: async (k: string, v: Uint8Array) => void r2.set(k, v) } });
	});
	it("gives pages without an image a signed card on the serving host", async () => {
		const cs = await plugin.hooks["page:metadata"](page(), { kv });
		const url = tag(cs, "og:image") as string;
		expect(url).toMatch(/^https:\/\/staging\.acme\.example\/_emdash\/api\/plugins\/site-og\/card\?t=[\w-]+&v=1&s=[0-9a-f]{32}$/);
		expect([tag(cs, "og:image:width"), tag(cs, "og:image:height"), tag(cs, "og:image:type"), tag(cs, "og:image:alt"), tag(cs, "twitter:image")]).toEqual(["1200", "630", "image/png", "Services", url]);
	});
	it("keeps a page's own image unless set to always", async () => {
		const own = page({ seo: { ogImage: "https://staging.acme.example/_emdash/api/media/file/x.webp" } });
		expect(tag(await plugin.hooks["page:metadata"](own, { kv }), "og:image")).toBeUndefined();
		await kv.set("settings", { mode: "always" });
		expect(tag(await plugin.hooks["page:metadata"](own, { kv }), "og:image")).toMatch(/\/card\?/);
	});
	it("renders only signed links, stores the card in R2 and serves it from there", async () => {
		const url = new URL(tag(await plugin.hooks["page:metadata"](page(), { kv }), "og:image") as string);
		const q = Object.fromEntries(url.searchParams);
		const req = new Request(url);
		const ok = (await plugin.routes.card?.handler({ input: q, kv, request: req })) as PluginResponse;
		expect(ok.status).toBe(200);
		expect(Object.fromEntries(ok.headers)["content-type"]).toBe("image/png");
		expect(r2.size).toBe(1);
		const again = (await plugin.routes.card?.handler({ input: q, kv, request: req })) as PluginResponse;
		expect(again.status).toBe(200);
		const forged = (await plugin.routes.card?.handler({ input: { ...q, t: b64url("Anything I like") }, kv, request: req })) as PluginResponse;
		expect(forged.status).toBe(404);
	});
	it("admin page saves settings and bumps the card version", async () => {
		const admin = (input: unknown) => plugin.routes.admin?.handler({ input, kv, user: { id: "u", email: "a@b.c", name: "A", role: 50 }, request: new Request("https://x/") }) as Promise<{ blocks: { type: string; url?: string }[] }>;
		const r = await admin({ type: "form_submit", action_id: "save", values: { enabled: true, mode: "always", eyebrow: "Clinic", showDomain: false, previewTitle: "Hello" } });
		expect(kv.m.get("settings")).toMatchObject({ mode: "always", eyebrow: "Clinic", showDomain: false, version: 2 });
		expect(r.blocks.find((b) => b.type === "image")?.url).toMatch(/v=2&s=/);
		expect((await admin({ type: "page_load" }) as unknown as { blocks: unknown[] }).blocks.length).toBeGreaterThan(3);
		const editor = (await plugin.routes.admin?.handler({ input: {}, kv, user: { id: "u", email: "", name: null, role: 40 }, request: new Request("https://x/") })) as { blocks: { title?: string }[] };
		expect(editor.blocks[0]?.title).toBe("Admins only");
	});
});
