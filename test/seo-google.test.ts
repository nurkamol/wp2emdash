import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dateRange, parseServiceAccount, pickProperty, SCOPE, SearchConsole } from "../packages/seo/src/google.js";
import { submitIndexNow } from "../packages/seo/src/indexnow.js";
import { createPlugin } from "../packages/seo/src/plugin/index.js";

let pem = "";
let pub: CryptoKey;
beforeAll(async () => {
	const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
	const der = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n")}\n-----END PRIVATE KEY-----\n`;
	pub = pair.publicKey;
});
afterEach(() => vi.unstubAllGlobals());
const key = () => JSON.stringify({ type: "service_account", client_email: `seo-${Math.random().toString(36).slice(2)}@demo.iam.gserviceaccount.com`, private_key: pem });
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

describe("Search Console client", () => {
	it("rejects files that are not service account keys", () => {
		expect(() => parseServiceAccount("nope")).toThrow(/not a JSON key file/);
		expect(() => parseServiceAccount('{"type":"authorized_user"}')).toThrow(/not for a service account/);
		expect(() => parseServiceAccount('{"type":"service_account"}')).toThrow(/client_email or private_key/);
	});
	it("signs a valid RS256 token request, then calls the API with it", async () => {
		const sa = parseServiceAccount(key());
		const calls: { url: string; init?: RequestInit }[] = [];
		const f = vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			if (url.includes("oauth2")) return json({ access_token: "tok", expires_in: 3600 });
			return json({ rows: [{ keys: ["reformer pilates"], clicks: 5, impressions: 50, ctr: 0.1, position: 3.2 }] });
		}) as unknown as typeof fetch;
		const rows = await new SearchConsole(sa, f).analytics("sc-domain:acme.example", { startDate: "2026-01-01", endDate: "2026-01-28", dimensions: ["query"] });
		expect(rows[0]?.keys).toEqual(["reformer pilates"]);
		const assertion = new URLSearchParams(String(calls[0]?.init?.body)).get("assertion") as string;
		const [h, b, s] = assertion.split(".");
		expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, fromB64url(s as string), new TextEncoder().encode(`${h}.${b}`))).toBe(true);
		const claims = JSON.parse(new TextDecoder().decode(fromB64url(b as string)));
		expect(claims).toMatchObject({ iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token" });
		expect(claims.exp - claims.iat).toBe(3600);
		expect(calls[1]?.url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aacme.example/searchAnalytics/query");
		expect((calls[1]?.init?.headers as Record<string, string>).authorization).toBe("Bearer tok");
	});
	it("explains a 403 and picks the right property", async () => {
		const sa = parseServiceAccount(key());
		const f = vi.fn(async (url: string) => (url.includes("oauth2") ? json({ access_token: "t" }) : json({ error: { message: "User does not have sufficient permission" } }, 403))) as unknown as typeof fetch;
		await expect(new SearchConsole(sa, f).sitemaps("sc-domain:acme.example")).rejects.toThrow(/Add seo-.* as a user of the property/);
		expect(pickProperty([{ siteUrl: "https://www.acme.example/" }, { siteUrl: "sc-domain:acme.example" }], "https://acme.example")).toBe("sc-domain:acme.example");
		expect(pickProperty([{ siteUrl: "https://www.acme.example/" }], "https://acme.example")).toBe("https://www.acme.example/");
		expect(pickProperty([{ siteUrl: "sc-domain:other.example" }], "https://acme.example")).toBeUndefined();
		expect(dateRange(new Date("2026-03-31T10:00:00Z"))).toEqual({ startDate: "2026-03-02", endDate: "2026-03-29" });
	});
});

describe("IndexNow", () => {
	it("sends the domain's URLs with the key location and reads the answer", async () => {
		let body: Record<string, unknown> = {};
		const f = vi.fn(async (_u: string, init?: RequestInit) => {
			body = JSON.parse(String(init?.body));
			return new Response("", { status: 202 });
		}) as unknown as typeof fetch;
		const r = await submitIndexNow("https://acme.example", "abc123", ["https://acme.example/a/", "https://other.example/x/", "https://acme.example/a/"], f);
		expect(body).toEqual({ host: "acme.example", key: "abc123", keyLocation: "https://acme.example/abc123.txt", urlList: ["https://acme.example/a/"] });
		expect(r).toMatchObject({ urls: 1, status: 202, ok: true });
		const refused = await submitIndexNow("https://acme.example", "abc123", ["https://acme.example/"], vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch);
		expect(refused).toMatchObject({ ok: false, note: expect.stringMatching(/key not valid/) });
	});
});

