import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = resolve("scripts/privacy-check.mjs");

function repo(files: Record<string, string>, staged: Record<string, string> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "privacy-"));
	const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
	git("init", "-q");
	git("config", "user.email", "t@example.com");
	git("config", "user.name", "t");
	git("config", "core.hooksPath", "/dev/null");
	// A local client workspace (gitignored, as in the kit).
	mkdirSync(join(dir, "sites", "acme"), { recursive: true });
	writeFileSync(join(dir, "sites", "acme", "kit.config.ts"), `export default {\n\tname: "Acme Yoga Springfield",\n\tsource: { url: "https://acmeyogaspringfield.com" },\n\temail: { from: "Acme <hello@acmeyogaspringfield.com>", stagingTo: ["dev@pixelkraft.net"] },\n};\n`);
	writeFileSync(join(dir, ".gitignore"), "sites/*\n!sites/README.md\n");
	for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
	git("add", "-A");
	git("commit", "-qm", "init");
	for (const [f, c] of Object.entries(staged)) {
		writeFileSync(join(dir, f), c);
		git("add", f);
	}
	return dir;
}

const run = (dir: string, args: string[] = [], env: Record<string, string> = {}) =>
	spawnSync("node", [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env: { ...process.env, PRIVACY_PATTERNS: "", ...env } });

describe("privacy check", () => {
	it("passes synthetic content and allowlisted addresses", () => {
		const r = run(repo({ "a.md": "Example Studio, hello@studio.example, dev@pixelkraft.net, owner@example.invalid, react@18.3.1\n" }));
		expect(r.status).toBe(0);
	});

	it("catches a client's name, part of it, domain and email derived from sites/, without printing them", () => {
		const r = run(repo({ "a.md": "ok\n" }, { "a.md": "Measured on Acme Yoga: 11 pages\nsee acmeyogaspringfield.com\nmail hello@acmeyogaspringfield.com\n" }), ["--staged"]);
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("a.md:1 — part of a client name");
		expect(r.stderr).toContain("a.md:2 — client domain");
		expect(r.stderr).toContain("a.md:3 — client email");
		expect(r.stderr).not.toMatch(/Acme Yoga|acmeyogaspringfield/);
	});

	it("uses PRIVACY_PATTERNS (the CI secret) and labels them by number only", () => {
		const r = run(repo({ "b.ts": "const city = 'Gotham Heights';\n" }), [], { PRIVACY_PATTERNS: "# comment\ngotham\\s+heights" });
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("b.ts:1 — private pattern #1");
		expect(r.stderr).not.toContain("Gotham");
	});

	it("flags unknown real-looking email addresses", () => {
		const r = run(repo({ "c.md": "write to jane.doe@realclinic.com\n" }));
		expect(r.status).toBe(1);
		expect(r.stderr).toContain("email address outside the allowlist");
	});
});
