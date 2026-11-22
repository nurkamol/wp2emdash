import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { APP_FEATURES, appFeaturesReport, appGateDetail, blockingAppFeatures, detectAppFeatures, scanAppSignals } from "../src/audit/app-features.js";
import { fingerprint } from "../src/audit/fingerprint.js";
import { parsePage } from "../src/audit/page.js";
import { siteHosts } from "../src/audit/urls.js";
import { adaptersFor, findingsFor } from "../src/estimate/blockers.js";
import { computeEffort } from "../src/estimate/effort.js";
import { DEFAULT_RULES } from "../src/estimate/rules.js";
import type { Detections } from "../src/estimate/types.js";

// Synthetic pages only (test/fixtures/app-features): no real site.
const ORIGIN = "https://example-studio.test";
const site = siteHosts(ORIGIN);
const load = (name: string, path = "/") => {
	const html = readFileSync(join(import.meta.dirname, "fixtures/app-features", name), "utf8");
	const url = `${ORIGIN}${path}`;
	const page = parsePage(html, { url, finalUrl: url, status: 200, redirects: [], contentType: "text/html", ms: 1 }, site);
	return { html, page, signals: scanAppSignals(html, page) };
};
const detect = (name: string, path?: string) => detectAppFeatures({ pages: [load(name, path).signals] });
const ids = (name: string, path?: string) => detect(name, path).map((d) => d.id);

describe("app features catalogue", () => {
	it("gives every entry a category, a handling, a suggested path and an effort note, with unique ids", () => {
		expect(new Set(APP_FEATURES.map((e) => e.id)).size).toBe(APP_FEATURES.length);
		for (const e of APP_FEATURES) {
			expect(e.path.length).toBeGreaterThan(20);
			expect(e.effort.length).toBeGreaterThan(20);
			// Each entry has at least one strong signal: a plugin folder, a REST namespace, a class, a tag or a password form.
			expect(e.plugins.length + (e.rest?.length ?? 0) + (e.bodyClasses?.length ?? 0) + (e.tokens?.length ?? 0) + (e.tags?.length ?? 0) + (e.passwordForm ? 1 : 0)).toBeGreaterThan(0);
		}
		// Only WooCommerce has catalogue mode; bookings and tickets get an embed recommendation.
		expect(APP_FEATURES.filter((e) => e.handling === "catalogue-mode").map((e) => e.id)).toEqual(["woocommerce"]);
		expect(new Set(APP_FEATURES.filter((e) => e.handling === "external-embed").map((e) => e.category))).toEqual(new Set(["booking", "events"]));
	});
});

describe("app features from public HTML, one per category", () => {
	it("LMS: LearnDash from its asset folder, body classes and markup; course addresses as supporting evidence", () => {
		const [d] = detect("lms-learndash.html", "/courses/teacher-training/");
		expect(d).toMatchObject({ id: "learndash", category: "lms", handling: "out-of-scope", pages: ["/courses/teacher-training/"] });
		expect(d?.evidence).toEqual(expect.arrayContaining(["plugin assets /wp-content/plugins/sfwd-lms/", "body class learndash-cpt", "markup class/id learndash-wrapper", "address /courses/teacher-training/"]));
	});

	it("membership: Paid Memberships Pro", () => {
		expect(ids("membership-pmpro.html", "/membership-levels/")).toEqual(["paid-memberships-pro"]);
	});

	it("cart/checkout: WooCommerce in catalogue mode, with the checkout page active; its own login form is not a front-end login", () => {
		const d = detect("commerce-woo-checkout.html", "/checkout/");
		expect(d.map((x) => x.id)).toEqual(["woocommerce"]);
		expect(d[0]).toMatchObject({ handling: "catalogue-mode", cartActive: true });
		expect(d[0]?.evidence).toEqual(expect.arrayContaining(["generator tag WooCommerce 9.4.1", "body class woocommerce-checkout"]));
	});

	it("cart/checkout: SureCart from its block class and custom element (no asset folder needed)", () => {
		const d = detect("commerce-surecart.html", "/guide/");
		expect(d.map((x) => x.id)).toEqual(["surecart"]);
		expect(d[0]?.evidence).toEqual(expect.arrayContaining(["element <sc-buy-button>"]));
	});

	it("bookings: Amelia, with an embed recommendation", () => {
		expect(detect("booking-amelia.html", "/book/")).toEqual([expect.objectContaining({ id: "amelia", category: "booking", handling: "external-embed" })]);
	});

	it("events: Event Tickets is detected; The Events Calendar alone is content and is not", () => {
		expect(ids("events-tickets.html", "/event/spring-workshop/")).toEqual(["event-tickets"]);
		expect(ids("events-calendar-only.html", "/events/")).toEqual([]);
	});

	it("community: bbPress", () => {
		expect(ids("community-bbpress.html", "/forums/")).toEqual(["bbpress"]);
	});

	it("accounts: a password field on a public page; not the protected-post form", () => {
		expect(ids("accounts-login.html", "/portal/")).toEqual(["front-end-login"]);
		expect(ids("password-protected-post.html", "/staff-notes/")).toEqual([]);
	});

	it("no false positives: a theme that talks about courses, memberships, bookings and checkout, with such classes and links", () => {
		const { signals } = load("theme-mentions.html", "/courses/");
		expect(detectAppFeatures({ pages: [signals] })).toEqual([]);
		// Only addresses matched, and addresses alone never make a detection.
		expect(signals.signals.every((s) => s.kind === "address" && !s.strong)).toBe(true);
	});
});

