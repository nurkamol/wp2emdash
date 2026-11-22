import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { STACK } from "../src/phases/scaffold.js";

describe("stack pins", () => {
	it("the starter's pnpm overrides pin @cloudflare/vite-plugin to the STACK version (a newer plugin can need a newer Wrangler)", () => {
		const ws = parse(readFileSync(new URL("../starter/pnpm-workspace.yaml", import.meta.url), "utf8")) as { overrides?: Record<string, string> };
		expect(ws.overrides?.["@cloudflare/vite-plugin"]).toBe(STACK["@cloudflare/vite-plugin"]);
	});
});
