import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { versionAtLeast } from "../src/commands/doctor.js";
import { initSite } from "../src/commands/init.js";
import { acceptPhase, runPhase } from "../src/commands/run.js";
import { loadConfig } from "../src/config/load.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { acceptGate, blockingPhase, newState, nextPhase, readState, recordGate } from "../src/core/state.js";
import { parseChecklist } from "../src/phases/init.js";

const answers = {
	slug: "acme",
	name: "Acme Clinic",
	sourceUrl: "https://acme.example",
	productionUrl: "https://acme.example",
	sensitiveData: true,
};

describe("config schema", () => {
	it("fills defaults: brevo email, 3 viewports, 3% visual gate", () => {
		const c = kitConfigSchema.parse({
			slug: "acme",
			name: "Acme",
			source: { url: "https://acme.example" },
			target: { productionUrl: "https://acme.example" },
		});
		expect(c.email.provider).toBe("brevo");
		expect(c.audit.viewports.map((v) => v.width)).toEqual([390, 768, 1440]);
		expect(c.gates.visualDiff).toBe(0.03);
		expect(c.target.template).toBe("cloudflare:marketing");
		expect(c.target.staging.protection).toBe("access");
		expect(c.target.cutover).toEqual({ method: "route", monitorDays: 14, keepWordPressDays: 30 });
	});

	it("rejects bad slugs and unknown email providers", () => {
		const base = { name: "x", source: { url: "https://a.b" }, target: { productionUrl: "https://a.b" } };
		expect(kitConfigSchema.safeParse({ ...base, slug: "Bad Slug" }).success).toBe(false);
		expect(kitConfigSchema.safeParse({ ...base, slug: "ok", email: { provider: "smtp" } }).success).toBe(false);
	});
});

describe("state machine", () => {
	it("enforces phase order and next phase", () => {
		let s = newState("acme");
		expect(nextPhase(s)).toBe("init");
		expect(blockingPhase(s, "audit")).toBe("init");
		s = recordGate(s, "init", [{ id: "a", label: "a", ok: true }], { runId: "r", startedAt: "t" });
		expect(blockingPhase(s, "audit")).toBeUndefined();
		expect(blockingPhase(s, "extract")).toBe("audit");
		expect(nextPhase(s)).toBe("audit");
	});

	it("only accepts failed gates, with a real reason", () => {
		let s = newState("acme");
		expect(() => acceptGate(s, "init", "because reasons")).toThrow(/Only a failed gate/);
		s = recordGate(s, "init", [{ id: "a", label: "a", ok: false }], { runId: "r", startedAt: "t" });
		expect(() => acceptGate(s, "init", "meh")).toThrow(/real reason/);
		s = acceptGate(s, "init", "Backup verified by host support ticket #123");
		expect(s.phases.init?.status).toBe("accepted");
		expect(nextPhase(s)).toBe("audit");
	});
});

describe("ACCESS.md checklist", () => {
	it("parses sections, required markers and ticks", () => {
		const items = parseChecklist("## Before audit\n- [x] (required) Backup\n- [ ] (required) DNS\n- [ ] optional\n## Later\n- [ ] (required) Zone");
		expect(items).toHaveLength(4);
		expect(items[0]).toMatchObject({ text: "Backup", done: true, required: true, section: "Before audit" });
		expect(items[1]).toMatchObject({ done: false, required: true });
		expect(items[2]).toMatchObject({ required: false });
		expect(items[3]).toMatchObject({ section: "Later" });
	});
});

describe("init → gate flow (filesystem)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("creates a workspace that loads, refuses to overwrite", async () => {
		initSite(answers, dir);
		const p = sitePaths("acme", dir);
		const config = await loadConfig(p.config);
		expect(config.sensitiveData).toBe(true);
		expect(readState(p.state).phases.init?.status).toBe("pending");
		expect(() => initSite(answers, dir)).toThrow(/already exists/);
	});

	it("init gate fails until required items are ticked; later phases are blocked", async () => {
		initSite(answers, dir);
		const p = sitePaths("acme", dir);

		await expect(runPhase("acme", "audit", { sitesDir: dir, json: true })).rejects.toThrow(/gate "init"/);

		const first = await runPhase("acme", "init", { sitesDir: dir, json: true });
		expect(first.ok).toBe(false);
		expect(first.checks.length).toBe(4);

		writeFileSync(p.access, readFileSync(p.access, "utf8").replaceAll("- [ ] (required)", "- [x] (required)"));
		const second = await runPhase("acme", "init", { sitesDir: dir, json: true });
		expect(second.ok).toBe(true);

		await expect(runPhase("acme", "extract", { sitesDir: dir, json: true })).rejects.toThrow(/gate "audit"/);
	});

	it("accept writes the decision log", async () => {
		initSite(answers, dir);
		await runPhase("acme", "init", { sitesDir: dir, json: true });
		acceptPhase("acme", "init", "DNS export pending, not needed until cutover", "Owner", dir);
		const p = sitePaths("acme", dir);
		expect(readFileSync(p.decisions, "utf8")).toMatch(/\| init \| Accepted failed gate \| DNS export pending/);
		expect(readState(p.state).phases.init?.status).toBe("accepted");
	});
});

