/**
 * @wp2emdash/change-requests: the status machine, who may do what, form and attachment validation, one-time download
 * links, emails and the signed webhook (gating, content, no secret leakage), retention, the Backups allowlist and the
 * kit side (kit.config, scaffold options, client docs). Synthetic data only; email, webhook and R2 are mocked.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { readSettingsRows } from "../packages/backups/src/export.js";
import { optionAllowed, settingsOf } from "../packages/backups/src/format.js";
import { changeRequestsPlugin, type ChangeRequestsOptions } from "../packages/change-requests/src/index.js";
import { REQUEST_OPTION_PREFIX } from "../packages/change-requests/src/meta.js";
import { type Actor, actorOf, allowedMoves, attachmentKey, canAttach, type ChangeRequest, checkAttachment, comment, expired, isAgency, isAttachmentKey, move, newRequest, safeFilename, validateNew } from "../packages/change-requests/src/model.js";
import { newRequestMail, signWebhook, statusMail, webhookPayload, webhookReady } from "../packages/change-requests/src/notify.js";
import { type Bucket, createPlugin, cronSchedule, type Deps, handleUpload } from "../packages/change-requests/src/plugin/index.js";
import { grant, listRequests, redeem } from "../packages/change-requests/src/store.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { changeRequestsDoc, changeRequestsGuide, changeRequestsOptions } from "../src/scaffold/change-requests.js";
import { d1, freshDb } from "./backups-fixtures.js";
import { memoryKv } from "./health-fixtures.js";

type B = Record<string, any>;
const ORIGIN = "https://acme.example";
const NOW = Date.parse("2026-11-20T12:00:00Z");
const SECRET = "whsec-SENTINEL-0123456789abcdef";
const PAGES = [{ collection: "pages", id: "01JPAGEAAAAAAAAAAAAAAAAAA1", title: "Contact" }];

const client: Actor = { role: 40, id: "u-client", email: "jane@acme.example", name: "Jane", agency: false };
const colleague: Actor = { role: 40, id: "u-other", email: "sam@acme.example", name: "Sam", agency: false };
const agency: Actor = { role: 50, id: "u-agency", email: "dev@agency.example", name: "Dev", agency: true };

const sample = (o: Partial<ChangeRequest> = {}): ChangeRequest => ({ ...newRequest({ title: "Update hours", description: "Saturday is now 9–13.", page: PAGES[0] ?? null, priority: "normal", contact: "email", notify: true }, client, { id: "0123456789abcdef", number: 1, now: NOW }), ...o });

// A PNG / PDF / fake header.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const PDF = new TextEncoder().encode("%PDF-1.7\n%…");
const HTML = new TextEncoder().encode("<html><script>alert(1)</script>");

describe("status machine and permissions", () => {
	it("agency moves; the requester withdraws, confirms done and reopens within 30 days; other editors only comment", () => {
		const r = sample();
		expect(allowedMoves(agency, r)).toEqual(["seen", "in_progress", "waiting", "done", "declined"]);
		expect(allowedMoves(client, r)).toEqual(["declined"]);
		expect(allowedMoves(colleague, r)).toEqual([]);
		expect(allowedMoves({ ...client, role: 30 }, r)).toEqual([]);
		const waiting = sample({ status: "waiting" });
		expect(allowedMoves(client, waiting)).toEqual(["done", "declined"]);
		const done = move(waiting, client, "done", undefined, NOW);
		expect(done.ok && done.request.closedAt).toBe(new Date(NOW).toISOString());
		const d = (done as { request: ChangeRequest }).request;
		expect(allowedMoves(client, d, NOW + 10 * 86400_000)).toEqual(["new"]);
		expect(allowedMoves(client, d, NOW + 31 * 86400_000)).toEqual([]);
		expect(allowedMoves(agency, d)).toEqual(["in_progress"]);
		const reopened = move(d, client, "new", undefined, NOW + 86400_000);
		expect(reopened.ok && reopened.request.closedAt).toBeUndefined();
		expect(move(r, colleague, "done", undefined, NOW)).toMatchObject({ ok: false });
		expect(move(r, client, "in_progress", undefined, NOW)).toMatchObject({ ok: false });
		const withdrawn = move(r, client, "declined", undefined, NOW);
		expect(withdrawn.ok && withdrawn.request.timeline.at(-1)).toMatchObject({ kind: "status", from: "new", to: "declined", reason: "withdrawn", agency: false });
	});
	it("a client-side comment on Waiting for you hands it back; closed requests take agency comments only", () => {
		const c = comment(sample({ status: "waiting" }), colleague, "Here is the new text.", NOW);
		expect(c.ok && c.request.status).toBe("in_progress");
		expect(c.ok && c.moved).toEqual({ from: "waiting", to: "in_progress" });
		expect(comment(sample({ status: "done" }), client, "x", NOW)).toMatchObject({ ok: false });
		expect(comment(sample({ status: "done" }), agency, "Fixed in the footer too.", NOW).ok).toBe(true);
		expect(comment(sample(), client, "   ", NOW)).toMatchObject({ ok: false });
	});
	it("agency = admins, narrowed by email domain when configured", () => {
		expect(isAgency({ role: 50, email: "a@client.example" })).toBe(true);
		expect(isAgency({ role: 40, email: "a@agency.example" }, ["agency.example"])).toBe(false);
		expect(isAgency({ role: 50, email: "a@client.example" }, ["agency.example"])).toBe(false);
		expect(isAgency({ role: 50, email: "a@Agency.example" }, ["@agency.example"])).toBe(true);
		expect(actorOf({ role: 40, email: "x@y.example", name: null }).name).toBe("x");
	});
});

describe("validation", () => {
	it("the form: required fields, length limits, page from the list only, safe defaults", () => {
		expect(validateNew({}, PAGES)).toMatchObject({ ok: false, errors: ["Give the request a short title.", "Describe the change."] });
		expect(validateNew({ title: "T", description: "D", page: "pages:not-a-page" }, PAGES)).toMatchObject({ ok: false });
		const long = validateNew({ title: `${"x".repeat(300)}\u0000`, description: "d".repeat(5000), page: "pages:01JPAGEAAAAAAAAAAAAAAAAAA1" }, PAGES);
		expect(long.ok).toBe(false);
		const ok = validateNew({ title: "  Hours\n", description: "Line 1\r\nLine 2\u0007", page: "anywhere", priority: "critical", contact: "pigeon" }, PAGES);
		expect(ok).toMatchObject({ ok: true, value: { title: "Hours", description: "Line 1\nLine 2", page: null, priority: "normal", contact: "admin", notify: true } });
		expect(validateNew({ title: "x".repeat(300), description: "D", page: "pages:01JPAGEAAAAAAAAAAAAAAAAAA1" }, PAGES)).toMatchObject({ ok: true, value: { page: PAGES[0] } });
	});
	it("attachments: real type from the first bytes, size limit, safe names and keys", () => {
		expect(checkAttachment("shot.png", PNG)).toEqual({ ok: true, type: "image/png", name: "shot.png" });
		expect(checkAttachment("brief.pdf", PDF)).toMatchObject({ ok: true, type: "application/pdf" });
		expect(checkAttachment("evil.png", HTML)).toMatchObject({ ok: false });
		expect(checkAttachment("x.svg", new TextEncoder().encode("<svg onload=alert(1)>"))).toMatchObject({ ok: false });
		expect(checkAttachment("empty.png", new Uint8Array())).toMatchObject({ ok: false });
		const big = new Uint8Array(5 * 1024 * 1024 + 1);
		big.set(PNG);
		expect(checkAttachment("big.png", big)).toMatchObject({ ok: false });
		// A JPEG called .png keeps its real type; paths and odd characters go.
		expect(checkAttachment("../../etc/passwd.png", new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toEqual({ ok: true, type: "image/jpeg", name: "passwd.jpg" });
		expect(safeFilename("Café menu ✨ <b>.pdf", "pdf")).toBe("Cafe menu b.pdf");
		expect(safeFilename("", "png")).toBe("attachment.png");
		const k = attachmentKey("0123456789abcdef", "fedcba9876543210", "shot.png");
		expect(k).toBe("backups/change-requests/0123456789abcdef/fedcba9876543210-shot.png");
		expect(isAttachmentKey(k)).toBe(true);
		expect(isAttachmentKey("site/logo.png")).toBe(false);
		expect(isAttachmentKey("backups/change-requests/0123456789abcdef/../../x")).toBe(false);
		expect(canAttach(colleague, sample({ attachments: [1, 2, 3].map((n) => ({ id: `${n}`, name: "a", type: "image/png", size: 1, key: "k", at: "", by: "" })) }))).toBe(false);
		expect(canAttach(colleague, sample({ status: "done" }))).toBe(false);
	});
	it("one-time grants: redeemed once, expire, odd tokens refused", async () => {
		const kv = memoryKv();
		const t = await grant(kv, "dl", { request: "r", att: "a" }, 60_000, NOW);
		expect(await redeem(kv, "dl", t, NOW + 1000)).toMatchObject({ request: "r", att: "a" });
		expect(await redeem(kv, "dl", t, NOW + 1000)).toBeUndefined();
		const late = await grant(kv, "dl", { request: "r", att: "a" }, 60_000, NOW);
		expect(await redeem(kv, "dl", late, NOW + 61_000)).toBeUndefined();
		expect(await redeem(kv, "dl", "../x", NOW)).toBeUndefined();
	});
	it("retention: closed requests older than the limit; open ones never", () => {
		const old = sample({ status: "done", closedAt: "2025-10-01T00:00:00Z" });
		const recent = sample({ id: "1111111111111111", status: "declined", closedAt: "2026-06-01T00:00:00Z" });
		const ancientOpen = sample({ id: "2222222222222222", status: "waiting", updatedAt: "2020-01-01T00:00:00Z" });
		expect(expired([old, recent, ancientOpen], 12, NOW).map((r) => r.id)).toEqual([old.id]);
		expect(expired([old, recent, ancientOpen], 3, NOW).map((r) => r.id)).toEqual([old.id, recent.id]);
	});
});

describe("notifications", () => {
	it("emails hold the request and a link — not other content; reply-to only when the client asked for email", () => {
		const r = sample({ priority: "urgent" });
		const m = newRequestMail(r, { siteName: "Acme", link: `${ORIGIN}/_emdash/admin/plugins/change-requests/requests/${r.id}`, footer: "Example Agency" });
		expect(m.subject).toBe("Acme: new change request URGENT · #1 Update hours");
		expect(m.text).toContain("Saturday is now 9–13.");
		expect(m.text).toContain("/requests/0123456789abcdef");
		expect(m.replyTo).toBe("jane@acme.example");
		expect(newRequestMail(sample({ contact: "admin" }), { siteName: "Acme", link: "l", footer: "f" }).replyTo).toBeUndefined();
		const evil = sample({ title: "<img src=x onerror=alert(1)>" });
		expect(newRequestMail(evil, { siteName: "Acme", link: "l", footer: "f" }).html).not.toContain("<img src=x");
		const s = statusMail(sample({ status: "waiting" }), { siteName: "Acme", link: "l", footer: "f", from: "in_progress", by: "Dev", note: "Which photo?" });
		expect(s.text).toContain("Waiting for you");
		expect(s.text).toContain("Which photo?");
	});
	it("webhook: https + secret required, never from staging, payload without the requester's email, verifiable signature", async () => {
		expect(webhookReady(undefined, {}, "S")).toMatchObject({ ok: false, reason: "not configured" });
		expect(webhookReady("http://hooks.example/x", { S: SECRET }, "S")).toMatchObject({ ok: false });
		expect(webhookReady("https://hooks.example/x", {}, "S")).toMatchObject({ ok: false });
		expect(webhookReady("https://hooks.example/x", { S: SECRET, STAGING: "1" }, "S")).toMatchObject({ ok: false });
		expect(webhookReady("https://hooks.example/x", { S: SECRET }, "S")).toMatchObject({ ok: true });
		const p = webhookPayload("request.created", sample(), { siteName: "Acme", siteUrl: ORIGIN, link: "l", at: "t", by: "Jane", agency: false });
		expect(JSON.stringify(p)).not.toContain("jane@acme.example");
		expect(p.request).toMatchObject({ number: 1, title: "Update hours", status: "new", requester: { name: "Jane" } });
		const sig = await signWebhook("key", "1700000000", '{"a":1}');
		const { createHmac } = await import("node:crypto");
		expect(sig).toBe(createHmac("sha256", "key").update('1700000000.{"a":1}').digest("hex"));
	});
});

// ── The plugin, end to end with mocks ───────────────────────────────────────────────────────────────────────────

function memoryBucket(): Bucket & { store: Map<string, Uint8Array> } {
	const store = new Map<string, Uint8Array>();
	return {
		store,
		async put(k, v) {
			store.set(k, v);
		},
		async get(k) {
			const v = store.get(k);
			return v ? { arrayBuffer: async () => v.slice().buffer } : null;
		},
		async delete(keys) {
			for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
		},
	};
}

function setup(o: Partial<ChangeRequestsOptions> = {}, envExtra: Record<string, unknown> = {}) {
	const kv = memoryKv();
	const bucket = memoryBucket();
	const sent: B[] = [];
	const hooks: { url: string; init: RequestInit }[] = [];
	const logs: unknown[] = [];
	let now = NOW;
	const env = { EMAIL_PROVIDER: "emdash", MEDIA: bucket, CHANGE_REQUESTS_WEBHOOK_SECRET: SECRET, ...envExtra };
	const deps: Deps = { env, fetch: async (url, init) => (hooks.push({ url, init }), new Response("ok")), now: () => now };
	const options: ChangeRequestsOptions = { productionUrl: ORIGIN, siteName: "Acme", agencyTo: ["team@agency.example"], webhook: "https://hooks.example/cr", ...o };
	const def = createPlugin(options, async () => deps) as B;
	const ctx = (user: B | undefined, input: unknown, extra: B = {}) => ({
		input,
		request: new Request(`${ORIGIN}/_emdash/api/plugins/change-requests/${extra.route ?? "admin"}${extra.query ?? ""}`, { method: "POST" }),
		user,
		kv,
		email: { send: async (m: B) => void sent.push(m) },
		content: {
			get: async (_c: string, id: string) => (id === PAGES[0]?.id ? { id, slug: "contact", status: "published", data: { title: "Contact" } } : null),
			list: async () => ({ items: [{ id: PAGES[0]?.id, slug: "contact", status: "published", data: { title: "Contact" } }], hasMore: false }),
		},
		log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) },
		...extra,
	});
	const admin = (user: B | undefined, input: unknown, extra: B = {}) => def.routes.admin.handler(ctx(user, input, extra));
	return { kv, bucket, sent, hooks, logs, def, ctx, admin, deps, options, setNow: (t: number) => (now = t) };
}
const U = { client: { role: 40, id: "u-client", email: "jane@acme.example", name: "Jane" }, other: { role: 40, id: "u-other", email: "sam@acme.example", name: "Sam" }, agency: { role: 50, id: "u-agency", email: "dev@agency.example", name: "Dev" }, author: { role: 30, id: "u-a", email: "a@acme.example", name: "A" } };
const create = { type: "form_submit", action_id: "create", values: { title: "Update hours", description: "Saturday is now 9–13.", page: `pages:${PAGES[0]?.id}`, priority: "urgent", contact: "email", notify: true } };
const text = (out: B) => JSON.stringify(out.blocks);

describe("plugin routes", () => {
	it("declares the page, widget and editor panel without a React admin.entry (which would switch the panel off)", () => {
		const s = setup();
		expect(s.def.admin).toMatchObject({ pages: [{ path: "/requests" }], widgets: [{ id: "change-requests" }], editorPanels: [{ id: "change-request", route: "panel", collections: ["pages"] }] });
		expect(s.def.admin.entry).toBeUndefined();
		expect(s.def.routes.admin.permission).toBe("content:edit_any");
		expect(s.def.routes.file).toMatchObject({ public: true, methods: ["GET"], response: "raw" });
		expect(s.def.routes.upload).toMatchObject({ methods: ["POST"], request: { body: "bytes", maxBytes: 5 * 1024 * 1024 } });
		const d = changeRequestsPlugin({ productionUrl: ORIGIN, siteName: "Acme", agencyTo: [] });
		expect(d).toMatchObject({ id: "change-requests", format: "native", entrypoint: "@wp2emdash/change-requests/plugin", adminEntry: "@wp2emdash/change-requests/admin" });
		expect(cronSchedule("acme.example")).toMatch(/^\d{1,2} [345] \* \* \*$/);
	});

	it("create → agency email + signed webhook; agency opens → Seen (no email); reply with Waiting → requester email", async () => {
		const s = setup();
		const out = await s.admin(U.client, create);
		expect(out.toast).toMatchObject({ message: "Request #1 sent." });
		const [r] = await listRequests(s.kv);
		expect(r).toMatchObject({ number: 1, status: "new", priority: "urgent", page: PAGES[0], requester: { name: "Jane", email: "jane@acme.example" } });
		expect(s.sent).toHaveLength(1);
		expect(s.sent[0]).toMatchObject({ to: "team@agency.example", replyTo: "jane@acme.example" });
		expect(s.sent[0]?.text).toContain(`${ORIGIN}/_emdash/admin/plugins/change-requests/requests/${r?.id}`);
		expect(s.hooks).toHaveLength(1);
		const h = s.hooks[0] as { url: string; init: { headers: Record<string, string>; body: string } };
		expect(h.url).toBe("https://hooks.example/cr");
		const { createHmac } = await import("node:crypto");
		expect(h.init.headers["x-change-request-signature"]).toBe(`sha256=${createHmac("sha256", SECRET).update(`${h.init.headers["x-change-request-timestamp"]}.${h.init.body}`).digest("hex")}`);
		expect(JSON.parse(h.init.body)).toMatchObject({ event: "request.created", request: { number: 1, priority: "urgent" } });

		// Editors other than the requester cannot move it; the agency opening it marks it Seen.
		const denied = await s.admin(U.other, { type: "form_submit", action_id: `reply:${r?.id}`, values: { status: "done", text: "" } });
		expect(text(denied)).toContain("You cannot move this request");
		await s.admin(U.agency, { type: "block_action", action_id: "open", value: r?.id });
		expect((await listRequests(s.kv))[0]?.status).toBe("seen");
		expect(s.sent).toHaveLength(1);
		expect(s.hooks).toHaveLength(2);

		await s.admin(U.agency, { type: "form_submit", action_id: `reply:${r?.id}`, values: { text: "Which Saturday — from when?", status: "waiting" } });
		expect(s.sent).toHaveLength(2);
		expect(s.sent[1]).toMatchObject({ to: "jane@acme.example" });
		expect(s.sent[1]?.text).toContain("Which Saturday");
		// The client answers: back to In progress, the agency hears about it.
		await s.admin(U.client, { type: "form_submit", action_id: `reply:${r?.id}`, values: { text: "From 1 December." } });
		expect((await listRequests(s.kv))[0]?.status).toBe("in_progress");
		expect(s.sent[2]).toMatchObject({ to: "team@agency.example" });
		// The requester switches update emails off: the agency's Done is not emailed.
		await s.admin(U.client, { type: "block_action", action_id: "mute", value: r?.id });
		await s.admin(U.agency, { type: "form_submit", action_id: `reply:${r?.id}`, values: { text: "", status: "done" } });
		expect(s.sent).toHaveLength(3);
		expect((await listRequests(s.kv))[0]?.status).toBe("done");
		// Delivery log: results only.
		const log = JSON.stringify(await s.kv.get("log"));
		expect(log).not.toContain("jane@acme.example");
		expect(log).not.toContain(SECRET);
	});

	it("staging sends nothing; without a secret the webhook is skipped; nothing ever leaks the secret", async () => {
		const st = setup({}, { STAGING: "1" });
		await st.admin(U.client, create);
		expect(st.sent).toHaveLength(0);
		expect(st.hooks).toHaveLength(0);
		const ns = setup({}, { CHANGE_REQUESTS_WEBHOOK_SECRET: undefined });
		await ns.admin(U.client, create);
		expect(ns.sent).toHaveLength(1);
		expect(ns.hooks).toHaveLength(0);
		const s = setup();
		await s.admin(U.client, create);
		const page = await s.admin(U.agency, { type: "page_load", page: "/requests" });
		const everything = JSON.stringify([[...s.kv.store.entries()], s.logs, s.sent, page, s.hooks.map((h) => h.init.body)]);
		expect(everything).not.toContain(SECRET);
		expect(text(page)).toContain("Delivery");
		expect(text(await s.admin(U.client, { type: "page_load", page: "/requests" }))).not.toContain("Delivery");
	});

	it("roles below editor see nothing; the widget counts open requests and shows the latest changes", async () => {
		const s = setup();
		expect(text(await s.admin(U.author, { type: "page_load", page: "/requests" }))).toContain("Editors and admins only");
		await s.admin(U.client, create);
		const w = await s.admin(U.client, { type: "page_load", page: "widget:change-requests" }, { ui: { surface: "dashboard-widget" } });
		expect(w.blocks[0]).toMatchObject({ type: "stats", items: [{ label: "Open requests", value: 1 }, { label: "Urgent", value: 1 }, { label: "Waiting for you", value: 0 }] });
		expect(text(w)).toContain("#1 Update hours");
	});

	it("deep link /requests/<id>, filters and validation errors keep what was typed", async () => {
		const s = setup();
		await s.admin(U.client, create);
		const [r] = await listRequests(s.kv);
		const deep = await s.admin(U.client, { type: "page_load", page: `/requests/${r?.id}` });
		expect(deep.blocks[0]).toMatchObject({ type: "header", text: "#1 Update hours" });
		const filtered = await s.admin(U.client, { type: "form_submit", action_id: "filter", values: { status: "done", priority: "any" } });
		expect(text(filtered)).toContain("No request matches this filter.");
		const bad = await s.admin(U.client, { type: "form_submit", action_id: "create", values: { title: "Only a title" } });
		expect(text(bad)).toContain("Describe the change.");
		expect(text(bad)).toContain("Only a title");
	});

	it("upload: checked bytes to backups/change-requests/, 3 at most; one-time download through the public file route", async () => {
		const s = setup();
		await s.admin(U.client, create);
		const [r] = await listRequests(s.kv);
		const up = (user: B, bytes: Uint8Array, name = "shot.png") => handleUpload(s.ctx(user, bytes, { route: "upload", query: `?request=${r?.id}&name=${encodeURIComponent(name)}` }) as never, s.options, s.deps, []);
		expect(await up(U.author, PNG)).toMatchObject({ ok: false });
		expect(await up(U.client, HTML, "x.png")).toMatchObject({ ok: false });
		expect(await up(U.client, PNG)).toMatchObject({ ok: true, attachments: 1 });
		expect(await up(U.other, PDF, "brief.pdf")).toMatchObject({ ok: true, attachments: 2 });
		expect(await up(U.agency, PNG, "mockup.png")).toMatchObject({ ok: true, attachments: 3 });
		expect(await up(U.client, PNG)).toMatchObject({ ok: false, message: "This request has 3 files already." });
		const keys = [...s.bucket.store.keys()];
		expect(keys).toHaveLength(3);
		for (const k of keys) expect(k.startsWith(`backups/change-requests/${r?.id}/`)).toBe(true);
		const cur = (await listRequests(s.kv))[0] as ChangeRequest;
		expect(cur.timeline.filter((e) => e.kind === "attachment").map((e) => e.text)).toEqual(["shot.png", "brief.pdf", "mockup.png"]);

		// Download: the admin action makes a one-time link; the public route serves it once, as a download.
		const att = cur.attachments[1];
		const out = await s.admin(U.other, { type: "block_action", action_id: "download", value: `${r?.id}|${att?.id}` });
		const url = new URL(JSON.stringify(out.blocks).match(/https:\/\/acme\.example\/_emdash\/api\/plugins\/change-requests\/file\?token=[0-9a-f]{48}/)?.[0] as string);
		const file = (q: string | null) => s.def.routes.file.handler(s.ctx(undefined, { token: q }, { route: "file" }));
		const first = await file(url.searchParams.get("token"));
		expect(first.status).toBe(200);
		expect(Object.fromEntries(first.headers)).toMatchObject({ "content-type": "application/pdf", "content-disposition": 'attachment; filename="brief.pdf"' });
		expect((await file(url.searchParams.get("token"))).status).toBe(410);
		expect((await file("deadbeef")).status).toBe(410);
	});

	it("the editor panel creates a request for this page; the upload page lists open requests it can add to", async () => {
		const s = setup();
		const pctx = (input: unknown) => s.ctx(U.client, input, { route: "panel", ui: { surface: "content-editor-panel", entry: { collection: "pages", id: PAGES[0]?.id } } });
		const first = await s.def.routes.panel.handler(pctx(undefined));
		expect(text(first)).toContain("Request this change");
		const out = await s.def.routes.panel.handler(pctx({ type: "form_submit", action_id: "panel-create", values: { title: "New photo", description: "Use the team photo.", urgent: true } }));
		expect(out.toast).toMatchObject({ message: "Request #1 sent." });
		expect((await listRequests(s.kv))[0]).toMatchObject({ page: { title: "Contact" }, priority: "urgent", contact: "admin" });
		const up = await s.def.routes.uploads.handler(s.ctx(U.client, {}, { route: "uploads" }));
		expect(up).toMatchObject({ requests: [{ number: 1, title: "New photo", attachments: 0 }], max: 3 });
		expect(up.selected).toBe(up.requests[0].id);
	});

	it("daily task: closed requests past the retention go with their files; open ones stay", async () => {
		const s = setup({ retentionMonths: 12 });
		await s.admin(U.client, create);
		await s.admin(U.client, { ...create, values: { ...create.values, title: "Second" } });
		const [a, b] = (await listRequests(s.kv)).sort((x, y) => x.number - y.number);
		await handleUpload(s.ctx(U.client, PNG, { route: "upload", query: `?request=${a?.id}&name=s.png` }) as never, s.options, s.deps, []);
		await s.admin(U.agency, { type: "form_submit", action_id: `reply:${a?.id}`, values: { status: "done" } });
		s.setNow(NOW + 400 * 86400_000);
		await s.def.hooks.cron.handler({ name: "daily" }, s.ctx(undefined, undefined));
		expect((await listRequests(s.kv)).map((r) => r.id)).toEqual([b?.id]);
		expect(s.bucket.store.size).toBe(0);
	});
});

describe("backups and kit wiring", () => {
	it("Backups copies the request rows — and no other row of the plugin, nor other plugin rows", async () => {
		const db: DatabaseSync = freshDb();
		const put = db.prepare("INSERT INTO options (name, value) VALUES (?, ?)");
		put.run(`${REQUEST_OPTION_PREFIX}0123456789abcdef`, JSON.stringify(sample()));
		put.run("plugin:change-requests:dl:abc", JSON.stringify({ request: "x", until: "y" }));
		put.run("plugin:change-requests:log", "[]");
		put.run("plugin:other:req:1", '"x"');
		const rows = await readSettingsRows(d1(db));
		const names = rows.map((r) => String(r.name));
		expect(names).toContain("plugin:change-requests:req:0123456789abcdef");
		expect(names.filter((n) => n.startsWith("plugin:"))).toEqual(["plugin:change-requests:req:0123456789abcdef"]);
		expect(optionAllowed("plugin:change-requests:req:x", JSON.stringify({ $emdash: "plugin-setting" }))).toBe(false);
		expect(Object.keys(settingsOf({ tables: { options: { columns: [], rows } } })).some((k) => k.includes("change-requests"))).toBe(false);
	});

	it("kit.config: on by default (agency = email.stagingTo), false turns it off, webhook must be https", () => {
		const base = { slug: "acme", name: "Acme", source: { url: ORIGIN }, target: { productionUrl: ORIGIN }, email: { to: ["owner@acme.example"], stagingTo: ["dev@agency.example"] } };
		const on = changeRequestsOptions({ config: kitConfigSchema.parse(base), productionUrl: ORIGIN, collections: ["pages"] });
		expect(on).toMatchObject({ productionUrl: ORIGIN, siteName: "Acme", agencyTo: ["dev@agency.example"], collections: ["pages"] });
		expect(on?.webhook).toBeUndefined();
		expect(changeRequestsOptions({ config: kitConfigSchema.parse({ ...base, changeRequests: false }), productionUrl: ORIGIN, collections: ["pages"] })).toBeUndefined();
		const custom = changeRequestsOptions({ config: kitConfigSchema.parse({ ...base, sensitiveData: true, changeRequests: { agencyTo: ["pm@agency.example"], agencyDomains: ["@Agency.example"], webhook: "https://hooks.zapier.com/x", retentionMonths: 6 } }), productionUrl: ORIGIN, collections: ["pages", "posts"] });
		expect(custom).toMatchObject({ agencyTo: ["pm@agency.example"], agencyDomains: ["agency.example"], webhook: "https://hooks.zapier.com/x", retentionMonths: 6, sensitive: true, collections: ["pages", "posts"] });
		expect(() => kitConfigSchema.parse({ ...base, changeRequests: { webhook: "http://hooks.example" } })).toThrow();
		expect(JSON.stringify(custom)).not.toMatch(/secret/i);
	});

	it("client docs: the guide section and docs/change-requests.md", () => {
		expect(changeRequestsGuide(undefined)).toBe("");
		expect(changeRequestsGuide({ retentionMonths: 12, webhook: false })).toContain("Plugins → Change requests");
		const doc = changeRequestsDoc({ retentionMonths: 12, webhook: true }, { sensitiveData: true });
		expect(doc).toContain("Waiting for you");
		expect(doc).toContain("12 months");
		expect(doc).toContain("project tracker");
		expect(doc).toContain("leave out personal information");
	});
});

vi.setConfig({ testTimeout: 10_000 });