describe("app features from the plugin list and REST namespaces", () => {
	it("detects from REST namespaces (prefix match, not substring) and from the fingerprint's asset folders", () => {
		const d = detectAppFeatures({ pages: [], restNamespaces: ["wp/v2", "ldlms/v2", "tribe/tickets/v1", "wc-bookings/v1", "edd-extra/v1"], plugins: [{ slug: "bookly-responsive-appointment-booking-tool", evidence: ["assets"] }] });
		expect(d.map((x) => x.id).sort()).toEqual(["bookly", "event-tickets", "learndash", "woocommerce-bookings"]);
		expect(d.find((x) => x.id === "learndash")?.evidence).toEqual(["REST namespace ldlms/v2"]);
	});

	it("leaves the generic login out when a membership or course plugin explains it", () => {
		const login = load("accounts-login.html", "/portal/").signals;
		const pmpro = load("membership-pmpro.html", "/levels/").signals;
		expect(detectAppFeatures({ pages: [login, pmpro] }).map((x) => x.id)).toEqual(["paid-memberships-pro"]);
	});

	it("the fingerprint's plugin matrix takes its app plugins from the catalogue", () => {
		const { page, html } = load("booking-amelia.html");
		const fp = fingerprint([page], [], [html]);
		expect(fp.plugins.find((p) => p.slug === "ameliabooking")).toMatchObject({ name: "Amelia", action: "out-of-scope" });
		expect(fp.plugins.find((p) => p.slug === "ameliabooking")?.replacement).toContain("hosted scheduling service");
	});
});

describe("audit gate semantics", () => {
	const all = [...detect("lms-learndash.html"), ...detect("commerce-woo-checkout.html", "/checkout/"), ...detect("booking-amelia.html")];

	it("out-of-scope and embed features always stop the gate; WooCommerce only until the owner chose catalogue mode", () => {
		expect(blockingAppFeatures(all, { shopDecided: false }).map((d) => d.id)).toEqual(["learndash", "woocommerce", "amelia"]);
		expect(blockingAppFeatures(all, { shopDecided: true }).map((d) => d.id)).toEqual(["learndash", "amelia"]);
		expect(blockingAppFeatures(detect("commerce-woo-checkout.html"), { shopDecided: true })).toEqual([]);
	});

	it("says what was found, where it goes, and how the owner's decision is recorded (never automatic)", () => {
		const detail = appGateDetail(blockingAppFeatures(all, { shopDecided: true }), "example-studio");
		expect(detail).toContain("LearnDash (online courses; out of scope: plugin assets /wp-content/plugins/sfwd-lms/)");
		expect(detail).toContain("Amelia (bookings; out of scope — embed a hosted service instead");
		expect(detail).toContain('wp2emdash accept example-studio audit --reason "<the owner\'s decision>"');
		expect(appGateDetail([], "example-studio")).toBeUndefined();
		const report = appFeaturesReport(all, { title: "# App features — Example Studio", shopDecided: true, slug: "example-studio" });
		expect(report).toContain("| WooCommerce (cart and checkout) | cart and checkout | catalogue mode by owner decision | passes (shop decided) |");
		expect(report).toContain("| LearnDash | online courses | out of scope | stops the audit |");
		expect(report).toContain("cart / checkout pages active");
		expect(appFeaturesReport([], { title: "# App features", shopDecided: false, slug: "x" })).toContain("None detected.");
	});
});

