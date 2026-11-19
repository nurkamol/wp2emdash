import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyUnifiedDiff, listProposals, readProposal } from "../src/core/proposals.js";
import { checklistView, cockpitView, parseAccess } from "../src/ui/cockpit.js";
import { inspectorView, setElementOverride } from "../src/ui/inspector.js";
import { unifiedDiff } from "../src/ui/queue.js";
import { fingerprint, secretsStatus } from "../src/ui/secrets.js";
import { startUiServer, type UiServer } from "../src/ui/server.js";

const FIXTURE = new URL("./fixtures/ui/sites", import.meta.url).pathname;
const PENDING = "2026-01-03T09-00-00-000Z-a1b2c3";
const ENC_KEY = `emdash_enc_v1_${"A".repeat(43)}`;

let dir: string;
let ui: UiServer;
let cookie: string;
const runs: { slug: string; phase: string }[] = [];
const base = () => `http://127.0.0.1:${ui.port}`;
const get = (path: string) => fetch(`${base()}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(`${base()}${path}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "wp2emdash-ui2-"));
	cpSync(FIXTURE, dir, { recursive: true });
	ui = await startUiServer({
		sitesDir: dir,
		token: "test-token-0123456789",
		pollMs: 30,
		startRun: async (slug, phase) => {
			runs.push({ slug, phase });
			return { runId: "2026-01-03T10-00-00-000Z" };
		},
	});
	const res = await fetch(`${base()}/?t=test-token-0123456789`, { redirect: "manual" });
	cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
});

