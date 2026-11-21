import { describe, expect, it } from "vitest";
import { previewKey } from "../packages/health/src/plugin/index.js";
import { page, type PageData, TABS } from "../packages/health/src/plugin/views.js";
import { parseMaintenance, previewAccess } from "../starter/src/utils/maintenance.js";

const KEY = "abcdefghijklmnopqrstuvwxyz012345";

describe("coming-soon preview link", () => {
	it("keys are URL-safe and accepted by the middleware's parser", () => {
		const k = previewKey();
		expect(k).toMatch(/^[A-Za-z0-9_-]{32}$/);
		expect(previewKey()).not.toBe(k);
		expect(parseMaintenance(JSON.stringify({ on: true, previewKey: k })).previewKey).toBe(k);
	});
	it("ignores a malformed key", () => {
		expect(parseMaintenance(JSON.stringify({ on: true, previewKey: "short" })).previewKey).toBeUndefined();
		expect(parseMaintenance(JSON.stringify({ on: true, previewKey: "<script>alert(1)</script>xxxxxxxxxxx" })).previewKey).toBeUndefined();
	});
	it("opens the site for the link and the cookie, only with the current key, only while on", () => {
		const on = parseMaintenance(JSON.stringify({ on: true, previewKey: KEY }));
		expect(previewAccess(on, KEY, undefined)).toBe("link");
		expect(previewAccess(on, null, KEY)).toBe("cookie");
		expect(previewAccess(on, "x".repeat(32), "y".repeat(32))).toBeNull();
		expect(previewAccess(on, null, undefined)).toBeNull();
		expect(previewAccess(parseMaintenance(JSON.stringify({ on: true })), KEY, KEY)).toBeNull();
		expect(previewAccess(parseMaintenance(JSON.stringify({ on: false, previewKey: KEY })), KEY, KEY)).toBeNull();
	});
	it("Settings shows the link on the admin's own address", () => {
		const d = { state: { checks: {}, jobs: {} }, today: null, history: [], incidents: [], links: null, cwv: null, reports: [], settings: {}, defaults: { alertsTo: [], reportTo: [] }, email: { ready: true, provider: "brevo" }, live: false, staging: false, secrets: { crux: false, zone: false, analytics: false }, selfBinding: true, productionUrl: "https://acme.example", siteOrigin: "https://acme-site.acct.workers.dev", maintenance: { on: true, previewKey: KEY } } as unknown as PageData;
		const s = JSON.stringify(page(d, TABS.settings));
		expect(s).toContain(`https://acme-site.acct.workers.dev/?preview=${KEY}`);
		expect(s).toContain('"action_id":"preview-new"');
		const none = JSON.stringify(page({ ...d, maintenance: { on: false } }, TABS.settings));
		expect(none).toContain("Create a preview link");
	});
});
