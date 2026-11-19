import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify, importDump } from "../src/commands/import-dump.js";
import { initSite } from "../src/commands/init.js";
import { sitePaths } from "../src/core/paths.js";

describe("import-dump", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-dump-"));
		initSite({ slug: "acme", name: "Acme", sourceUrl: "https://acme.example", productionUrl: "https://acme.example", sensitiveData: false }, dir);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("recognises settings files by content", () => {
		expect(classify("x.txt", JSON.stringify({ "primary-h": 1, "primary-s": 2, "accent-comp-h": 3 })).kind).toBe("acss");
		expect(classify("x.json", JSON.stringify({ id: "s", label: "Style", settings: {} })).kind).toBe("bricks-theme-style");
		expect(classify("x.json", JSON.stringify({ general: {}, titles: {}, sitemap: {} })).kind).toBe("rankmath-settings");
		expect(classify("x.csv", "id,object_type,slug,seo_title\n1,post,a,b").kind).toBe("rankmath-seo-csv");
	});

	it("sorts exports into raw/, reads only the database from a backup, never opens backup files", async () => {
		const p = sitePaths("acme", dir);
		const dump = join(p.root, "dump");
		mkdirSync(join(dump, "backup", "uploads", "fluentform"), { recursive: true });
		writeFileSync(join(dump, "acss.txt"), JSON.stringify({ "primary-h": 1, "primary-s": 2, "base-l": 3 }));
		writeFileSync(join(dump, "redirection.json"), JSON.stringify({ redirects: [{ url: "/old", match_type: "url", action_type: "url", action_code: 301, action_data: { url: "/new" } }] }));
		writeFileSync(join(dump, "seo.csv"), "id,object_type,slug,seo_title\n1,post,a,b\n");
		writeFileSync(join(dump, "backup", "database.sql"), "CREATE TABLE `wp_options` (\n  `option_id` bigint,\n  `option_name` varchar(191),\n  `option_value` longtext,\n  `autoload` varchar(20)\n) ENGINE=InnoDB;\nINSERT INTO `wp_options` VALUES (1,'bricks_color_palette','a:0:{}','yes');\n");
		writeFileSync(join(dump, "backup", "uploads", "fluentform", "entry.json"), JSON.stringify({ redirects: [] }));
		const items = await importDump("acme", undefined, dir);
		const used = Object.fromEntries(items.map((i) => [i.file, i.used]));
		expect(used["acss.txt"]).toMatch(/Automatic\.css/);
		expect(used["redirection.json"]).toMatch(/1 redirect/);
		expect(used["seo.csv"]).toMatch(/exporter already carries/);
		expect(used["backup/database.sql"]).toMatch(/bricks_color_palette/);
		expect(used["(backup)"]).toMatch(/1 other backup files .* not opened/);
		expect(Object.keys(used).some((f) => f.includes("uploads"))).toBe(false);
		expect(readdirSync(join(p.raw, "plugin-exports"))).toEqual(["redirection.json"]);
		expect(existsSync(join(p.raw, "acss-settings.json"))).toBe(true);
	});
});