afterAll(async () => {
	await ui?.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("unified diff", () => {
	it("round-trips a generated diff and refuses one that no longer applies", () => {
		const before = readFileSync(join(FIXTURE, "demo", "overrides.ts"), "utf8");
		const after = setElementOverride(before, "home:vc_row[0]", "hero");
		const patch = unifiedDiff(before, after, "overrides.ts");
		expect(patch).toContain('+\t\t"home:vc_row[0]": "hero",');
		expect(applyUnifiedDiff(before, patch, "overrides.ts")).toBe(after);
		expect(() => applyUnifiedDiff(after, patch, "overrides.ts")).toThrow(/context mismatch/);
		expect(() => applyUnifiedDiff(before, patch.replace(/overrides\.ts/g, "../kit.config.ts"), "overrides.ts")).toThrow(/patch targets/);
		// A second entry goes into the existing block; the same key is replaced, not duplicated.
		const two = setElementOverride(setElementOverride(after, "home:vc_row[1]", "drop"), "home:vc_row[0]", "cards");
		expect(two.match(/home:vc_row\[0\]/g)).toHaveLength(1);
		expect(two).toContain('"home:vc_row[0]": "cards",');
		expect(two).toContain('"home:vc_row[1]": "drop",');
		// New file from /dev/null.
		expect(applyUnifiedDiff("", unifiedDiff("", "a\nb\n", "overrides.ts"), "overrides.ts")).toBe("a\nb\n");
	});
});

describe("approval queue", () => {
	it("lists proposals pending first with the rerun command", async () => {
		const res = await get("/api/sites/demo/proposals");
		expect(res.status).toBe(200);
		const list = (await res.json()) as { id: string; status: string; command?: string; previewable: boolean; patch: string }[];
		expect(list.map((p) => p.status)).toEqual(["pending", "rejected"]);
		expect(list[0]).toMatchObject({ id: PENDING, command: "pnpm wp2emdash run demo transform", previewable: true });
		expect(list[0]?.patch).toContain("home:vc_row[1]");
		const portfolio = (await (await get("/api/portfolio")).json()) as { slug: string; pendingProposals: number }[];
		expect(portfolio.find((s) => s.slug === "demo")?.pendingProposals).toBe(1);
	});

	it("needs the token and a same-origin request to decide", async () => {
		const noCookie = await fetch(`${base()}/api/sites/demo/proposals/${PENDING}/approve`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ by: "x" }) });
		expect(noCookie.status).toBe(401);
		expect((await post(`/api/sites/demo/proposals/${PENDING}/approve`, { by: "x" }, { Origin: "http://evil.example" })).status).toBe(403);
		expect((await post(`/api/sites/demo/proposals/${PENDING}/approve`, { by: "x" }, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
		const form = await fetch(`${base()}/api/sites/demo/proposals/${PENDING}/approve`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" }, body: "by=x" });
		expect(form.status).toBe(415);
		expect((await post("/api/sites/demo/proposals/..%2F..%2Fstate/approve", { by: "x" })).status).toBe(404);
		expect((await post("/api/sites/demo/proposals/nope/approve", { by: "x" })).status).toBe(400);
		expect((await post(`/api/sites/demo/proposals/${PENDING}/approve`, { by: "" })).status).toBe(400);
		expect(readProposal("demo", PENDING, dir)?.status).toBe("pending");
	});

	it("approve applies the patch to overrides.ts and starts a preview rerun when asked", async () => {
		const res = await post(`/api/sites/demo/proposals/${PENDING}/approve`, { by: "Jane Owner", note: "Looks right", rerun: true });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { proposal: { status: string; decidedBy: string; note: string }; run?: { phase: string; runId: string } };
		expect(body.proposal).toMatchObject({ status: "approved", decidedBy: "Jane Owner", note: "Looks right" });
		expect(body.run).toEqual({ phase: "transform", runId: "2026-01-03T10-00-00-000Z" });
		expect(runs).toEqual([{ slug: "demo", phase: "transform" }]);
		expect(readFileSync(join(dir, "demo", "overrides.ts"), "utf8")).toContain('"home:vc_row[1]": "text_block",');
		// Decided once only.
		expect((await post(`/api/sites/demo/proposals/${PENDING}/reject`, { by: "Jane Owner" })).status).toBe(400);
	});

	it("reject records the decision without touching files; a patch that does not apply fails", async () => {
		const pdir = join(dir, "demo", "proposals");
		const mk = (id: string, patch: string) =>
			writeFileSync(join(pdir, `${id}.json`), JSON.stringify({ id, createdAt: "2026-01-04T00:00:00.000Z", by: "claude", summary: "s", file: "decisions.md", patch, rerun: "load", status: "pending" }));
		mk("p-reject", "--- a/decisions.md\n+++ b/decisions.md\n@@ -1,1 +1,2 @@\n # Decisions\n+x\n");
		mk("p-stale", "--- a/decisions.md\n+++ b/decisions.md\n@@ -1,1 +1,2 @@\n # Not the first line\n+x\n");
		const decisions = readFileSync(join(dir, "demo", "decisions.md"), "utf8");
		const r = await post("/api/sites/demo/proposals/p-reject/reject", { by: "Jane Owner", note: "no" });
		expect(((await r.json()) as { proposal: { status: string } }).proposal.status).toBe("rejected");
		const s = await post("/api/sites/demo/proposals/p-stale/approve", { by: "Jane Owner", rerun: true });
		const sb = (await s.json()) as { proposal: { status: string; note: string }; run?: unknown };
		expect(sb.proposal.status).toBe("failed");
		expect(sb.proposal.note).toMatch(/did not apply/);
		expect(sb.run).toBeUndefined();
		expect(readFileSync(join(dir, "demo", "decisions.md"), "utf8")).toBe(decisions);
		expect(runs).toHaveLength(1);
	});
});

describe("secrets form", () => {
	const envFile = () => join(dir, "demo", ".env");

	it("writes an allow-listed key, keeps other lines, mode 600, and never returns the value", async () => {
		writeFileSync(envFile(), "# site secrets\nOTHER_KEY=keep-me\n\nEMDASH_TOKEN=old\n# trailing comment\nEMDASH_TOKEN=dup\n", { mode: 0o644 });
		const value = "ec_live_SECRET-VALUE-123";
		const res = await post("/api/sites/demo/secrets", { key: "EMDASH_TOKEN", value });
		const text = await res.text();
		expect(res.status).toBe(200);
		expect(text).not.toContain(value);
		expect(JSON.parse(text)).toEqual({ ok: true, key: "EMDASH_TOKEN", set: true, fingerprint: fingerprint(value) });
		expect(readFileSync(envFile(), "utf8")).toBe(`# site secrets\nOTHER_KEY=keep-me\n\nEMDASH_TOKEN=${value}\n# trailing comment\n`);
		expect(statSync(envFile()).mode & 0o777).toBe(0o600);

		const status = await get("/api/sites/demo/secrets");
		const st = await status.text();
		expect(st).not.toContain(value);
		expect(st).not.toContain("keep-me");
		const keys = (JSON.parse(st) as { keys: { key: string; set: boolean; fingerprint?: string }[] }).keys;
		expect(keys.find((k) => k.key === "EMDASH_TOKEN")).toMatchObject({ set: true, fingerprint: fingerprint(value) });
		expect(keys.find((k) => k.key === "OTHER_KEY")).toBeUndefined();
		expect(keys.find((k) => k.key === "EMAIL_API_KEY")).toMatchObject({ set: false });
	});

	it("appends a new key, quotes values with spaces, and validates known formats", async () => {
		expect((await post("/api/sites/demo/secrets", { key: "EMDASH_ENCRYPTION_KEY_STAGING", value: "emdash_enc_v1_short" })).status).toBe(400);
		expect((await post("/api/sites/demo/secrets", { key: "EMDASH_ENCRYPTION_KEY_STAGING", value: ENC_KEY })).status).toBe(200);
		expect((await post("/api/sites/demo/secrets", { key: "WP_APP_PASSWORD", value: "abcd efgh ijkl mnop qrst uvwx" })).status).toBe(200);
		expect((await post("/api/sites/demo/secrets", { key: "WP_APP_PASSWORD", value: "not a password" })).status).toBe(400);
		expect((await post("/api/sites/demo/secrets", { key: "EMDASH_WP_MIGRATION_KEY", value: "em1.garbage" })).status).toBe(400);
		const key = `em1.${Buffer.from(JSON.stringify({ v: 1, url: "https://demo.example", user: "u", pass: "p" })).toString("base64url")}`;
		expect((await post("/api/sites/demo/secrets", { key: "EMDASH_WP_MIGRATION_KEY", value: key })).status).toBe(200);
		const env = readFileSync(envFile(), "utf8");
		expect(env).toContain(`EMDASH_ENCRYPTION_KEY_STAGING=${ENC_KEY}\n`);
		expect(env).toContain("WP_APP_PASSWORD='abcd efgh ijkl mnop qrst uvwx'\n");
		expect(env).toContain(`EMDASH_WP_MIGRATION_KEY=${key}\n`);
		expect(env).toContain("OTHER_KEY=keep-me\n");
	});

	it("refuses unknown keys, CR/LF and control characters without echoing the value", async () => {
		const before = readFileSync(envFile(), "utf8");
		for (const body of [
			{ key: "CLOUDFLARE_API_TOKEN", value: "x".repeat(40) },
			{ key: "PATH", value: "/tmp" },
			{ key: "EMDASH_TOKEN", value: "abc\nINJECTED=1" },
			{ key: "EMDASH_TOKEN", value: "abc\rINJECTED=1" },
			{ key: "EMDASH_TOKEN", value: "abc\u0000def" },
			{ key: "EMDASH_TOKEN", value: "" },
			{ key: "EMDASH_TOKEN", value: "it's" },
			{ key: "EMDASH_TOKEN" },
		]) {
			const r = await post("/api/sites/demo/secrets", body);
			expect(r.status, JSON.stringify(body.key)).toBe(400);
			const t = await r.text();
			if (body.value) expect(t).not.toContain(body.value);
			expect(t).not.toContain("INJECTED");
		}
		expect(readFileSync(envFile(), "utf8")).toBe(before);
		expect((await fetch(`${base()}/api/sites/demo/secrets`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "EMDASH_TOKEN", value: "x" }) })).status).toBe(401);
		expect((await post("/api/sites/demo/secrets", { key: "EMDASH_TOKEN", value: "x" }, { Origin: "http://evil.example" })).status).toBe(403);
		expect((await post("/api/sites/nope/secrets", { key: "EMDASH_TOKEN", value: "x" })).status).toBe(404);
	});

	it("refuses a symlinked .env and reminds to revoke the app password after extract", async () => {
		const s = secretsStatus("demo", dir);
		expect(s.reminders.some((r) => r.includes("application password"))).toBe(true);
		const outside = join(dir, "outside.env");
		writeFileSync(outside, "");
		rmSync(join(dir, "beta", ".env"), { force: true });
		symlinkSync(outside, join(dir, "beta", ".env"));
		expect((await post("/api/sites/beta/secrets", { key: "EMDASH_TOKEN", value: "abc" })).status).toBe(400);
		expect(readFileSync(outside, "utf8")).toBe("");
		// beta has not run extract: no reminder.
		rmSync(join(dir, "beta", ".env"));
		writeFileSync(join(dir, "beta", ".env"), "WP_APP_PASSWORD=abcdabcdabcdabcdabcdabcd\n");
		expect(secretsStatus("beta", dir).reminders).toEqual([]);
	});
});

