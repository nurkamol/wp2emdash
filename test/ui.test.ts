import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readState } from "../src/core/state.js";
import { appendVisualDecision, portfolio, readiness, visualDecisions, visualReport } from "../src/ui/data.js";
import { csrfFor, resolveServable, startUiServer, type UiServer } from "../src/ui/server.js";

const FIXTURE = new URL("./fixtures/ui/sites", import.meta.url).pathname;

let dir: string;
let ui: UiServer;
let cookie: string;
const base = () => `http://127.0.0.1:${ui.port}`;

/** Raw request, so the path is sent exactly as written (fetch would normalise `..`) and Host can be set. */
function raw(path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
	return new Promise((ok, fail) => {
		const req = request({ host: "127.0.0.1", port: ui.port, path, headers: { Cookie: cookie, ...headers } }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c: Buffer) => chunks.push(c));
			res.on("end", () => ok({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", fail);
		req.end();
	});
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "wp2emdash-ui-"));
	cpSync(FIXTURE, dir, { recursive: true });
	// A symlink inside reports/ that points outside it must not be served.
	symlinkSync(join(dir, "demo", "ACCESS.md"), join(dir, "demo", "reports", "verify", "screens", "mobile", "leak.png"));
	ui = await startUiServer({ sitesDir: dir, token: "test-token-0123456789", pollMs: 30 });
	const res = await fetch(`${base()}/?t=test-token-0123456789`, { redirect: "manual" });
	cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
});

