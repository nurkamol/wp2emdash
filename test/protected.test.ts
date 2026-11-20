/**
 * Password-protected and private content: hashes (kit ↔ starter), decisions and the transform gate, the target data,
 * the starter's unlock cookie. Synthetic data only (the blog fixture plus a members page).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import type { IrPage } from "../src/ir/schema.js";
import { postAction } from "../src/phases/load.js";
import { runTransform } from "../src/phases/transform.js";
import { ACCESS_BODY_FIELD, ACCESS_FIELD, pageAction, protectedData } from "../src/targets/emdash/access.js";
import { checkHash, decide, hashPassword, isPasswordFormHtml } from "../src/transform/protected.js";
import { checkPassword, isUnlocked, safeBack, unlockValue } from "../starter/src/utils/access.js";

describe("password hashes", () => {
	it("the kit's PBKDF2 hash is verified by the starter's WebCrypto code; plain text works too; never the wrong one", async () => {
		const h = hashPassword("open sesame");
		expect(h).toMatch(/^pbkdf2-sha256\$100000\$[\w-]{22}\$[\w-]{43}$/);
		expect(h).not.toContain("open sesame");
		expect(checkHash("open sesame", h)).toBe(true);
		expect(await checkPassword(h, "open sesame")).toBe(true);
		expect(await checkPassword(h, "open sesame ")).toBe(false);
		expect(await checkPassword("typed-by-owner", "typed-by-owner")).toBe(true);
		expect(await checkPassword("typed-by-owner", "typed-by-owne")).toBe(false);
		expect(await checkPassword("", "")).toBe(false);
		expect(hashPassword("x")).not.toBe(hashPassword("x")); // salted
	});
	it("unlock cookie: valid for its entry and password, until it expires or the password changes", async () => {
		const v = await unlockValue("secret", "stored-1", "e1", Date.UTC(2026, 0, 1));
		expect(await isUnlocked("secret", "stored-1", "e1", v, Date.UTC(2026, 0, 2))).toBe(true);
		expect(await isUnlocked("secret", "stored-1", "e2", v, Date.UTC(2026, 0, 2))).toBe(false);
		expect(await isUnlocked("secret", "stored-2", "e1", v, Date.UTC(2026, 0, 2))).toBe(false);
		expect(await isUnlocked("other", "stored-1", "e1", v, Date.UTC(2026, 0, 2))).toBe(false);
		expect(await isUnlocked("secret", "stored-1", "e1", v, Date.UTC(2026, 0, 12))).toBe(false);
		expect(await isUnlocked("secret", "stored-1", "e1", "123.abc", Date.UTC(2026, 0, 2))).toBe(false);
		expect([safeBack("/members/"), safeBack("//evil.example/"), safeBack("https://evil.example/"), safeBack("/a\\b")]).toEqual(["/members/", "/", "/", "/"]);
	});
	it("WordPress's password form is recognised in a saved page", () => {
		expect(isPasswordFormHtml('<form action="https://site.example/wp-login.php?action=postpass" class="post-password-form" method="post">')).toBe(true);
		expect(isPasswordFormHtml("<form class=\"search-form\">")).toBe(false);
	});
});

describe("decisions", () => {
	it("defaults: password → protect, private → draft; the owner's decision and legacy protectedPosts win", () => {
		expect(decide("password", undefined)).toBe("protect");
		expect(decide("private", undefined)).toBe("draft");
		expect(decide("password", { password: { as: "draft", reason: "r" } })).toBe("draft");
		expect(decide("private", { private: { as: "publish", reason: "r" } })).toBe("publish");
		expect(decide("password", undefined, { as: "skip" })).toBe("skip");
	});
	it("target status and data", () => {
		const doc = (status: string, access?: IrPage["access"], kind: IrPage["kind"] = "page") => ({ kind, source: { status }, ...(access ? { access } : {}), post: { publishedAt: "2020-01-01T00:00:00Z", visibility: "public" } }) as unknown as IrPage;
		expect(pageAction(doc("publish", { kind: "password", as: "protect" }))).toBe("publish");
		expect(pageAction(doc("publish", { kind: "password", as: "draft" }))).toBe("draft");
		expect(pageAction(doc("private", { kind: "private", as: "publish" }))).toBe("publish");
		expect(pageAction(doc("private"))).toBe("draft");
		expect(postAction(doc("private", { kind: "private", as: "draft" }, "post"), undefined)).toBe("draft");
		expect(postAction(doc("publish", { kind: "password", as: "protect" }, "post"), undefined)).toBe("publish");
		expect(protectedData({ body: [{ _type: "block" }], excerpt: "secret summary" }, { hash: "h", post: true })).toEqual({ [ACCESS_FIELD.slug]: "h", [ACCESS_BODY_FIELD.slug]: [{ _type: "block" }], body: [], excerpt: "" });
		expect(protectedData({ content: [] }, { hash: "h", post: false })).toEqual({ [ACCESS_FIELD.slug]: "h" });
	});
});

describe("transform", () => {
	const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "blog", "site.json"), "utf8"));
	const dir = mkdtempSync(join(tmpdir(), "wp2e-protected-"));
	const put = (f: string, data: unknown) => {
		mkdirSync(dirname(f), { recursive: true });
		writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data));
	};
	const page = (id: number, slug: string, status = "publish") => ({ ...fx.pages[0], id, slug, status, title: `Page ${slug}`, content: `<!-- wp:heading --><h2>Inside ${slug}</h2><!-- /wp:heading -->\n<!-- wp:paragraph --><p>Only for members.</p><!-- /wp:paragraph -->`, meta: {} });
	const workspace = (name: string, o: { protectedJson?: unknown; env?: string; overrides?: string; snapshotForm?: boolean } = {}) => {
		const paths = sitePaths(name, dir);
		put(join(paths.raw, "extract.json"), {});
		put(join(paths.raw, "exporter", "options.json"), fx.options);
		put(join(paths.raw, "exporter", "content", "page.json"), [...fx.pages, page(50, "members"), page(51, "staff-only", "private"), page(52, "club")]);
		put(join(paths.raw, "exporter", "content", "post.json"), fx.posts);
		put(join(paths.raw, "exporter", "taxonomies.json"), fx.taxonomies);
		put(join(paths.raw, "exporter", "analyze.json"), fx.analyze);
		put(join(paths.raw, "media-manifest.json"), fx.media);
		put(join(paths.snapshot, "urls.json"), fx.urls);
		put(join(paths.snapshot, "discovery.json"), fx.discovery);
		if (o.protectedJson) put(join(paths.raw, "protected.json"), o.protectedJson);
		if (o.env) put(join(paths.root, ".env"), o.env);
		if (o.overrides) put(paths.overrides, o.overrides);
		if (o.snapshotForm) {
			put(join(paths.snapshot, "pages", "club.json"), { wpId: 52, seo: {} });
			put(join(paths.snapshot, "html", "club.html"), '<html><body><form action="https://blog.example.test/wp-login.php?action=postpass" class="post-password-form" method="post"><p>This content is password protected.</p></form></body></html>');
		}
		return paths;
	};
	const config = kitConfigSchema.parse({ slug: "blog", name: "Example Journal", source: { url: "https://blog.example.test" }, target: { productionUrl: "https://blog.example.test" } });
	const run = (paths: ReturnType<typeof sitePaths>) => runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
	const ir = (paths: ReturnType<typeof sitePaths>, f: string) => JSON.parse(readFileSync(join(paths.ir, f), "utf8")) as IrPage;

	it("protects a password page (hash only in raw/), makes a private page a draft, finds a protected page from the live snapshot", async () => {
		const paths = workspace("defaults", { protectedJson: [{ type: "page", id: 50, hash: hashPassword("members") }], snapshotForm: true, env: "WP2EMDASH_PROTECTED_PASSWORD=club-pass\n" });
		const checks = await run(paths);
		expect(ir(paths, "pages/members.json").access).toEqual({ kind: "password", as: "protect" });
		expect(ir(paths, "pages/staff-only.json").access).toEqual({ kind: "private", as: "draft" });
		expect(ir(paths, "pages/club.json").access).toEqual({ kind: "password", as: "protect" });
		expect(readFileSync(join(paths.ir, "pages", "members.json"), "utf8")).not.toMatch(/pbkdf2/);
		const gate = checks.find((c) => c.id === "protected-content");
		expect(gate).toMatchObject({ ok: true });
		expect(gate?.detail).toMatch(/protect 2, draft 2/);
	});
	it("the gate stays red for a protected page whose password is unknown, until a fallback or a decision", async () => {
		const open = await run(workspace("unknown", { protectedJson: [{ type: "page", id: 50 }] }));
		expect(open.find((c) => c.id === "protected-content")).toMatchObject({ ok: false });
		expect(open.find((c) => c.id === "protected-content")?.detail).toMatch(/page members/);
		const decided = workspace("decided", { protectedJson: [{ type: "page", id: 50 }], overrides: `export default { protectedContent: { password: { as: "skip", reason: "owner: not needed" }, private: { as: "publish", reason: "owner: fine to show" } } };\n` });
		const checks = await run(decided);
		expect(checks.find((c) => c.id === "protected-content")).toMatchObject({ ok: true });
		expect(() => ir(decided, "pages/members.json")).toThrow();
		expect(ir(decided, "pages/staff-only.json").access).toEqual({ kind: "private", as: "publish" });
	});
});