describe("section inspector", () => {
	it("maps row boxes to IR sections, raw WPBakery source and verify crops", async () => {
		const res = await get("/api/sites/demo/inspect/home/mobile");
		expect(res.status).toBe(200);
		const v = (await res.json()) as Awaited<ReturnType<typeof inspectorView>> & {};
		expect(v.sourceImage).toBe("/files/demo/snapshot/screens/mobile/home.png");
		expect(v.pageHeight).toBe(6);
		expect(v.page).toMatchObject({ path: "/", irFile: "ir/pages/home.json", builder: "wpbakery" });
		expect(v.regions.map((r) => [r.label, r.sections])).toEqual([
			["row 1", [0]],
			["row 2", [1, 2]],
			["footer row 1", [3]],
		]);
		expect(v.regions[0]?.verify).toMatchObject({ ratio: 0.12, over: true, images: { target: "/files/demo/reports/verify/sections/mobile/home/00-target.png" } });
		const intro = v.sections[1];
		expect(intro).toMatchObject({ type: "text_block", path: "vc_row[1]#0", overrideKey: "home:vc_row[1]" });
		// Row numbering skips the disabled row exactly like the adapter.
		expect(intro?.raw?.text).toBe('[vc_row el_class="intro"][vc_column][vc_column_text]<p>Synthetic intro text</p>[/vc_column_text][/vc_column][/vc_row]');
		expect(v.sections[0]?.raw?.text).toContain("<h1>Welcome</h1>");
		expect(v.sections[3]).toMatchObject({ footer: true, overrideKey: "site-footer:vc_row[0]" });
		// The approved proposal earlier set this row's override.
		expect(intro?.override).toBe("text_block");
		expect(v.sectionTypes).toContain("hero");
	});

	it("creates an overrides.ts proposal for a type change or drop, never editing files", async () => {
		const before = readFileSync(join(dir, "demo", "overrides.ts"), "utf8");
		const r = await post("/api/sites/demo/inspect/home/mobile/proposals", { section: 0, footer: false, action: "type", type: "media_text", by: "Jane Owner", note: "image left" });
		expect(r.status).toBe(200);
		const p = ((await r.json()) as { proposal: { id: string; file: string; rerun: string; status: string; patch: string; summary: string } }).proposal;
		expect(p).toMatchObject({ file: "overrides.ts", rerun: "transform", status: "pending" });
		expect(p.summary).toContain("home:vc_row[0]");
		expect(p.patch).toContain('+\t\t"home:vc_row[0]": "media_text",');
		expect(readFileSync(join(dir, "demo", "overrides.ts"), "utf8")).toBe(before);
		expect(applyUnifiedDiff(before, p.patch, "overrides.ts")).toContain('"home:vc_row[1]": "text_block",');

		const d = await post("/api/sites/demo/inspect/home/mobile/proposals", { section: 0, footer: true, action: "drop", by: "Jane Owner" });
		expect(((await d.json()) as { proposal: { patch: string } }).proposal.patch).toContain('"site-footer:vc_row[0]": "drop"');
		expect(listProposals("demo", dir).filter((x) => x.status === "pending")).toHaveLength(2);

		expect((await post("/api/sites/demo/inspect/home/mobile/proposals", { section: 0, action: "type", type: "<script>", by: "x" })).status).toBe(400);
		expect((await post("/api/sites/demo/inspect/home/mobile/proposals", { section: 99, action: "drop", by: "x" })).status).toBe(400);
		expect((await post("/api/sites/demo/inspect/home/mobile/proposals", { section: 1, action: "type", type: "text_block", by: "x" })).status).toBe(400);
		expect((await post("/api/sites/demo/inspect/home/mobile/proposals", { section: 0, action: "drop", by: "x" }, { Origin: "http://evil.example" })).status).toBe(403);
		expect((await get("/api/sites/demo/inspect/home/desktop")).status).toBe(404);
		expect((await get("/api/sites/demo/inspect/..%2F..%2Fetc/mobile")).status).toBe(404);
	});
});

