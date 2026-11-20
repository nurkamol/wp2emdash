/**
 * WordPress users → team invite list (src/transform/users.ts, src/commands/invite.ts). Names and e-mail addresses are
 * personal data: they may appear only under sites/<slug>/users/; ir/, reports, gate details, command output and the
 * client repository carry counts per role. Load never invites anybody; `wp2emdash invite --send` does, when the owner
 * runs it. All users here are synthetic (example.test addresses).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { invite } from "../src/commands/invite.js";
import { overridesSchema } from "../src/config/overrides.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { runTransform } from "../src/phases/transform.js";
import { clientRepoFiles, goLiveExtras } from "../src/scaffold/client-repo.js";
import { EmDashHttpError } from "../src/targets/emdash/api.js";
import { inviteChecklist, inviteCounts, planInvites, readInvites, roleFor, usersReport, type WpUser, writeInvites, wpUsersFromRest } from "../src/transform/users.js";

const USERS: WpUser[] = [
	{ id: 1, name: "Agency Admin", email: "admin@agency.example.test", roles: ["administrator"] },
	{ id: 2, name: "Owner Person", email: "owner@studio.example.test", roles: ["editor", "author"] },
	{ id: 3, name: "Writer One", email: "writer@studio.example.test", roles: ["author"] },
	{ id: 4, name: "Guest Writer", email: "guest@studio.example.test", roles: ["contributor"] },
	{ id: 5, name: "Member", email: "member@studio.example.test", roles: ["subscriber"] },
	{ id: 6, name: "Shop Manager", email: "shop@studio.example.test", roles: ["shop_manager"] },
	{ id: 7, name: "No Mail", roles: ["editor"] },
	{ id: 8, name: "Twin", email: "WRITER@studio.example.test", roles: ["author"] },
	{ id: 9, name: "Former Staff", email: "former@studio.example.test", roles: ["editor"] },
];
const NAMES_AND_ADDRESSES = /@|Owner Person|Writer One|Agency Admin|Guest Writer|Shop Manager|Former Staff/;

describe("role mapping and the invite list", () => {
	it("extract keeps id, name, e-mail and roles only", () => {
		expect(wpUsersFromRest([{ id: 3, name: "A", email: "a@x.example.test", roles: ["editor"], avatar_urls: { 96: "https://x" }, capabilities: { edit_posts: true }, url: "https://a.example.test" } as never, { id: 4 }])).toEqual([{ id: 3, name: "A", email: "a@x.example.test", roles: ["editor"] }, { id: 4, name: "", roles: [] }]);
	});

	it("WordPress roles map to EmDash roles (the highest wins); subscribers and plugin roles are skipped by default", () => {
		expect(roleFor(["administrator"]).role).toBe("ADMIN");
		expect(roleFor(["author", "editor"]).role).toBe("EDITOR");
		expect(roleFor(["contributor"]).role).toBe("CONTRIBUTOR");
		expect(roleFor(["subscriber"]).role).toBeUndefined();
		expect(roleFor(["shop_manager"])).toEqual({ unmapped: ["shop_manager"] });
		expect(roleFor(["shop_manager"], { shop_manager: "EDITOR" }).role).toBe("EDITOR");
		expect(roleFor(["subscriber"], { subscriber: "SUBSCRIBER" }).role).toBe("SUBSCRIBER");
	});

	it("plan: invites with a role and an address; the rest listed with the reason; overrides decide", () => {
		const plan = planInvites(USERS, { skip: [9] });
		expect(plan.invites.map((i) => [i.wpId, i.role])).toEqual([[1, "ADMIN"], [2, "EDITOR"], [3, "AUTHOR"], [4, "CONTRIBUTOR"]]);
		expect(Object.fromEntries(plan.skipped.map((s) => [s.wpId, s.why]))).toEqual({
			5: "role subscriber not invited by default",
			6: "role shop_manager has no EmDash mapping (decide in overrides.ts users.roles)",
			7: "no readable e-mail address (extract needs an administrator's application password)",
			8: "same e-mail address as another user",
			9: "skipped by decision (overrides.ts users.skip)",
		});
		const counts = inviteCounts(plan);
		expect(counts).toEqual({ invite: { ADMIN: 1, EDITOR: 1, AUTHOR: 1, CONTRIBUTOR: 1 }, skipped: { author: 1, editor: 2, shop_manager: 1, subscriber: 1 }, unmappedRoles: ["shop_manager"] });
		const decided = planInvites(USERS, overridesSchema.parse({ users: { roles: { shop_manager: "EDITOR", subscriber: "SUBSCRIBER" } } }).users);
		expect(decided.invites.find((i) => i.wpId === 6)?.role).toBe("EDITOR");
		expect(decided.invites.find((i) => i.wpId === 5)?.role).toBe("SUBSCRIBER");
	});

	it("report and checklist: the report has counts only; the checklist (personal) has names, addresses and roles", () => {
		const plan = planInvites(USERS);
		const report = usersReport(inviteCounts(plan)).join("\n");
		expect(report).toMatch(/\| ADMIN \| 1 \|/);
		expect(report).toMatch(/`shop_manager`/);
		expect(report).not.toMatch(NAMES_AND_ADDRESSES);
		const md = inviteChecklist("Example Studio", plan);
		expect(md).toMatch(/\| {3}\| Owner Person \| owner@studio\.example\.test \| EDITOR \| editor, author \|/);
		expect(md).toMatch(/## Not invited/);
		expect(md).toMatch(/passwords do not move/i);
	});
});

describe("transform writes the invite list under users/ only", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2e-users-"));
	const paths = sitePaths("u", dir);
	const put = (f: string, d: unknown) => {
		mkdirSync(join(f, ".."), { recursive: true });
		writeFileSync(f, JSON.stringify(d));
	};
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "options.json"), { blogname: "Example Studio", page_on_front: 1 });
	put(join(paths.raw, "exporter", "content", "page.json"), [{ id: 1, post_type: "page", status: "publish", slug: "home", title: "Home", content: "<!-- wp:paragraph --><p>Hi.</p><!-- /wp:paragraph -->", excerpt: "", date_gmt: "", modified_gmt: "", parent: null, menu_order: 0, taxonomies: {}, meta: {} }]);
	put(join(paths.root, "users", "wordpress-users.json"), USERS);
	writeFileSync(paths.overrides, "export default { users: { skip: [9] } };\n");
	const config = kitConfigSchema.parse({ slug: "u", name: "Example Studio", source: { url: "https://users.example.test" }, target: { productionUrl: "https://users.example.test" } });
	const checks = await runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });

	it("users/invites.json and invite-checklist.md (owner-only file mode); ir/users.json and the reports hold counts only", () => {
		const plan = readInvites(paths.root);
		expect(plan?.invites.map((i) => i.email)).toEqual(["admin@agency.example.test", "owner@studio.example.test", "writer@studio.example.test", "guest@studio.example.test"]);
		expect(statSync(join(paths.root, "users", "invites.json")).mode & 0o077).toBe(0);
		expect(readFileSync(join(paths.root, "users", "invite-checklist.md"), "utf8")).toContain("owner@studio.example.test");
		expect(JSON.parse(readFileSync(join(paths.ir, "users.json"), "utf8"))).toEqual({ invite: { ADMIN: 1, EDITOR: 1, AUTHOR: 1, CONTRIBUTOR: 1 }, skipped: { author: 1, editor: 2, shop_manager: 1, subscriber: 1 }, unmappedRoles: ["shop_manager"] });
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/## Users and roles/);
		// Nothing personal anywhere in ir/, reports/ or the gate details.
		const scan = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? scan(join(d, e.name)) : [readFileSync(join(d, e.name), "utf8")]));
		for (const text of [...scan(paths.ir), ...scan(paths.reports), JSON.stringify(checks)]) expect(text).not.toMatch(/example\.test\b.*@|@[a-z]+\.example\.test|Owner Person|Writer One|Former Staff/);
	});

	it("a rerun keeps what invite --send recorded", () => {
		const plan = readInvites(paths.root);
		if (!plan?.invites[0]) throw new Error("no plan");
		plan.invites[0].sent = { at: "2026-11-21T00:00:00.000Z", target: "production", result: "emailed" };
		writeInvites(paths.root, "Example Studio", plan);
		writeInvites(paths.root, "Example Studio", planInvites(USERS, { skip: [9] }));
		expect(readInvites(paths.root)?.invites[0]?.sent?.result).toBe("emailed");
		expect(readFileSync(join(paths.root, "users", "invite-checklist.md"), "utf8")).toMatch(/\| x \| Agency Admin \|/);
	});

	it("invite: without --send nothing is sent; with --send each pending invite once, link never kept, counts only", async () => {
		writeFileSync(paths.config, `export default ${JSON.stringify({ slug: "u", name: "Example Studio", source: { url: "https://users.example.test" }, target: { productionUrl: "https://users.example.test" } })};\n`);
		rmSync(join(paths.root, "users", "invites.json"));
		writeInvites(paths.root, "Example Studio", planInvites(USERS, { skip: [9] }));
		const calls: [string, number][] = [];
		const dry = await invite("u", { sitesDir: dir, api: { invite: async (e, r) => (calls.push([e, r]), {}) } });
		expect(dry).toMatchObject({ applied: false, pending: 4, plan: { ADMIN: 1, EDITOR: 1, AUTHOR: 1, CONTRIBUTOR: 1 } });
		expect(calls).toEqual([]);
		expect(JSON.stringify(dry)).not.toMatch(NAMES_AND_ADDRESSES);

		// The admin's address already has an account; the next two are e-mailed; then the site turns out to have no e-mail
		// provider: the invite is created, its link is not kept, and the command stops.
		const answers = [() => { throw new EmDashHttpError(409, "USER_EXISTS", "exists"); }, () => ({ message: "Invite sent" }), () => ({ message: "Invite sent" }), () => ({ message: "share manually", inviteUrl: "https://users.example.test/_emdash/admin/invite/accept?token=SECRET-TOKEN" })];
		const sent = await invite("u", { sitesDir: dir, send: true, target: "production", api: { invite: async (e, r) => (calls.push([e, r]), (answers.shift() as () => object)()) } });
		expect(calls.map(([, r]) => r)).toEqual([50, 40, 30, 20]);
		expect(sent).toMatchObject({ applied: true, sent: { emailed: 2, createdNotEmailed: 1, exists: 1, errors: 0 }, stoppedNoEmail: true });
		expect(JSON.stringify(sent)).not.toMatch(NAMES_AND_ADDRESSES);
		for (const f of readdirSync(join(paths.root, "users"))) expect(readFileSync(join(paths.root, "users", f), "utf8")).not.toContain("SECRET-TOKEN");
		// Nothing left to send.
		calls.length = 0;
		const again = await invite("u", { sitesDir: dir, send: true, target: "production", api: { invite: async (e, r) => (calls.push([e, r]), {}) } });
		expect(again.pending).toBe(0);
		expect(calls).toEqual([]);
	});

	it("invite: a token without the admin scope stops at the first refusal; local is not a target", async () => {
		rmSync(join(paths.root, "users", "invites.json"));
		writeInvites(paths.root, "Example Studio", planInvites(USERS, { skip: [9] }));
		let n = 0;
		const r = await invite("u", { sitesDir: dir, send: true, target: "production", api: { invite: async () => { n++; throw new EmDashHttpError(403, "INSUFFICIENT_SCOPE", "x"); } } });
		expect(n).toBe(1);
		expect(r.sent.errors).toBe(1);
		expect(r.next.join(" ")).toMatch(/admin scope/);
		await expect(invite("u", { sitesDir: dir, send: true, target: "local", api: { invite: async () => ({}) } })).rejects.toThrow(/deployed site/);
	});
});

describe("client docs: go-live checklist", () => {
	const input = { name: "Example Studio", slug: "example", sourceUrl: "https://example.com", productionUrl: "https://example.com", workerName: "example", stagingUrl: "https://s.example.workers.dev", productionReady: false, sections: [], forms: [], email: { provider: "brevo", to: ["owner@example.com"] }, turnstileProduction: false, sensitiveData: false, stack: {} };

	it("form entries are exported by the owner before WordPress goes; team invites by count, never by name", () => {
		const extras = goLiveExtras({ invites: { ADMIN: 1, EDITOR: 2 } });
		expect(extras).toMatch(/Form entries exported from WordPress by the owner/);
		expect(extras).toMatch(/3 from the old site \(1 admin, 2 editor\)/);
		expect(goLiveExtras({})).not.toMatch(/from the old site/);
		for (const staging of [true, false]) {
			const files = clientRepoFiles({ ...input, staging, invites: { ADMIN: 1 } });
			const live = files["docs/go-live.md"] as string;
			expect(live).toMatch(/- \[ \] Form entries exported from WordPress/);
			expect(live).toMatch(/- \[ \] Team accounts: the owner invites/);
			expect(live).toMatch(/make sure the form entries were exported/);
			expect(live).not.toMatch(/@studio|Owner Person/);
		}
	});
});
