// `wp2emdash handover`: the client handover pack, built from a synthetic site workspace in a temp folder.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gatherHandover, handover, handoverDir } from "../src/commands/handover.js";
import { KIT_ROOT } from "../src/core/paths.js";
import { newState, writeState } from "../src/core/state.js";
import { buildHandover, renderHtml, renderMarkdown } from "../src/handover/build.js";
import { PLUGINS, SECTION_HOWTO, sectionLabel } from "../src/handover/catalogue.js";
import { SECTION_TYPES } from "../src/ir/schema.js";
import { startUiServer } from "../src/ui/server.js";

const NOW = new Date("2026-11-22T12:00:00Z");
const ENV = { WP2EMDASH_AGENCY_CONTACT: "hello@agency.example" };
let sites: string;
let outside: string;

const write = (file: string, content: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
};
const json = (file: string, v: unknown) => write(file, `${JSON.stringify(v, null, 2)}\n`);

const section = (type: string, fields: Record<string, unknown> = {}) => ({ type, theme: { tone: "light" }, spacing: "normal", sourceRef: { adapter: "gutenberg", path: "blocks[0]", rawHash: "x" }, fields });
const page = (slug: string, sections: unknown[], extra: Record<string, unknown> = {}) => ({ version: 1, kind: "page", source: { wpId: 1, type: "page", status: "publish", slug, builder: "gutenberg" }, route: { path: slug === "home" ? "/" : `/${slug}/` }, title: slug, seo: { jsonLdTypes: [] }, sections, diagnostics: [], ...extra });

/** A synthetic site: config, IR with a few section types, one form, users counts, cloudflare.json. */
function makeSite(slug: string, config: string, o: { live?: boolean } = {}) {
	const root = join(sites, slug);
	write(join(root, "kit.config.ts"), `export default ${config};\n`);
	writeState(join(root, "state.json"), newState(slug));
	json(join(root, "ir", "site.json"), {
		version: 1,
		title: "Studio Example",
		menus: [
			{ name: "primary", role: "primary", wpLocations: ["main"], items: [{ label: "Home", href: "/", children: [] }, { label: "Contact", href: "/contact/", children: [] }] },
			{ name: "footer", role: "footer", wpLocations: [], items: [{ label: "Privacy", href: "/privacy/", children: [] }] },
		],
		partials: [{ role: "footer", file: "partials/footer.json" }],
		popups: [],
	});
	json(join(root, "ir", "pages", "home.json"), page("home", [section("hero"), section("faq"), section("rich_text")]));
	json(join(root, "ir", "pages", "contact.json"), page("contact", [section("form", { formRef: { provider: "fluentform", id: "3" } })]));
	json(join(root, "ir", "partials", "footer.json"), { ...page("footer", [section("columns")]), kind: "partial" });
	json(join(root, "ir", "users.json"), { invite: { ADMIN: 1, EDITOR: 2 }, skipped: {}, unmappedRoles: [] });
	json(join(root, "ir", "consent.json"), { mode: "opt-in" });
	json(join(root, "project", "src", "forms", "fluentform-3.json"), { id: "fluentform-3", title: "Contact us", fields: [{ name: "email", type: "email", label: "Email" }] });
	// People and secrets the pack must never show.
	json(join(root, "users", "invites.json"), { invites: [{ wpId: 7, name: "Secret Person", email: "secret.person@client.example", role: "EDITOR", wpRoles: ["editor"] }], skipped: [] });
	write(join(root, ".env"), "EMDASH_TOKEN=ec_pat_SENTINEL_SECRET\n");
	json(join(root, "cloudflare.json"), { production: { d1: { id: "d1-id" }, worker: { url: `https://${slug}.agency.workers.dev` }, ...(o.live ? { live: true } : {}) } });
	return root;
}

const baseConfig = (slug: string, extra = "") => `{
	slug: "${slug}",
	name: "Studio Example",
	source: { url: "https://old.example.com" },
	target: { productionUrl: "https://studio.example.com", aliasDomains: ["studio-old.example"] },
	email: { provider: "brevo", to: ["owner@studio.example.com"], stagingTo: ["agency-tests@agency.example"] },
	health: { alertsTo: ["alerts@agency.example"] },
	changeRequests: { agencyTo: ["requests@agency.example"] },
	${extra}
}`;

