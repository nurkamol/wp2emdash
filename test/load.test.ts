import { afterEach, describe, expect, it, vi } from "vitest";
import { EmDashApi, EmDashHttpError } from "../src/targets/emdash/api.js";

const calls: { url: string; init: RequestInit }[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	calls.length = 0;
});

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
	vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
		calls.push({ url, init });
		return handler(url, init);
	});
}
const ok = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });

describe("EmDash REST client", () => {
	it("sends the API token, and CSRF headers only on mutations", async () => {
		stubFetch(() => ok({ item: { id: "1", slug: "a", status: "draft", data: {} } }));
		const api = new EmDashApi("https://staging.example.com/", { token: "t0k" });
		await api.get("pages", "1");
		await api.create("pages", { data: { title: "A" }, slug: "a" });
		const [get, post] = calls;
		const h = (c: (typeof calls)[number]) => c.init.headers as Record<string, string>;
		expect(get?.url).toBe("https://staging.example.com/_emdash/api/content/pages/1");
		expect(h(get as never).Authorization).toBe("Bearer t0k");
		expect(h(get as never)["X-EmDash-Request"]).toBeUndefined();
		expect(h(post as never)["X-EmDash-Request"]).toBe("1");
		expect(h(post as never).Origin).toBe("https://staging.example.com");
		expect(JSON.parse(String(post?.init.body))).toEqual({ data: { title: "A" }, slug: "a" });
	});

	it("logs in once with dev-bypass and forwards the session cookie", async () => {
		stubFetch((url) => (url.endsWith("/auth/dev-bypass") ? new Response(null, { status: 302, headers: { "set-cookie": "emdash_session=abc; Path=/; HttpOnly" } }) : ok({ items: [] })));
		const api = new EmDashApi("http://localhost:4399", { devBypass: true });
		await api.blockTypes();
		await api.collections();
		expect(calls.filter((c) => c.url.endsWith("/auth/dev-bypass"))).toHaveLength(1);
		expect((calls.at(-1)?.init.headers as Record<string, string>).Cookie).toBe("emdash_session=abc");
	});

	it("surfaces EmDash error codes", async () => {
		stubFetch(() => new Response(JSON.stringify({ error: { code: "VERSION_CONFLICT", message: "stale rev" } }), { status: 409 }));
		const api = new EmDashApi("https://s.example.com", { token: "x" });
		const err = await api.update("pages", "1", { data: {}, _rev: "old" }).catch((e) => e);
		expect(err).toBeInstanceOf(EmDashHttpError);
		expect(err).toMatchObject({ status: 409, code: "VERSION_CONFLICT" });
	});
});
