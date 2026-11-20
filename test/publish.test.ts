import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A fake git + gh: records every call; behaviour per test through `sim`. */
const sim = {
	calls: [] as string[],
	hasGit: false,
	origin: undefined as string | undefined,
	repoExists: false,
	visibility: "PRIVATE",
	files: [] as string[],
	staged: true,
	hasHead: false,
	ghSignedIn: true,
};
vi.mock("node:child_process", () => ({
	execFileSync: vi.fn((cmd: string, args: string[]) => {
		const line = `${cmd} ${args.join(" ")}`;
		sim.calls.push(line);
		const fail = () => {
			throw new Error(`exit 1: ${line}`);
		};
		if (cmd === "gh") {
			if (args[0] === "auth") return sim.ghSignedIn ? "" : fail();
			if (args[0] === "repo" && args[1] === "view") return sim.repoExists ? `acme/acme.example ${sim.visibility} https://github.com/acme/acme.example\n` : fail();
			if (args[0] === "repo" && args[1] === "create") return "https://github.com/acme/acme.example\n";
			if (args[0] === "variable") return "";
			return fail();
		}
		if (cmd === "git") {
			if (args.includes("ls-files")) return sim.files.map((f) => `${f}\0`).join("");
			if (args[0] === "init") return "";
			if (args[0] === "remote" && args[1] === "get-url") return sim.origin ? `${sim.origin}\n` : fail();
			if (args[0] === "diff") return sim.staged ? fail() : "";
			if (args[0] === "rev-parse" && args.includes("--verify")) return sim.hasHead ? "abc\n" : fail();
			if (args[0] === "rev-parse") return "main\n";
			return "";
		}
		return fail();
	}),
}));

const { publish, secretFindings, isForbiddenFile, repoFromRemote } = await import("../src/commands/publish.js");
const { initSite } = await import("../src/commands/init.js");
const { sitePaths } = await import("../src/core/paths.js");