beforeEach(() => {
	sites = mkdtempSync(join(tmpdir(), "wp2emdash-handover-"));
	outside = mkdtempSync(join(tmpdir(), "wp2emdash-handover-out-"));
});
afterEach(() => {
	rmSync(sites, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

describe("catalogue", () => {
	it("has a how-to and an admin label for every section type", () => {
		for (const t of SECTION_TYPES) {
			expect(SECTION_HOWTO[t].length, t).toBeGreaterThan(30);
			expect(sectionLabel(t), t).not.toMatch(/_/);
		}
		expect(sectionLabel("media_text")).toBe("Image and text");
		expect(sectionLabel("announcement")).toBe("Announcement bar");
		expect(Object.values(PLUGINS).every((p) => p.where && p.what)).toBe(true);
	});
});

describe("handover pack", () => {
	it("is built from the site's actual sections, forms, roles and tools, and written to sites/<slug>/handover", async () => {
		const root = makeSite("studio", baseConfig("studio"));
		const r = await handover("studio", { sitesDir: sites, now: NOW, env: ENV, monitorDir: outside });
		expect(r.dir).toBe(join(root, "handover"));
		const md = readFileSync(join(root, "handover", "handover.md"), "utf8");
		const html = readFileSync(join(root, "handover", "handover.html"), "utf8");

		// Sections: exactly the used ones (hero, faq, text, form, columns in the footer), with their admin labels.
		const editing = r.model.chapters.find((c) => c.id === "editing");
		const table = editing?.blocks.find((b) => "table" in b);
		const labels = table && "table" in table ? table.table.rows.map((row) => row[0]) : [];
		expect(labels).toEqual(["Hero", "Text", "Columns", "FAQ", "Form"]);
		expect(md).not.toContain("Gallery");
		expect(md).not.toContain("Pricing");

		// Addresses and sign-in (not live yet: preview address, passkey caveat).
		expect(md).toContain("https://studio.agency.workers.dev/_emdash/admin");
		expect(md).toContain("https://studio.example.com/_emdash/admin");
		expect(md).toContain("studio-old.example and www.studio-old.example");
		expect(md).toContain("Sign in with Passkey");
		expect(md).toContain("Sign in with email link");
		expect(md).toMatch(/Passkeys only work at the address where they were made/);

		// Forms: title, where it is, the owner's own recipient, the inbox.
		expect(md).toContain("| Contact us | /contact/ |");
		expect(md).toContain("owner@studio.example.com");
		expect(md).toContain("Plugins → Form messages");

		// Roles: names and counts only.
		expect(md).toContain("1 from your old site");
		expect(md).toContain("2 from your old site");
		expect(md).toContain("3 people");

		// Menus and site parts from ir/site.json.
		expect(md).toContain("Main menu: 2 links; Footer menu: 1 link");
		expect(md).toContain("the footer shown on every page");

		// Tools on by default, cookie banner mode from ir/consent.json.
		for (const t of ["SEO & Analytics", "SEO fix-it", "Site health & monthly report", "Backups & restore", "Cookie banner", "Change requests", "Media assistant", "Sharing images", "Motion"]) expect(md).toContain(t);
		expect(md).toContain("Nothing that stores data runs until a visitor agrees.");
		expect(md).not.toMatch(/^\| Comments \|/m);

		// Support: PixelKraft branding by default, contact line from the environment.
		expect(md).toContain("PixelKraft");
		expect(md).toContain("https://pixelkraft.net");
		expect(md).toContain("hello@agency.example");

		// Never: agency addresses, people from the invite list, secrets.
		for (const out of [md, html, JSON.stringify(r.model)]) {
			for (const never of ["agency-tests@agency.example", "alerts@agency.example", "requests@agency.example", "Secret Person", "secret.person@client.example", "SENTINEL_SECRET"]) expect(out).not.toContain(never);
		}
	});

	it("renders a self-contained, printable HTML page with no external requests", async () => {
		makeSite("studio", baseConfig("studio"));
		const r = await handover("studio", { sitesDir: sites, now: NOW, env: ENV, monitorDir: outside });
		const html = readFileSync(r.files[0] as string, "utf8");
		expect(html.startsWith("<!doctype html>")).toBe(true);
		expect(html).toContain("@media print");
		expect(html).not.toMatch(/<script|<link|<img|<iframe|@import|url\(|\ssrc=/i);
		expect(html).toContain("default-src 'none'");
		// Bold and addresses are formatted, everything else escaped.
		expect(html).toContain("<strong>Sign in with Passkey</strong>");
		expect(html).toContain('<a href="https://pixelkraft.net">https://pixelkraft.net</a>');
		expect(renderHtml(buildHandover({ ...(await gatherHandover("studio", { sitesDir: sites, now: NOW, env: ENV })), name: "A <b>&</b> B" }))).toContain("A &lt;b&gt;&amp;&lt;/b&gt; B");
	});

	it("leaves out what the site does not have and follows the live state", async () => {
		makeSite(
			"live",
			baseConfig("live", `health: false, backups: false, consent: false, changeRequests: false, media: false, og: { cards: false }, motionPanel: false, seo: { panel: false }, forms: { outbox: false }, credit: { name: "Other Agency", url: "https://other.example" },`).replace(/\thealth: \{ alertsTo[^\n]*\n|\tchangeRequests: \{ agencyTo[^\n]*\n/g, ""),
			{ live: true },
		);
		const r = await handover("live", { sitesDir: sites, now: NOW, env: {}, monitorDir: outside });
		const md = renderMarkdown(r.model);
		expect(r.model.chapters.map((c) => c.id)).not.toContain("tools");
		for (const t of ["Site health", "Backups", "Cookie banner", "Change requests", "Media assistant", "Sharing images", "Plugins → Motion", "Form messages"]) expect(md).not.toContain(t);
		expect(md).toContain("| Your website | https://studio.example.com |");
		expect(md).not.toContain("workers.dev");
		expect(md).not.toMatch(/Passkeys only work/);
		expect(md).toContain("Other Agency");
		expect(md).toContain("______"); // contact left to fill in
	});

	it("mentions comments, staging and the outside monitor only when the site has them", async () => {
		const root = makeSite("extras", baseConfig("extras", `target: { productionUrl: "https://studio.example.com", staging: true, stagingUrl: "https://staging.studio.example.com" },`).replace(/\ttarget: \{ productionUrl: "https:\/\/studio.example.com", aliasDomains[^\n]*\n/, ""), { live: true });
		json(join(root, "ir", "comments.json"), { migrate: true, collections: [{ slug: "posts", form: true, approved: 4 }] });
		write(join(outside, "monitor.config.json"), "{}");
		const md = renderMarkdown((await handover("extras", { sitesDir: sites, now: NOW, env: ENV, monitorDir: outside })).model);
		expect(md).toContain("| Comments |");
		expect(md).toContain("https://staging.studio.example.com");
		expect(md).toContain("checks your site from outside");
	});

	it("refuses an output folder inside the kit repository, and a site without transform output", async () => {
		const root = makeSite("studio", baseConfig("studio"));
		expect(() => handoverDir(root, join(KIT_ROOT, "docs"))).toThrow(/inside the kit repository/);
		expect(handoverDir(root, outside)).toBe(outside);
		const r = await handover("studio", { sitesDir: sites, now: NOW, env: ENV, out: join(outside, "pack"), monitorDir: outside });
		expect(r.files.every((f) => f.startsWith(join(outside, "pack")))).toBe(true);
		rmSync(join(root, "ir", "site.json"));
		await expect(handover("studio", { sitesDir: sites, now: NOW, env: ENV })).rejects.toThrow(/transform/);
	});

	it("shows in the dashboard overview and is served sandboxed, only from its default place", async () => {
		makeSite("studio", baseConfig("studio"));
		const ui = await startUiServer({ sitesDir: sites, token: "test-token-0123456789" });
		try {
			const base = `http://127.0.0.1:${ui.port}`;
			const cookie = ((await fetch(`${base}/?t=test-token-0123456789`, { redirect: "manual" })).headers.get("set-cookie") ?? "").split(";")[0] as string;
			const get = (p: string) => fetch(`${base}${p}`, { headers: { Cookie: cookie } });
			const before = (await (await get("/api/sites/studio")).json()) as { handover: { available: boolean; command: string } };
			expect(before.handover).toEqual({ available: false, command: "pnpm wp2emdash handover studio" });
			expect((await get("/files/studio/handover/handover.html")).status).toBe(404);
			await handover("studio", { sitesDir: sites, now: NOW, env: ENV, monitorDir: outside });
			const after = (await (await get("/api/sites/studio")).json()) as { handover: { available: boolean; url: string } };
			expect(after.handover.available).toBe(true);
			const page = await get(after.handover.url);
			expect(page.status).toBe(200);
			expect(page.headers.get("content-type")).toContain("text/html");
			expect(page.headers.get("content-security-policy")).toMatch(/default-src 'none'.*sandbox/);
			expect(await page.text()).toContain("website handover");
			expect((await get("/files/studio/handover/handover.md")).status).toBe(404);
		} finally {
			await ui.close();
		}
	});
});
