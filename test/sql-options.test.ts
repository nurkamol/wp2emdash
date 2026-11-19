import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutSecrets } from "../src/commands/import-options.js";
import { parseValues, phpUnserialize, readOptionsFromDump } from "../src/extract/sql-options.js";

describe("PHP unserialize", () => {
	it("decodes lists, maps, nested values and multi-byte strings (lengths in bytes)", () => {
		expect(phpUnserialize('a:2:{i:0;s:3:"red";i:1;s:4:"blue";}')).toEqual(["red", "blue"]);
		expect(phpUnserialize('a:3:{s:2:"id";s:3:"abc";s:5:"color";a:1:{s:3:"hex";s:7:"#ff0000";}s:2:"on";b:1;}')).toEqual({ id: "abc", color: { hex: "#ff0000" }, on: true });
		expect(phpUnserialize('a:2:{s:1:"n";N;s:1:"d";d:1.5;}')).toEqual({ n: null, d: 1.5 });
		expect(phpUnserialize('s:5:"café";')).toBe("café"); // é = 2 bytes, so 5 bytes in all
	});
});

describe("SQL dump options", () => {
	it("parses VALUES tuples with escapes and NULL", () => {
		expect(parseValues("INSERT INTO `wp_options` VALUES (1,'a\\'b','x,y',NULL),(2,'c','it''s','yes');")).toEqual([["1", "a'b", "x,y", null], ["2", "c", "it's", "yes"]]);
	});
	it("returns only allow-listed options, decoded", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wp2emdash-sql-"));
		const file = join(dir, "database.sql");
		const pal = 'a:1:{i:0;a:2:{s:2:"id";s:2:"p1";s:6:"colors";a:1:{i:0;a:1:{s:5:"light";s:7:"#123456";}}}}';
		writeFileSync(file, ["CREATE TABLE `xy_options` (", "  `option_id` bigint unsigned NOT NULL,", "  `option_name` varchar(191) NOT NULL,", "  `option_value` longtext NOT NULL,", "  `autoload` varchar(20) NOT NULL", ") ENGINE=InnoDB;", `INSERT INTO \`xy_options\` VALUES (1,'bricks_color_palette','${pal.replace(/"/g, '\\"')}','yes'),(2,'bricks_license_key','SECRET','yes'),`, "(3,'siteurl','https://x','yes');", "INSERT INTO `xy_posts` VALUES (1,'form entry');"].join("\n"));
		const o = await readOptionsFromDump(file, ["bricks_color_palette"]);
		expect(Object.keys(o)).toEqual(["bricks_color_palette"]);
		expect((o.bricks_color_palette as { colors: { light: string }[] }[])[0]?.colors[0]?.light).toBe("#123456");
		rmSync(dir, { recursive: true, force: true });
	});
	it("drops credential-looking settings", () => {
		const dropped: string[] = [];
		expect(withoutSecrets({ apiKeyGoogleMaps: "AIza", recaptchaSecretKey: "x", smoothScroll: true, nested: { mailchimpApiKey: "m", label: "ok" } }, dropped)).toEqual({ smoothScroll: true, nested: { label: "ok" } });
		expect(dropped).toEqual(["apiKeyGoogleMaps", "recaptchaSecretKey", "nested.mailchimpApiKey"]);
	});
});