afterAll(async () => {
	await ui?.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("dashboard auth", () => {
	it("binds to 127.0.0.1 and refuses requests without the token", async () => {
		expect(ui.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/\?t=/);
		expect((await fetch(`${base()}/`)).status).toBe(401);
		expect((await fetch(`${base()}/api/portfolio`)).status).toBe(401);
		expect((await fetch(`${base()}/files/demo/reports/verify/diff/mobile/home.png`)).status).toBe(401);
		expect((await fetch(`${base()}/?t=wrong`, { redirect: "manual" })).status).toBe(401);
		expect((await fetch(`${base()}/api/portfolio`, { headers: { Cookie: `wp2emdash_ui_${ui.port}=wrong-token-0123456789` } })).status).toBe(401);
	});

	it("exchanges ?t= for an HttpOnly SameSite=Strict cookie and redirects without the token", async () => {
		const res = await fetch(`${base()}/?t=test-token-0123456789`, { redirect: "manual" });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/");
		const set = res.headers.get("set-cookie") ?? "";
		expect(set).toContain("HttpOnly");
		expect(set).toContain("SameSite=Strict");
		const page = await fetch(`${base()}/`, { headers: { Cookie: cookie } });
		expect(page.status).toBe(200);
		expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
		expect(await page.text()).toContain('<script src="/app.js"');
	});

	it("refuses a foreign Host header (DNS rebinding)", async () => {
		expect((await raw("/api/portfolio", { Host: "evil.example" })).status).toBe(421);
	});
});

describe("report files", () => {
	it("serves screenshots from reports/ and snapshot/screens/", async () => {
		const a = await fetch(`${base()}/files/demo/reports/verify/diff/mobile/home.png`, { headers: { Cookie: cookie } });
		expect(a.status).toBe(200);
		expect(a.headers.get("content-type")).toBe("image/png");
		expect((await fetch(`${base()}/files/demo/snapshot/screens/mobile/home.png`, { headers: { Cookie: cookie } })).status).toBe(200);
	});

	it("refuses path traversal, files outside the allowed roots, non-images and symlinks out", async () => {
		for (const p of [
			"/files/demo/reports/../ACCESS.md",
			"/files/demo/reports/%2e%2e/ACCESS.md",
			"/files/demo/reports/..%2FACCESS.md",
			"/files/demo/reports/verify/..%5c..%5cACCESS.md",
			"/files/demo/ACCESS.md",
			"/files/demo/kit.config.ts",
			"/files/demo/state.json",
			"/files/demo/reports/verify/verify.json",
			"/files/demo/reports/verify/screens/mobile/leak.png",
			"/files/../demo/ACCESS.md",
			"/files/%2e%2e/demo/ACCESS.md",
			"/files/nosuchsite/reports/x.png",
			"/files/demo/snapshot/pages/home.json",
		]) {
			const r = await raw(p);
			expect([403, 404], p).toContain(r.status);
			expect(r.body, p).not.toContain("must never be served");
		}
		const root = join(dir, "demo");
		expect(resolveServable(root, "reports/../ACCESS.md")).toBeUndefined();
		expect(resolveServable(root, "/etc/passwd")).toBeUndefined();
		expect(resolveServable(root, "reports/verify/screens/mobile/leak.png")).toBeUndefined();
		expect(resolveServable(root, "reports/verify/diff/mobile/home.png")).toMatch(/home\.png$/);
	});
});

describe("portfolio and readiness", () => {
	it("lists every site with timeline, next phase, blockers and last run", async () => {
		const res = await fetch(`${base()}/api/portfolio`, { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);
		const sites = (await res.json()) as Awaited<ReturnType<typeof portfolio>>;
		expect(sites.map((s) => s.slug)).toEqual(["beta", "demo"]);
		const demo = sites.find((s) => s.slug === "demo");
		expect(demo?.name).toBe("Demo Clinic");
		expect(demo?.next).toBe("verify");
		expect(demo?.phases.map((p) => p.status)).toEqual(["passed", "passed", "passed", "accepted", "passed", "passed", "failed", "pending"]);
		expect(demo?.lastRun).toMatchObject({ runId: "2026-01-02T11-00-00-000Z", phase: "cutover", ok: false, finished: true, preview: true });
		expect(demo?.readiness.score).toBe(64);
		const beta = sites.find((s) => s.slug === "beta");
		expect(beta?.next).toBe("init");
		expect(beta?.readiness.score).toBe(0);
	});

	it("scores from gates, verify.json checks and the cutover preflight", () => {
		const r = readiness("demo", dir);
		// 7 gates (6 passed/accepted) + 2 verify checks (1 ok) + 2 preflight failures from the run log = 7/11
		expect(r.total).toBe(11);
		expect(r.passed).toBe(7);
		expect(r.score).toBe(64);
		expect(r.items.find((i) => i.id === "gate:transform")).toMatchObject({ ok: true, accepted: true });
		expect(r.sources).toMatchObject({ preflight: "run-log", preflightRunId: "2026-01-02T11-00-00-000Z", verifyTarget: "staging" });
		expect(r.blockers.map((b) => b.label)).toEqual([
			"verify gate — Verify against baseline",
			"Visual difference within 3%",
			"Last verify run passed (failures only if the owner accepted them)",
			"Go-live token present",
		]);
		expect(r.blockers.find((b) => b.id === "verify:visual")?.fix).toBe("#/site/demo/visual");
		expect(r.blockers.find((b) => b.label === "Go-live token present")?.detail).toBe("CLOUDFLARE_GOLIVE_TOKEN not set");
	});

	it("rejects unknown sites", async () => {
		expect((await fetch(`${base()}/api/sites/nope`, { headers: { Cookie: cookie } })).status).toBe(404);
		expect((await fetch(`${base()}/api/sites/..%2Fdemo`, { headers: { Cookie: cookie } })).status).toBe(404);
	});
});

describe("visual diff viewer", () => {
	it("maps verify.json to page × viewport views with served image URLs", async () => {
		const v = await visualReport("demo", dir);
		expect(v.available).toBe(true);
		expect(v.visualLimit).toBe(0.03);
		const home = v.pages.find((p) => p.name === "home");
		const m = home?.viewports[0];
		expect(m).toMatchObject({ viewport: "mobile", over: true });
		expect(m?.images).toEqual({
			source: "/files/demo/snapshot/screens/mobile/home.png",
			target: "/files/demo/reports/verify/screens/mobile/home.png",
			diff: "/files/demo/reports/verify/diff/mobile/home.png",
		});
		// Absolute paths from another machine are re-rooted under this site's reports/verify/.
		expect(m?.sections[0]?.images?.diff).toBe("/files/demo/reports/verify/sections/mobile/home/00-diff.png");
		// Missing screenshots are reported as missing, not linked.
		expect(v.pages.find((p) => p.name === "about")?.viewports[0]?.images.target).toBeUndefined();
		expect(v.verifyGate.acceptCommand).toBe('pnpm wp2emdash accept demo verify --reason "<the owner\'s reason>" --by "<owner name>"');
	});

	it("appends approve/reject decisions to decisions.md without accepting the gate", async () => {
		const before = readFileSync(join(dir, "demo", "decisions.md"), "utf8");
		const post = (body: unknown, headers: Record<string, string> = {}) =>
			fetch(`${base()}/api/sites/demo/visual-decisions`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", Origin: base(), "X-WP2EMDASH-CSRF": csrfFor("test-token-0123456789"), ...headers }, body: JSON.stringify(body) });

		const ok = await post({ path: "/", viewport: "mobile", decision: "approve", reason: "Owner: new hero | photo is fine\nas is", by: "Jane Owner" });
		expect(ok.status).toBe(200);
		const text = readFileSync(join(dir, "demo", "decisions.md"), "utf8");
		expect(text.startsWith(before)).toBe(true);
		const row = text.slice(before.length);
		expect(row).toMatch(/^\| \d{4}-\d{2}-\d{2} \| verify \| Visual difference approved: \/ @ mobile \(12\.0%, verify 2026-01-02T10:00:04\.000Z\) \| Owner: new hero \\\| photo is fine as is \| Jane Owner \|\n$/);
		expect(visualDecisions("demo", dir)).toEqual([expect.objectContaining({ decision: "approved", path: "/", viewport: "mobile", reason: "Owner: new hero | photo is fine as is", by: "Jane Owner" })]);
		expect((await visualReport("demo", dir)).pages[0]?.viewports[0]?.decision?.decision).toBe("approved");
		// The gate is untouched: accepting stays `wp2emdash accept` with the owner's reason.
		expect(readState(join(dir, "demo", "state.json")).phases.verify?.status).toBe("failed");

		await appendVisualDecision("demo", { path: "/", viewport: "mobile", decision: "reject", reason: "Hero spacing must match the old site", by: "Jane Owner" }, dir);
		expect((await visualReport("demo", dir)).pages[0]?.viewports[0]?.decision?.decision).toBe("rejected");

		expect((await post({ path: "/", viewport: "mobile", decision: "approve", reason: "short", by: "x" })).status).toBe(400);
		expect((await post({ path: "/nope", viewport: "mobile", decision: "approve", reason: "a long enough reason", by: "x" })).status).toBe(400);
		expect((await post({ path: "/", viewport: "mobile", decision: "accept-gate", reason: "a long enough reason", by: "x" })).status).toBe(400);
		expect((await post({ path: "/", viewport: "mobile", decision: "approve", reason: "a long enough reason", by: "x" }, { Origin: "http://evil.example" })).status).toBe(403);
		const noCookie = await fetch(`${base()}/api/sites/demo/visual-decisions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
		expect(noCookie.status).toBe(401);
		expect(visualDecisions("demo", dir)).toHaveLength(2);
	});
});

describe("live progress (server-sent events)", () => {
	it("streams existing run events, then lines appended while connected", async () => {
		const runId = "2026-01-02T10-00-00-000Z";
		const ctrl = new AbortController();
		const res = await fetch(`${base()}/api/sites/demo/runs/${runId}/stream`, { headers: { Cookie: cookie }, signal: ctrl.signal });
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		const dec = new TextDecoder();
		let buf = "";
		const until = async (needle: string) => {
			const deadline = Date.now() + 5000;
			while (!buf.includes(needle)) {
				if (Date.now() > deadline) throw new Error(`timed out waiting for ${needle}`);
				const { value, done } = await reader.read();
				if (done) throw new Error("stream ended");
				buf += dec.decode(value, { stream: true });
			}
		};
		await until('"type":"phase:end"');
		expect(buf).toContain('event: progress\ndata: {"at":"2026-01-02T10:00:00.000Z","type":"phase:start","phase":"verify"}');

		// Half a line first: nothing is sent until the line is complete.
		const file = join(dir, "demo", "runs", `${runId}.jsonl`);
		appendFileSync(file, '{"at":"2026-01-02T10:05:00.000Z","type":"log","level":"info",');
		await new Promise((r) => setTimeout(r, 120));
		expect(buf).not.toContain("appended-marker");
		appendFileSync(file, '"message":"appended-marker"}\n');
		await until("appended-marker");
		expect(buf).toContain('data: {"at":"2026-01-02T10:05:00.000Z","type":"log","level":"info","message":"appended-marker"}');
		ctrl.abort();
		await reader.cancel().catch(() => {});
	});

	it("refuses unknown or malformed run ids", async () => {
		expect((await fetch(`${base()}/api/sites/demo/runs/nope/stream`, { headers: { Cookie: cookie } })).status).toBe(404);
		expect((await raw("/api/sites/demo/runs/..%2F..%2Fstate/stream")).status).toBe(404);
	});
});

describe("fleet", () => {
	it("serves /api/fleet from local files (no network) behind the token", async () => {
		expect((await fetch(`${base()}/api/fleet`)).status).toBe(401);
		const res = await fetch(`${base()}/api/fleet`, { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);
		const sites = (await res.json()) as { slug: string; kit: { gap: { status: string } }; live?: unknown }[];
		expect(sites.map((s) => s.slug)).toEqual(["beta", "demo"]);
		expect(sites.every((s) => s.live === undefined && typeof s.kit.gap.status === "string")).toBe(true);
	});

	it("the page has a fleet route", () => {
		const js = readFileSync(new URL("../src/ui/assets/app.js", import.meta.url), "utf8");
		expect(js).toContain('if (parts[0] === "fleet") return fleetPage();');
		expect(js).toContain('api("/api/fleet")');
	});
});
