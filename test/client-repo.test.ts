import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ClientRepoInput, clientRepoFiles, deployScripts, MARKER, writeClientRepo } from "../src/scaffold/client-repo.js";

const input = (o: Partial<ClientRepoInput> = {}): ClientRepoInput => ({
	name: "Example Studio",
	slug: "example",
	sourceUrl: "https://example.com",
	productionUrl: "https://example.com",
	workerName: "example",
	stagingUrl: "https://example-staging.acme.workers.dev",
	productionReady: false,
	sections: [{ slug: "section_hero", label: "Hero", description: "Page introduction" }],
	forms: [{ id: "fluent-forms-1", title: "Contact", fields: ["Name", "Email"], withheld: ["Message"] }],
	email: { provider: "brevo", from: "Site <noreply@example.com>", to: ["owner@example.com"] },
	turnstileProduction: false,
	sensitiveData: true,
	stack: { node: ">=24", astro: "7", emdash: "1.5.0", wrangler: "4" },
	...o,
});

describe("client repo files", () => {
	it("blog sites get docs/writing-posts.md and a Posts row in the editor guide; others do not", () => {
		const plain = clientRepoFiles(input());
		expect(plain["docs/writing-posts.md"]).toBeUndefined();
		expect(plain["docs/editor-guide.md"]).not.toContain("**Posts**");
		const blog = clientRepoFiles(input({ blog: { index: "/journal/", archives: [{ label: "Categories", base: "/category/" }, { label: "Tags", base: "/tag/" }], authorBase: "/author/", feedFull: false } }));
		expect(blog["docs/editor-guide.md"]).toContain("| **Posts** | Blog posts");
		const doc = blog["docs/writing-posts.md"] as string;
		expect(doc).toContain("| `/journal/` | The posts page");
		expect(doc).toContain("| `/category/<name>/` | Categories: every post in it |");
		expect(doc).toContain("| `/feed/` | The RSS feed (excerpts); every list above has its own, e.g. `/category/<name>/feed/` |");
		expect(doc).toContain("linking to `/author/<name>/`");
	});

	it("pins the staging migration target for CI only when its fingerprint is known", () => {
		expect(deployScripts({ staging: true })["ci:deploy:staging"]).toBeUndefined();
		expect(deployScripts({ staging: true, stagingFingerprint: "abc123" })["ci:deploy:staging"]).toContain("--expected-target-fingerprint=abc123");
		expect(Object.keys(deployScripts({ staging: true }))).not.toContain("deploy"); // pnpm built-in name
		expect(Object.keys(deployScripts({ staging: false }))).not.toContain("deploy");
	});
	it("keeps CI staging deploys off without a fingerprint, production manual and guarded", () => {
		const off = clientRepoFiles(input())[".github/workflows/ci.yml"] as string;
		expect(off).toMatch(/deploy-staging:\n\s+needs: check\n\s+#[^\n]*\n\s+if: false\n/);
		const on = clientRepoFiles(input({ stagingFingerprint: "abc" }))[".github/workflows/ci.yml"] as string;
		expect(on).toContain("vars.CLOUDFLARE_ACCOUNT_ID != '' && (github.event_name == 'push'");
		expect(on).toMatch(/deploy-production:[\s\S]*inputs.target == 'production'[\s\S]*environment: production[\s\S]*database_id/);
	});
	it("documents forms, withheld fields and the sections the site uses", () => {
		const f = clientRepoFiles(input());
		expect(f["docs/forms-and-integrations.md"]).toContain("| Contact (`fluent-forms-1`) | Name, Email | Message |");
		expect(f["docs/forms-and-integrations.md"]).toContain("through Brevo");
		expect(f["docs/editor-guide.md"]).toContain("| Hero | Page introduction |");
	});
	it("rewrites marked files and leaves taken-over ones alone", () => {
		const dir = mkdtempSync(join(tmpdir(), "client-repo-"));
		const files = clientRepoFiles(input());
		expect(writeClientRepo(dir, files)).toEqual([]);
		expect(readFileSync(join(dir, "README.md"), "utf8")).toContain(MARKER);
		writeFileSync(join(dir, "README.md"), "# Our own README\n");
		expect(writeClientRepo(dir, files)).toEqual(["README.md"]);
		expect(readFileSync(join(dir, "README.md"), "utf8")).toBe("# Our own README\n");
	});
	it("explains sharing cards in the editor guide only when they are on", () => {
		expect(clientRepoFiles(input())["docs/editor-guide.md"]).not.toContain("## Sharing images");
		const on = clientRepoFiles(input({ ogCards: true }))["docs/editor-guide.md"] as string;
		expect(on).toContain("## Sharing images");
		expect(on).toContain("Plugins → Sharing");
		expect(on).toContain("`@wp2emdash/og`");
	});
});