describe("doctor", () => {
	it("compares versions", () => {
		expect(versionAtLeast("v24.21.0", "22.23.4")).toBe(true);
		expect(versionAtLeast("v22.23.4", "22.23.4")).toBe(true);
		expect(versionAtLeast("v22.9.0", "22.23.4")).toBe(false);
	});
});

describe("audit helpers", () => {
	it("decodes Cloudflare-obfuscated emails", async () => {
		const { decodeCfEmail } = await import("../src/audit/page.js");
		// "a@b.co" XOR 0x42
		const key = 0x42;
		const hex = [key, ..."a@b.co"].map((c) => (typeof c === "number" ? c : c.charCodeAt(0) ^ key).toString(16).padStart(2, "0")).join("");
		expect(decodeCfEmail(hex)).toBe("a@b.co");
	});

	it("names screenshots from paths", async () => {
		const { screenName } = await import("../src/audit/browser.js");
		expect(screenName("https://x.com/")).toBe("home");
		expect(screenName("https://x.com/about-us/")).toBe("about_us");
		expect(screenName("https://x.com/?p=1")).toMatch(/^home__q/);
	});
});

describe("motion recipe", () => {
	it("derives overlay, icon and staggered item reveal from raw animations", async () => {
		const { motionRecipe } = await import("../src/audit/interactions.js");
		const a = (target: string, name: string, durationMs: number, delayMs: number, easing = "ease") => ({ target, kind: "transition" as const, name, durationMs, delayMs, easing, iterations: 1 as const, keyframes: [] });
		const recipe = motionRecipe({
			viewport: "mobile",
			url: "x",
			found: true,
			items: [],
			themeSettings: {},
			files: { frames: [] },
			behaviour: { bodyScrollLocked: true, focusMovedIntoPanel: true, escCloses: true, toggleClosesAgain: true },
			panel: { selector: "div", type: "fullscreen", rect: { x: 0, y: 0, width: 1, height: 1 }, background: "", zIndex: "1" },
			openDurationMs: 1200,
			animations: [
				a("div#slide-out-widget-area-bg.open", "opacity", 300, 0),
				a("i.lines", "transform", 650, 0, "cubic-bezier(0.3, 1, 0.3, 1)"),
				a("i.lines-button.x2", "transform", 650, 40, "cubic-bezier(0.3, 1, 0.3, 1)"),
				...[160, 180, 200, 220].flatMap((d) => [a("li.menu-item", "opacity", 500, d), a("li.menu-item", "transform", 850, d, "cubic-bezier(0.2, 0.75, 0.5, 1)")]),
			],
		});
		expect(recipe.overlay?.durationMs).toBe(300);
		expect(recipe.icon).toMatchObject({ durationMs: 650, staggerMs: 40 });
		expect(recipe.items).toMatchObject({ durationMs: 850, easing: "cubic-bezier(0.2, 0.75, 0.5, 1)", startDelayMs: 160, staggerMs: 20, count: 4 });
		expect(recipe.items?.properties.sort()).toEqual(["opacity", "transform"]);
	});

	it("recognises bare <li> items and rounds float-noise delays", async () => {
		const { motionRecipe } = await import("../src/audit/interactions.js");
		const a = (target: string, name: string, durationMs: number, delayMs: number) => ({ target, kind: "transition" as const, name, durationMs, delayMs, easing: "ease", iterations: 1 as const, keyframes: [] });
		const r = motionRecipe({
			viewport: "mobile",
			url: "x",
			found: true,
			items: [],
			themeSettings: {},
			files: { frames: [] },
			behaviour: { bodyScrollLocked: true, focusMovedIntoPanel: true, escCloses: true, toggleClosesAgain: true },
			openDurationMs: 900,
			animations: [a("li", "opacity", 850, 160), a("li.has-children", "opacity", 850, 180.00000000000003), a("li", "opacity", 850, 200), a("p.credit", "opacity", 850, 220)],
		});
		expect(r.items).toMatchObject({ durationMs: 850, startDelayMs: 160, staggerMs: 20, count: 3 });
	});
});