describe("estimate: a blocker and a scope line per detection", () => {
	const d = (o: Partial<Detections>): Detections => ({
		url: `${ORIGIN}/`,
		origin: ORIGIN,
		host: "example-studio.test",
		at: "2026-11-22T10:00:00.000Z",
		homeStatus: 200,
		isWordPress: true,
		robots: { present: false, blocked: 0 },
		sitemaps: 1,
		restAvailable: true,
		restNamespaces: ["wp/v2"],
		types: [{ slug: "page", count: 5 }],
		terms: 0,
		discovered: 5,
		discoveredCapped: false,
		urlGuess: { pages: 5, posts: 0, archives: 0 },
		sample: [{ url: `${ORIGIN}/`, status: 200, builders: ["gutenberg"], forms: 0, words: 100, passwordField: false }],
		builders: { gutenberg: 1 },
		plugins: [],
		hiddenWpPaths: false,
		integrations: [],
		multilingual: { languages: [], otherHosts: 0 },
		multisite: false,
		accounts: { loginForms: 0, accountLinks: [] },
		...o,
	});

	it("turns each detection into an excluded blocker with the suggested path, and a linking/embedding line in the effort", () => {
		const apps = [...detect("booking-amelia.html", "/book/"), ...detect("community-bbpress.html", "/forums/")];
		const det = d({ appFeatures: apps });
		const a = adaptersFor(det);
		const f = findingsFor(det, a);
		const amelia = f.find((x) => x.id === "app-amelia");
		expect(amelia).toMatchObject({ level: "blocker", excluded: true, title: "Amelia (bookings)" });
		expect(amelia?.handling).toContain("hosted scheduling service");
		expect(f.find((x) => x.id === "app-bbpress")).toMatchObject({ level: "blocker", excluded: true });
		const e = computeEffort(det, a, f, DEFAULT_RULES);
		expect(e.excluded).toEqual(expect.arrayContaining(["Amelia (bookings)", "bbPress (forum / community)"]));
		expect(e.lines.find((l) => l.id === "app-amelia")).toMatchObject({ label: "Amelia: embed or link the hosted service", hours: DEFAULT_RULES.effort.perAppFeature });
		expect(e.lines.find((l) => l.id === "app-bbpress")?.basis).toContain("Not estimated");
	});

	it("WooCommerce stays with the shop findings (catalogue mode), not an app blocker", () => {
		const det = d({ appFeatures: detect("commerce-woo-checkout.html", "/checkout/"), plugins: [{ slug: "woocommerce", name: "WooCommerce", evidence: ["assets"], action: "out-of-scope", replacement: "" }] });
		const f = findingsFor(det, adaptersFor(det));
		expect(f.some((x) => x.id.startsWith("app-"))).toBe(false);
		expect(f.find((x) => x.id === "shop")).toMatchObject({ level: "decision" });
	});

	it("a generic login form is a blocker; account links alone stay a question for the owner", () => {
		const login = d({ appFeatures: detect("accounts-login.html", "/portal/"), accounts: { loginForms: 1, accountLinks: ["/portal/"] } });
		const f1 = findingsFor(login, adaptersFor(login));
		expect(f1.find((x) => x.id === "app-front-end-login")).toMatchObject({ level: "blocker" });
		expect(f1.some((x) => x.id === "user-accounts")).toBe(false);
		const links = d({ appFeatures: [], accounts: { loginForms: 0, accountLinks: ["/login/"] } });
		expect(findingsFor(links, adaptersFor(links)).find((x) => x.id === "user-accounts")).toMatchObject({ level: "decision" });
	});
});