describe("publish", () => {
	let dir: string;
	let project: string;
	const write = (f: string, text: string) => {
		mkdirSync(join(project, f, ".."), { recursive: true });
		writeFileSync(join(project, f), text);
	};
	const run = (o: Parameters<typeof publish>[1] = {}) => publish("acme", { sitesDir: dir, vars: { CLOUDFLARE_API_TOKEN: "cf-build-token-abcdefghijklmnop", EMDASH_TOKEN: "ec_pat_local_token_1234567890" }, ...o });

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-publish-"));
		initSite({ slug: "acme", name: "Acme", sourceUrl: "https://acme.example", productionUrl: "https://www.acme.example", sensitiveData: false }, dir);
		const p = sitePaths("acme", dir);
		project = p.project;
		writeFileSync(join(p.root, "cloudflare.json"), JSON.stringify({ staging: { accountId: "acct-staging" }, production: { accountId: "acct-staging" } }));
		write("package.json", "{}");
		write("wrangler.jsonc", '{ "vars": { "TURNSTILE_SITE_KEY": "0x4AAAAAAAexample", "TURNSTILE_SECRET_KEY": "1x0000000000000000000000000000000AA" } }');
		write(".github/workflows/ci.yml", "env:\n  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\n");
		write(".env.example", "CLOUDFLARE_API_TOKEN=\n");
		Object.assign(sim, { calls: [], hasGit: false, origin: undefined, repoExists: false, visibility: "PRIVATE", files: ["package.json", "wrangler.jsonc", ".github/workflows/ci.yml", ".env.example"], staged: true, hasHead: false, ghSignedIn: true });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("without --yes lists the plan and runs nothing that changes anything", async () => {
		const r = await run();
		expect(r.applied).toBe(false);
		expect(r.repo).toBe("acme.example");
		expect(r.plan.join("\n")).toMatch(/gh repo create acme\.example --private/);
		expect(sim.calls.some((c) => /^git (add|commit|push|remote add)|^gh (repo create|variable)/.test(c))).toBe(false);
	});

	it("creates a private repo, commits, pushes and sets the account id variable; never the token secret", async () => {
		const lines: string[] = [];
		const r = await run({ yes: true, log: (l) => lines.push(l) });
		expect(r.applied).toBe(true);
		expect(sim.calls).toContain("git init -q -b main");
		expect(sim.calls.find((c) => c.startsWith("gh repo create"))).toMatch(/^gh repo create acme\.example --private/);
		expect(sim.calls).toContain("git remote add origin https://github.com/acme/acme.example.git");
		expect(sim.calls).toContain("git push -u origin main");
		expect(sim.calls).toContain("gh variable set CLOUDFLARE_ACCOUNT_ID --repo acme/acme.example --body acct-staging");
		expect(sim.calls.some((c) => c.startsWith("gh secret"))).toBe(false);
		expect(lines.join("\n")).toContain("gh secret set CLOUDFLARE_API_TOKEN --repo acme/acme.example");
		expect(lines.join("\n")).toMatch(/build-only token.*no Zone permissions/);
	});

	it("is idempotent on an existing repository: commit and push only", async () => {
		Object.assign(sim, { hasGit: true, origin: "git@github.com:acme/acme.example.git", repoExists: true, hasHead: true, staged: false });
		mkdirSync(join(project, ".git"));
		const r = await run({ yes: true });
		expect(r.applied).toBe(true);
		expect(sim.calls.some((c) => c.startsWith("gh repo create") || c.startsWith("git init") || c.startsWith("git remote add") || c.startsWith("git commit"))).toBe(false);
		expect(sim.calls).toContain("git push -u origin main");
	});

	it("refuses when a local secret file would be committed (names only)", async () => {
		sim.files.push(".dev.vars", "data/local.db");
		const r = await run({ yes: true });
		expect(r.applied).toBe(false);
		expect(r.blockers[0]).toMatch(/\.dev\.vars, data\/local\.db/);
		expect(sim.calls.some((c) => c.startsWith("git add"))).toBe(false);
	});

	it("refuses a file holding a credential and reports the file name, never the value", async () => {
		write("src/config.ts", 'export const key = "cf-build-token-abcdefghijklmnop";\nconst EMAIL_API_KEY = "xkeysib-' + "a".repeat(64) + '-ABCDEFGHIJKLMNOP";\n');
		sim.files.push("src/config.ts");
		const r = await run({ yes: true });
		expect(r.applied).toBe(false);
		expect(r.blockers.join(" ")).toMatch(/src\/config\.ts \(.*Brevo key.*a value from \.env/);
		expect(r.blockers.join(" ")).not.toContain("cf-build-token");
		expect(r.blockers.join(" ")).not.toContain("xkeysib");
	});

	it("refuses a public repository and an origin that differs from --repo", async () => {
		Object.assign(sim, { repoExists: true, visibility: "PUBLIC" });
		expect((await run({ yes: true })).blockers.join(" ")).toMatch(/public/);
		Object.assign(sim, { hasGit: true, origin: "https://github.com/acme/other.git", visibility: "PRIVATE" });
		mkdirSync(join(project, ".git"));
		await expect(run({ repo: "acme/acme.example" })).rejects.toThrow(/already pushes to acme\/other/);
	});

	it("needs a signed-in GitHub CLI", async () => {
		sim.ghSignedIn = false;
		await expect(run()).rejects.toThrow(/gh auth login/);
	});
});

describe("publish helpers", () => {
	it("knows local-only files", () => {
		expect([".env", ".env.production", ".dev.vars", "x/y.db", "a.db-wal", "key.pem"].every(isForbiddenFile)).toBe(true);
		expect([".env.example", "README.md", "seed/seed.json"].some(isForbiddenFile)).toBe(false);
	});
	it("ignores references, placeholders and Turnstile test keys", () => {
		expect(secretFindings('CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}\nTURNSTILE_SECRET_KEY="1x0000000000000000000000000000000AA"\nAPI_KEY=<your key here>\nEMAIL_API_KEY=process.env.EMAIL_API_KEY_VALUE')).toEqual([]);
		expect(secretFindings('"TURNSTILE_SITE_KEY":"0x4AAAAAAGexamplesitekey"')).toEqual([]);
		// An empty value never borrows the next line (the generated .env.example).
		expect(secretFindings("CLOUDFLARE_API_TOKEN=\nCLOUDFLARE_ACCOUNT_ID=\n")).toEqual([]);
		expect(secretFindings("-----BEGIN PRIVATE KEY-----\nabc")).toEqual(["private key"]);
		expect(secretFindings("DB_PASSWORD=hunter2hunter2hunter2")).toEqual(["DB_PASSWORD with a literal value"]);
	});
	it("reads owner/name from GitHub remotes", () => {
		expect(repoFromRemote("git@github.com:acme/site.git")).toBe("acme/site");
		expect(repoFromRemote("https://github.com/acme/acme.example.git")).toBe("acme/acme.example");
		expect(repoFromRemote("https://github.com/acme/acme.example")).toBe("acme/acme.example");
	});
});
