import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { versionAtLeast } from "../src/extract/client.js";
import { loadEnv, parseMigrationKey, redact, resolveCredentials } from "../src/extract/credentials.js";
import { decodeRawBlocks, findMediaRefs, uploadsKey } from "../src/extract/refs.js";

const fakeKey = (o: object) => `em1.${Buffer.from(JSON.stringify(o)).toString("base64url")}`;

describe("credentials", () => {
	it("parses an exporter migration key", () => {
		const k = fakeKey({ v: 1, url: "https://acme.example", user: "migrator", pass: "abcd efgh ijkl" });
		expect(parseMigrationKey(k)).toEqual({ url: "https://acme.example", user: "migrator", pass: "abcd efgh ijkl" });
		expect(() => parseMigrationKey("nope")).toThrow(/em1/);
		expect(() => parseMigrationKey("em1.!!!")).toThrow();
	});

	it("prefers the migration key, strips spaces, falls back to app password", () => {
		const k = fakeKey({ v: 1, url: "https://acme.example", user: "u", pass: "ab cd" });
		expect(resolveCredentials({ EMDASH_WP_MIGRATION_KEY: k })).toMatchObject({ user: "u", password: "abcd", source: "migration-key" });
		expect(resolveCredentials({ WP_APP_USER: "x", WP_APP_PASSWORD: "p q" })).toMatchObject({ password: "pq", source: "app-password" });
		expect(resolveCredentials({})).toBeUndefined();
	});

	it("loads .env and redacts secrets from messages", () => {
		const dir = mkdtempSync(join(tmpdir(), "wp2e-env-"));
		try {
			writeFileSync(join(dir, ".env"), '# c\nA=1\nB="two words"\nEMPTY=\n');
			expect(loadEnv(join(dir, ".env"))).toEqual({ A: "1", B: "two words", EMPTY: "" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		const creds = { user: "u", password: "s3cretpass", source: "app-password" as const };
		expect(redact("failed em1.abcdefghijklmnop with s3cretpass and Basic dXNlcjpwYXNz", creds)).toBe("failed em1.[redacted] with [redacted] and Basic [redacted]");
	});

	it("compares exporter versions", () => {
		expect(versionAtLeast("1.2.0", "1.2.0")).toBe(true);
		expect(versionAtLeast("1.10.0", "1.2.0")).toBe(true);
		expect(versionAtLeast("1.1.9", "1.2.0")).toBe(false);
	});
});

describe("media references", () => {
	it("finds attachment IDs in WPBakery/Salient attributes, classes and meta", () => {
		const content =
			'[vc_row bg_image="590" bg_color="#fff"][vc_column][image_with_animation image_url="612" alignment="center"][vc_gallery images="1,2, 3"][nectar_btn size="large" icon="12"][/vc_column][/vc_row]<img class="alignnone wp-image-77" src="x">';
		const refs = findMediaRefs(content, { _thumbnail_id: "88", _nectar_header_bg: "https://acme.example/wp-content/uploads/2025/01/hero.jpg", rank_math_seo_score: "80" });
		const ids = refs.filter((r) => r.kind === "id").map((r) => r.value);
		expect(ids.sort()).toEqual(["1", "2", "3", "590", "612", "77", "88"].sort());
		expect(ids).not.toContain("12"); // icon size, not an image attribute
		expect(ids).not.toContain("80");
		expect(refs.find((r) => r.kind === "url")).toMatchObject({ value: "https://acme.example/wp-content/uploads/2025/01/hero.jpg", via: "meta:_nectar_header_bg" });
	});

	it("finds media URLs in URL-encoded link attributes and vc_raw_html", () => {
		const html = "<video src='https://cdn.example.net/site/bg.mp4'></video>";
		const b64 = Buffer.from(encodeURIComponent(html)).toString("base64");
		const content = `[nectar_btn url="url:https%3A%2F%2Facme.example%2Fstorage%2F2025%2F02%2Fmenu.pdf|title:Menu"][vc_raw_html]${b64}[/vc_raw_html]`;
		expect(decodeRawBlocks(content)).toEqual([html]);
		const urls = findMediaRefs(content).filter((r) => r.kind === "url").map((r) => r.value);
		expect(urls).toContain("https://acme.example/storage/2025/02/menu.pdf");
		expect(urls).toContain("https://cdn.example.net/site/bg.mp4");
	});

	it("normalises upload URLs across size variants and hidden upload paths", () => {
		expect(uploadsKey("https://a.b/wp-content/uploads/2025/03/Photo-300x200.webp")).toBe("2025/03/photo.webp");
		expect(uploadsKey("https://a.b/storage/2025/03/photo-scaled.webp?v=2")).toBe("2025/03/photo.webp");
		expect(uploadsKey("https://cdn.x/y.jpg")).toBeUndefined();
	});
});
