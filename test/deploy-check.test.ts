import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { DEPLOY_CHECK_SCRIPT, withDeployCheck } from "../src/scaffold/deploy-check.js";
import { withWarmup } from "../src/scaffold/perf.js";

const perf = (o: Record<string, unknown> = {}) => ({ ...kitConfigSchema.shape.performance.parse({}), ...o });

describe("deploy scripts", () => {
	it("are on by default and run after the warm-up, against the address each script deploys to", () => {
		const p = perf();
		expect(p.deployCheck).toBe(true);
		expect(p.rollback).toBe(true);
		const scripts = { "ci:deploy:production": "astro build && wrangler deploy", "ci:deploy:staging": "CLOUDFLARE_ENV=staging astro build && wrangler deploy", build: "astro build" };
		const urls = { production: "https://example.com/", staging: "https://x-staging.workers.dev" };
		const out = withDeployCheck(withWarmup(scripts, urls, p), urls, p);
		expect(out["ci:deploy:production"]).toBe("astro build && wrangler deploy && node scripts/warm.mjs https://example.com && node scripts/deploy-check.mjs https://example.com");
		expect(out["ci:deploy:staging"]).toMatch(/node scripts\/deploy-check\.mjs https:\/\/x-staging\.workers\.dev$/);
		expect(out.build).toBe("astro build");
		expect(withDeployCheck(scripts, urls, perf({ rollback: false }))["ci:deploy:production"]).toMatch(/--no-rollback$/);
		expect(withDeployCheck(scripts, urls, perf({ deployCheck: false }))).toEqual(scripts);
	});
});

// A fake live site and a fake `npx` (records the wrangler calls) — nothing reaches Cloudflare.
let server: Server | undefined;
let dir: string | undefined;
afterEach(() => {
	server?.close();
	if (dir) rmSync(dir, { recursive: true, force: true });
	server = dir = undefined;
});

async function run(o: { fontInCss: boolean; pageStatus?: number; args?: string[] }) {
	server = createServer((req, res) => {
		const u = req.url ?? "/";
		const html = (main: string) => `<!doctype html><title>T</title><link rel="stylesheet" href="/s.css"><main>${main}</main><footer>f</footer><img src="/hero.webp" fetchpriority="high">`;
		if (u === "/sitemap.xml") return res.writeHead(200, { "content-type": "application/xml" }).end(`<urlset><url><loc>http://${req.headers.host}/</loc></url><url><loc>http://${req.headers.host}/about/</loc></url></urlset>`);
		if (u === "/") return res.writeHead(200, { "content-type": "text/html" }).end(html("<h1>Home</h1>"));
		if (u === "/about/") return res.writeHead(o.pageStatus ?? 200, { "content-type": "text/html" }).end(html("<p>About</p>"));
		if (u === "/s.css") return res.writeHead(200, { "content-type": "text/css" }).end(o.fontInCss ? "@font-face{font-family:'Body Sans';src:url(/a.woff2)}@font-face{font-family:Show Serif;src:url(/b.woff2)}" : "@font-face{font-family:'Show Serif';src:url(/b.woff2)}");
		if (u === "/hero.webp") return res.writeHead(200, { "content-type": "image/webp" }).end("x");
		res.writeHead(404).end();
	});
	await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	dir = mkdtempSync(join(tmpdir(), "deploy-check-"));
	mkdirSync(join(dir, "scripts"));
	mkdirSync(join(dir, "src"));
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "scripts", "deploy-check.mjs"), DEPLOY_CHECK_SCRIPT);
	writeFileSync(join(dir, "src", "site.config.json"), JSON.stringify({ fonts: { body: "Body Sans", display: "Show Serif" } }));
	const log = join(dir, "npx.log");
	const deployments = JSON.stringify([
		{ created_on: "2026-01-01T00:00:00Z", versions: [{ version_id: "old-1" }] },
		{ created_on: "2026-01-02T00:00:00Z", versions: [{ version_id: "prev-2" }] },
		{ created_on: "2026-01-03T00:00:00Z", versions: [{ version_id: "new-3" }] },
	]);
	writeFileSync(join(dir, "bin", "npx"), `#!/bin/sh\necho "$@" >> "${log}"\ncase "$*" in *"deployments list"*) echo '${deployments}';; esac\nexit 0\n`);
	chmodSync(join(dir, "bin", "npx"), 0o755);
	const out = await new Promise<{ code: number; text: string }>((resolve) => {
		const p = spawn(process.execPath, [join(dir as string, "scripts", "deploy-check.mjs"), `http://127.0.0.1:${port}`, ...(o.args ?? [])], { env: { ...process.env, PATH: `${join(dir as string, "bin")}:${process.env.PATH}`, DEPLOY_ROLLBACK: "" } });
		let text = "";
		p.stdout.on("data", (d) => (text += d));
		p.stderr.on("data", (d) => (text += d));
		p.on("close", (code) => resolve({ code: code ?? -1, text }));
	});
	let calls = "";
	try {
		calls = readFileSync(log, "utf8");
	} catch {}
	return { ...out, calls };
}

describe("deploy check script", () => {
	it("passes a healthy site and never calls wrangler", async () => {
		const r = await run({ fontInCss: true });
		expect(r.code).toBe(0);
		expect(r.text).toContain("2 pages");
		expect(r.text).toContain("all good");
		expect(r.calls).toBe("");
	}, 30_000);
	it("a missing font fails the deploy and rolls back to the version live before", async () => {
		const r = await run({ fontInCss: false });
		expect(r.code).toBe(1);
		expect(r.text).toContain("font Body Sans is not in the site's stylesheets");
		expect(r.calls).toContain("--no-install wrangler deployments list --json");
		expect(r.calls).toMatch(/--no-install wrangler rollback prev-2 -y -m deploy check failed: font Body Sans/);
		expect(r.text).toContain("rolled back to prev-2");
	}, 30_000);
	it("a broken page fails; --no-rollback leaves the new version live", async () => {
		const r = await run({ fontInCss: true, pageStatus: 500, args: ["--no-rollback"] });
		expect(r.code).toBe(1);
		expect(r.text).toContain("/about/ answered 500");
		expect(r.text).toContain("rollback is off");
		expect(r.calls).toBe("");
	}, 60_000);
});
