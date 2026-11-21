import { describe, expect, it } from "vitest";
import { lintInlineScripts } from "../src/scaffold/csp-lint.js";

const CONFIG = "export default defineConfig({ vite: { build: { assetsInlineLimit: 0 } } });";
const lint = (text: string, cfg = CONFIG) => lintInlineScripts([{ path: "src/components/X.astro", text }], cfg);

describe("inline script lint", () => {
	it("passes script files, bundled scripts, data scripts and hashed inline files", () => {
		const ok = `---
import announcementScript from "../scripts/inline/announcement.js?raw";
---
<script is:inline src="/scripts/site.js" defer></script>
<script>import "../scripts/site.ts";</script>
<script type="application/ld+json" set:html={json} />
<script is:inline set:html={announcementScript} />
<!-- <script is:inline>alert(1)</script> -->
`;
		expect(lint(ok)).toEqual([]);
	});

	it("flags the config that lets Astro inline small component scripts", () => {
		expect(lint("<p>hi</p>", "export default defineConfig({})")).toEqual([expect.stringMatching(/assetsInlineLimit/)]);
	});

	it("flags inline code, define:vars, unhashed set:html and event handlers with their line", () => {
		const bad = `---
const x = 1;
---
<script is:inline>window.a = 1;</script>
<script define:vars={{ x }}>console.log(x)</script>
<script is:inline set:html={code} />
<button onclick="go()">Go</button>
`;
		const p = lint(bad);
		expect(p).toHaveLength(4);
		expect(p[0]).toMatch(/X\.astro:4: <script is:inline> with code/);
		expect(p[1]).toMatch(/:5: <script define:vars>/);
		expect(p[2]).toMatch(/:6: inline script from \{code\}/);
		expect(p[3]).toMatch(/:7: inline event handler \(onclick\)/);
	});

	it("checks the starter itself", async () => {
		const { readdirSync, readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : e.name.endsWith(".astro") ? [join(d, e.name)] : []));
		const files = walk("starter/src").map((p) => ({ path: p, text: readFileSync(p, "utf8") }));
		expect(lintInlineScripts(files, CONFIG)).toEqual([]);
	});
});
