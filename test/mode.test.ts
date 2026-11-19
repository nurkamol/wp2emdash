import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { preferredMode, rememberMode } from "../src/commands/ui.js";

describe("terminal / web choice", () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2emdash-mode-"));
	const file = join(dir, ".wp2emdash.local.json");
	afterEach(() => rmSync(file, { force: true }));

	it("WP2EMDASH_MODE wins and skips the question", () => {
		rememberMode("terminal", file);
		expect(preferredMode({ WP2EMDASH_MODE: "web" }, file)).toEqual({ mode: "web", fromEnv: true });
	});
	it("remembers the last choice as the default, keeping other local preferences", () => {
		writeFileSync(file, JSON.stringify({ other: 1 }));
		rememberMode("web", file);
		expect(preferredMode({}, file)).toEqual({ mode: "web", fromEnv: false });
		expect(JSON.parse(readFileSync(file, "utf8")).other).toBe(1);
	});
	it("ignores unknown values and broken files", () => {
		expect(preferredMode({ WP2EMDASH_MODE: "gui" }, file)).toEqual({ fromEnv: false });
		writeFileSync(file, "{not json");
		expect(preferredMode({}, file)).toEqual({ fromEnv: false });
	});
});