describe("launch cockpit and owner checklist", () => {
	it("shows the last preflight, the runbook as text, prerequisites and commands — no switch", async () => {
		const res = await get("/api/sites/demo/cockpit");
		expect(res.status).toBe(200);
		const c = (await res.json()) as ReturnType<typeof cockpitView>;
		expect(c.preflight).toMatchObject({ source: "run-log", runId: "2026-01-02T11-00-00-000Z", ok: false, preview: true });
		expect(c.preflight.checks.map((x) => x.label)).toEqual(["Last verify run passed (failures only if the owner accepted them)", "Go-live token present"]);
		expect(c.runbook?.text).toContain("<b>not html</b>");
		expect(c.runbook?.path).toBe("sites/demo/cutover/runbook.md");
		expect(c.prerequisites.find((p) => p.id === "verify")?.ok).toBe(false);
		expect(c.prerequisites.find((p) => p.id === "access")).toMatchObject({ ok: false, detail: expect.stringContaining("2 open") });
		expect(c.commands.map((x) => x.command)).toContain("pnpm wp2emdash run demo cutover --preview");
		expect(c.note).toMatch(/owner from the terminal/);
		expect(JSON.stringify(c)).not.toMatch(/ec_live_SECRET/);
		// Read-only: there is no POST for the cockpit.
		expect((await post("/api/sites/demo/cockpit", {})).status).toBe(404);
	});

	it("renders ACCESS.md as sections with required markers and the plugin data section", async () => {
		const res = await get("/api/sites/demo/checklist");
		const c = (await res.json()) as ReturnType<typeof checklistView>;
		expect(c.sections.map((s) => s.heading)).toEqual(["Access & safety checklist — Demo Clinic (synthetic fixture)", "Before audit", "Before cutover", "Plugin data (before extract)"]);
		const plugin = c.sections[3];
		expect(plugin?.pluginData).toBe(true);
		expect(plugin?.items[0]).toEqual({ text: "Gravity Forms: Forms → Import/Export → Export Forms", done: false, required: true });
		expect(c.counts).toEqual({ done: 4, total: 8, requiredOpen: 1 });
		expect(parseAccess("<!-- x -->\n## A\n- [X] (Required) b")[0]?.items[0]).toEqual({ text: "b", done: true, required: true });
		expect(checklistView("beta", dir).available).toBe(false);
		expect(existsSync(join(dir, "beta", "ACCESS.md"))).toBe(false);
	});
});

describe("files stay out of reach", () => {
	it("never serves .env, proposals, ir or raw through /files", async () => {
		for (const p of ["/files/demo/.env", "/files/demo/proposals/" + PENDING + ".json", "/files/demo/ir/pages/home.json", "/files/demo/raw/exporter/content/page.json", "/files/demo/cutover/runbook.md", "/files/demo/overrides.ts"]) {
			expect([403, 404], p).toContain((await get(p)).status);
		}
		expect(readdirSync(join(dir, "demo", "proposals")).every((f) => f.endsWith(".json"))).toBe(true);
	});
});