describe("SEO plugin: IndexNow hook and Search Console connection", () => {
	const items = [{ id: "P1", slug: "home", status: "published", data: { title: "Home", content: [] }, seo: { description: "d".repeat(140) } }];
	const make = (live: boolean) => createPlugin({ productionUrl: "https://acme.example", indexNow: { key: "abc123", live } }) as unknown as { hooks: { "content:afterPublish": (e: unknown, c: unknown) => Promise<void> }; admin: { settingsSchema: Record<string, { type: string }> }; routes: { admin: { handler: (c: unknown) => Promise<{ blocks: Record<string, any>[]; toast?: { message: string } }> } } };
	const ctxFor = () => {
		const kv = new Map<string, unknown>();
		const settings = new Map<string, unknown>();
		return {
			kv,
			settings,
			ctx: (input: unknown) => ({
				input,
				request: new Request("https://acme.example/_emdash/api/plugins/site-seo/admin"),
				kv: { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: unknown) => void kv.set(k, v), delete: async (k: string) => kv.delete(k) },
				settings: { get: async (k: string) => settings.get(k) ?? null, set: async (k: string, v: unknown) => void settings.set(k, v), delete: async (k: string) => settings.delete(k) },
				content: { get: async () => items[0], list: async () => ({ items, hasMore: false }) },
				media: { get: async () => null },
				site: { name: "Acme" },
				log: { info: () => {} },
			}),
		};
	};
	const tab = (r: { blocks: Record<string, any>[] }, label: RegExp) => (r.blocks.find((b) => b.type === "tab")?.panels as { label: string; blocks: Record<string, any>[] }[]).find((p) => label.test(p.label))?.blocks ?? [];
	it("keeps the Search Console key in an encrypted setting", () => {
		expect(make(false).admin.settingsSchema.gscKey?.type).toBe("secret");
	});
	it("notifies IndexNow on publish only after go-live", async () => {
		const f = vi.fn(async () => new Response("", { status: 200 }));
		vi.stubGlobal("fetch", f);
		const { ctx, kv } = ctxFor();
		await make(false).hooks["content:afterPublish"]({ collection: "pages", content: { slug: "about" } }, ctx({}));
		expect(f).not.toHaveBeenCalled();
		await make(true).hooks["content:afterPublish"]({ collection: "pages", content: { slug: "about" } }, ctx({}));
		expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).urlList).toEqual(["https://acme.example/about/"]);
		expect((kv.get("indexnow:log") as { trigger: string; ok: boolean }[])[0]).toMatchObject({ trigger: "Published about", ok: true });
	});
	it("connects Search Console from the dashboard, shows the data, and disconnects", async () => {
		vi.stubGlobal("fetch", vi.fn(async (url: string) => {
			if (url.includes("oauth2")) return json({ access_token: "t", expires_in: 3600 });
			if (url.endsWith("/webmasters/v3/sites")) return json({ siteEntry: [{ siteUrl: "sc-domain:acme.example", permissionLevel: "siteFullUser" }] });
			if (url.includes("/searchAnalytics/")) return json({ rows: [{ keys: ["2026-01-01"], clicks: 3, impressions: 40, ctr: 0.075, position: 4.1 }] });
			if (url.includes("/sitemaps")) return json({ sitemap: [{ path: "https://acme.example/sitemap.xml", lastSubmitted: "2026-01-02T00:00:00Z" }] });
			if (url.endsWith(".txt")) return new Response("abc123");
			return new Response("<urlset></urlset>");
		}));
		const { ctx, settings } = ctxFor();
		const plugin = make(true);
		const before = await plugin.routes.admin.handler(ctx({ type: "page_load" }));
		expect(tab(before, /^Google/).find((b) => b.type === "form")?.fields[0].type).toBe("secret_input");
		const bad = await plugin.routes.admin.handler(ctx({ type: "form_submit", action_id: "gsc-connect", values: { key: "garbage" } }));
		expect(tab(bad, /^Google/)[0]).toMatchObject({ type: "banner", title: "Could not connect" });
		const k = key();
		const ok = await plugin.routes.admin.handler(ctx({ type: "form_submit", action_id: "gsc-connect", values: { key: k } }));
		expect(ok.toast?.message).toBe("Search Console connected.");
		expect(settings.get("gscKey")).toBe(k);
		const g = tab(ok, /^Google$/);
		expect(g.find((b) => b.type === "stats")?.items.map((x: { value: unknown }) => x.value)).toEqual([3, 40, "7.5%", "4.1"]);
		expect(JSON.stringify(ok)).not.toContain("PRIVATE KEY");
		expect(tab(ok, /^IndexNow$/)[1]).toMatchObject({ type: "banner", title: "Active" });
		const off = await plugin.routes.admin.handler(ctx({ type: "block_action", action_id: "gsc-disconnect" }));
		expect(settings.has("gscKey")).toBe(false);
		expect(off.toast?.message).toMatch(/disconnected/);
	});
});
