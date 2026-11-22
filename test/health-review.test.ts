/**
 * Site health: accessibility (checks/a11y.ts) and content freshness (checks/freshness.ts), built with the weekly visual
 * check (review.ts, visual.ts), shown on their tabs, dismissable, and fed into "What to improve". Synthetic HTML in
 * the starter's markup; no network — the site and the content API are mocks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A11Y_PER_RULE, A11Y_RULES, altIsFileName, fileName, groupA11y, inspectA11y, isSiteWide, itemId, MAX_A11Y_ITEMS } from "../packages/health/src/checks/a11y.js";
import { entryText, findStale, groupStale, inspectFreshness, isRarelyChanged, MAX_STALE_ITEMS, staleCutoff } from "../packages/health/src/checks/freshness.js";
import { MAX_VISUAL_PAGES, startVisual, stepVisual } from "../packages/health/src/checks/visual.js";
import { editLink, improvements, improveUrl } from "../packages/health/src/improve.js";
import type { HealthOptions } from "../packages/health/src/index.js";
import { createPlugin } from "../packages/health/src/plugin/index.js";
import { accessibilityTab, freshnessTab, type PageData, page as healthPage, TABS } from "../packages/health/src/plugin/views.js";
import { activeReview, buildReview, dismiss, type Dismissed, isDismissed, listEntries, MAX_DISMISSED, parseDismissValue, readDismissed, readReview, restore, type ReviewStore } from "../packages/health/src/review.js";
import { currentImprovements, type RunDeps } from "../packages/health/src/run.js";
import { emptyState, KEYS } from "../packages/health/src/store.js";
import { pageInspector, runVisual } from "../packages/health/src/visual.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { healthOptions } from "../src/scaffold/health.js";
import { memoryKv } from "./health-fixtures.js";
import { env } from "./stubs/cloudflare-workers.js";

type B = Record<string, any>;
const ORIGIN = "https://acme.example";
const NOW = Date.UTC(2026, 10, 22, 12, 0, 0);
const DAY = 86_400_000;
const OPTIONS: HealthOptions = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: ["team@agency.example"], reportTo: ["owner@acme.example"], brand: { footer: "Prepared by Example Agency" } };

/** A page in the starter's markup: header (logo link, menu button), main, footer; parts can be replaced. */
function page(o: { lang?: string | null; main?: string; footer?: string; header?: string } = {}): string {
	const lang = o.lang === null ? "" : ` lang="${o.lang ?? "en"}"`;
	const header =
		o.header ??
		`<header class="site-header"><button class="menu-toggle" type="button" aria-expanded="false"><span class="menu-toggle__icon" aria-hidden="true"><i class="menu-toggle__line"></i></span><span class="visually-hidden">Menu</span></button><a href="/" class="site-header__logo" aria-label="Acme — home"><img src="/brand/logo.png" alt="" class="logo"></a><nav><a href="/about/">About</a></nav></header>`;
	const main = o.main ?? `<section class="section section--hero"><h1>Pilates in Portland</h1><p>Classes for every level.</p></section><section class="section section--rich_text"><header class="section__head"><h2 class="heading">Our classes</h2></header><h3>Reformer</h3><img src="/_emdash/api/media/file/reformer.webp" alt="A reformer class in the studio"></section>`;
	const footer = o.footer ?? `<footer><p class="container">© 2026 Acme</p></footer>`;
	return `<!doctype html><html${lang}><head><title>Acme</title><script>var t = "Summer 2020 offer";</script></head><body>${header}<main id="main" tabindex="-1">${main}</main>${footer}<div class="motion-preloader" aria-hidden="true" hidden><img src="/brand/logo.png" alt=""></div></body></html>`;
}
const rules = (html: string) => inspectA11y(html).map((h) => h.r);

describe("accessibility rules (text-based)", () => {
	it("a clean starter page has no findings: decorative alt, named logo link, visually hidden menu label, preloader, honeypot", () => {
		const form = `<form class="form"><label class="field"><span>Name</span><input type="text" name="name"></label><label class="field"><span>Email</span><input type="email" name="email"></label><label class="choice"><input type="checkbox" name="ok" value="yes"> <span>I agree</span></label><input type="text" name="_hp" tabindex="-1" autocomplete="off" class="visually-hidden" aria-hidden="true"><input type="hidden" name="form" value="contact"><button type="submit" class="btn btn--primary">Send</button></form>`;
		const card = `<article class="post-card"><a href="/post/" class="post-card__media" tabindex="-1" aria-hidden="true"><img src="/x.jpg"></a><h2 class="post-card__title"><a href="/post/">A post</a></h2></article>`;
		const icons = `<a href="https://instagram.com/acme" aria-label="Instagram"><svg viewBox="0 0 24 24" aria-hidden="true"><defs><linearGradient id="g"></linearGradient></defs></svg></a><a href="https://facebook.com/acme"><svg aria-hidden="true"><defs><linearGradient id="g"></linearGradient></defs></svg><span class="visually-hidden">Facebook</span></a>`;
		const embed = `<iframe src="https://www.youtube-nocookie.com/embed/x" title="Studio tour video"></iframe><button class="popup__close" aria-label="Close">×</button>`;
		expect(inspectA11y(page({ main: `<h1>Contact</h1>${form}${card}${icons}${embed}<img src="/pixel.gif" width="1" height="1">` }))).toEqual([]);
		expect(inspectA11y(page())).toEqual([]);
	});
	it("pictures: a missing alt attribute and an alt that is the file name are flagged; alt=\"\" is fine", () => {
		const hits = inspectA11y(page({ main: `<h1>x</h1><img src="/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2FIMG_1234.jpg&w=640"><img src="/a/team-photo-1024x683.jpg" alt="team photo"><img src="/b.jpg" alt="DSC_0042"><img src="/c.jpg" alt="">` }));
		expect(hits).toEqual([
			{ r: "image-alt", el: `<img src="…/IMG_1234.jpg">` },
			{ r: "image-alt-filename", el: `<img alt="team photo">` },
			{ r: "image-alt-filename", el: `<img alt="DSC_0042">` },
		]);
		expect(altIsFileName("Our team at the studio", "/team.jpg")).toBe(false);
		expect(altIsFileName("hero.webp", undefined)).toBe(true);
		expect(fileName("data:image/png;base64,AA")).toBe("");
	});
	it("headings: no h1, several h1, a skipped level (two down only)", () => {
		expect(rules(page({ main: "<h2>A</h2><h3>B</h3>" }))).toEqual(["page-has-heading-one"]);
		expect(inspectA11y(page({ main: "<h1>A</h1><h1>B</h1>" }))).toEqual([{ r: "multiple-h1", el: "2 × <h1>" }]);
		expect(inspectA11y(page({ main: "<h1>A</h1><h2>B</h2><h4>Opening   hours</h4><h2>C</h2><h3>D</h3>" }))).toEqual([{ r: "heading-order", el: "h2 → h4: “Opening hours”" }]);
		// Going back up any number of levels is fine.
		expect(rules(page({ main: "<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h2>E</h2>" }))).toEqual([]);
	});
	it("links and buttons without a name; empty links; names from text, aria-label, title, picture alt or svg title", () => {
		const main = `<h1>x</h1><a href="https://instagram.com/acme"><svg viewBox="0 0 24 24"><path d="M0"/></svg></a><a href="/team/"><img src="/t.jpg" alt=""></a><a href="/x/"></a><a href="tel:+17135550199"><i class="icon"></i></a><button class="slider__next"><svg aria-hidden="true"></svg></button><input type="button"><input type="image" src="/go.png">
			<a href="/ok1/" title="Read more">›</a><a href="/ok2/"><img src="/o.jpg" alt="Our studio"></a><a href="/ok3/"><svg><title>Home</title></svg></a><button aria-labelledby="lbl"><i></i></button><span id="lbl">Next slide</span><input type="button" value="Go"><a name="anchor"></a>`;
		expect(inspectA11y(page({ main }))).toEqual([
			{ r: "link-name", el: `<a href="instagram.com/acme"> (icon only)` },
			{ r: "link-name", el: `<a href="/team/"> (picture without a description)` },
			{ r: "empty-link", el: `<a href="/x/">` },
			{ r: "link-name", el: `<a href="tel:…"> (icon only)` },
			{ r: "button-name", el: `<button class="slider__next">` },
			{ r: "button-name", el: `<input type="button">` },
			{ r: "button-name", el: `<input type="image">` },
		]);
	});
	it("form fields: label[for], wrapping label, aria-label, aria-labelledby, title or placeholder name a field; others are flagged", () => {
		const main = `<h1>x</h1><label for="a">A</label><input id="a" name="a"><input name="b" aria-label="B"><span id="cl">C</span><input name="c" aria-labelledby="cl"><input name="d" placeholder="Your email"><input name="e" title="E"><textarea name="msg"></textarea><select name="size"><option>S</option></select><input type="email" name="email"><input type="submit"><input type="reset">`;
		expect(inspectA11y(page({ main }))).toEqual([
			{ r: "label", el: `<textarea name="msg">` },
			{ r: "label", el: `<select name="size">` },
			{ r: "label", el: `<input type="email" name="email">` },
		]);
	});
	it("page language, embeds without a title, duplicate ids (not inside icons), hidden content and comments skipped", () => {
		const main = `<h1>x</h1><iframe src="https://www.google.com/maps/embed?pb=!1m18"></iframe><iframe src="/x" aria-hidden="true"></iframe><div id="book"></div><section id="book"></section><svg><defs><clipPath id="c"></clipPath></defs></svg><svg><defs><clipPath id="c"></clipPath></defs></svg><div hidden><img src="/hidden.jpg"></div><template><img src="/t.jpg"></template><noscript><img src="/n.jpg"></noscript>
			<section class="section comments" id="comments"><h2>2 comments</h2><h5>Visitor Name</h5><a href="https://visitor.example"></a></section>`;
		expect(inspectA11y(page({ lang: null, main }))).toEqual([
			{ r: "html-has-lang", el: "<html>" },
			{ r: "duplicate-id", el: `id="book" (2 times)` },
			{ r: "frame-title", el: `<iframe src="www.google.com/maps/embed">` },
		]);
	});
	it("bounds: at most A11Y_PER_RULE findings of one rule per page, the rest counted; repeats on a page are counted, not listed", () => {
		const imgs = Array.from({ length: 30 }, (_, i) => `<img src="/p${i}.jpg">`).join("");
		const hits = inspectA11y(page({ main: `<h1>x</h1>${imgs}<img src="/p0.jpg"><img src="/p0.jpg">` }));
		expect(hits).toHaveLength(A11Y_PER_RULE);
		expect(hits[0]).toEqual({ r: "image-alt", el: `<img src="…/p0.jpg">`, n: 3 });
		expect(hits.reduce((n, h) => n + (h.n ?? 1), 0)).toBe(32);
		// A huge or broken page does not throw.
		expect(() => inspectA11y(`<div>${"<span>".repeat(50_000)}`)).not.toThrow();
		expect(inspectA11y("")).toEqual([]);
	});
	it("element summaries carry no visitor data: mail and phone links show only the scheme; plain words exist for every rule", () => {
		const hits = inspectA11y(page({ main: `<h1>x</h1><a href="mailto:owner@acme.example"><i></i></a>` }));
		expect(JSON.stringify(hits)).not.toContain("owner@acme.example");
		for (const r of Object.values(A11Y_RULES)) expect(r.label && r.why && r.fix).toBeTruthy();
	});
});

describe("grouping across pages", () => {
	const footerLink = `<footer><a href="https://instagram.com/acme"><svg viewBox="0 0 1 1"></svg></a></footer>`;
	it("the same footer link on every page is one item listing the pages; page-only issues stay separate", () => {
		const notes = {
			"/": inspectA11y(page({ footer: footerLink })),
			"/about/": inspectA11y(page({ footer: footerLink, main: "<h1>About</h1><img src='/a.jpg'>" })),
			"/contact/": inspectA11y(page({ footer: footerLink })),
		};
		const items = groupA11y(notes, ["/", "/about/", "/contact/"]);
		expect(items.map((x) => [x.r, x.pages])).toEqual([
			["link-name", ["/", "/about/", "/contact/"]],
			["image-alt", ["/about/"]],
		]);
		expect(items[0]?.id).toBe(itemId("a11y", "link-name", `<a href="instagram.com/acme"> (icon only)`));
		expect(isSiteWide(items[0] as never, 3)).toBe(true);
		expect(isSiteWide(items[1] as never, 3)).toBe(false);
		expect(isSiteWide({ pages: ["/", "/a/"] }, 2)).toBe(true);
		expect(isSiteWide({ pages: ["/"] }, 1)).toBe(false);
		expect(isSiteWide({ pages: ["/", "/a/"] }, 10)).toBe(false);
	});
	it("ids are stable between runs and the item list is bounded", () => {
		const many = Object.fromEntries(Array.from({ length: 25 }, (_, p) => [`/p${p}/`, Array.from({ length: 8 }, (_, i) => ({ r: "image-alt" as const, el: `<img src="…/p${p}-${i}.jpg">` }))]));
		const items = groupA11y(many);
		expect(items).toHaveLength(MAX_A11Y_ITEMS);
		expect(groupA11y(many)[0]?.id).toBe(items[0]?.id);
	});
});

describe("freshness: dates", () => {
	const dates = (s: string) => findStale(s, NOW).map((h) => h.text);
	it("full dates with a weekday are events; without one they need an event word in the same sentence", () => {
		expect(dates("Saturday, March 3, 2024 — come along!")).toEqual(["Saturday, March 3, 2024"]);
		expect(dates("Sat 3rd March 2024")).toEqual(["Sat 3rd March 2024"]);
		expect(dates("Join us on March 3rd, 2024 for the open house.")).toEqual(["March 3rd, 2024"]);
		expect(dates("Workshop: 14 September 2025, 7 pm.")).toEqual(["14 September 2025"]);
		expect(dates("The studio moved on March 3, 2024. It is bigger now.")).toEqual([]);
		// The event word of another sentence does not count.
		expect(dates("Book now. May 2024 was our best month")).toEqual([]);
	});
	it("history is skipped: since, founded, posted, updated, award", () => {
		expect(dates("Founded on Saturday, March 3, 2009 in Portland, we teach classes.")).toEqual([]);
		expect(dates("Serving Portland since March 2015 with classes for all.")).toEqual([]);
		expect(dates("Last updated: Monday, January 6, 2025.")).toEqual([]);
		expect(dates("Winner of the award in June 2024 — book a class")).toEqual([]);
	});
	it("future and today's dates are not stale", () => {
		expect(dates("Join us on Saturday, December 5, 2026")).toEqual([]);
		expect(dates("Join us on Sunday, November 22, 2026")).toEqual([]);
		expect(dates("Join us on Saturday, November 21, 2026")).toEqual(["Saturday, November 21, 2026"]);
	});
	it("numeric dates: slashes and dots only, both readings must be past, with an event word", () => {
		expect(dates("Register until 03/04/2025.")).toEqual(["03/04/2025"]);
		expect(dates("Register until 31.12.2025.")).toEqual(["31.12.2025"]);
		// 11/12/2026: November 12 has passed but December 11 has not — not flagged.
		expect(dates("Register until 11/12/2026.")).toEqual([]);
		expect(dates("13/13/2024 class")).toEqual([]);
		expect(dates("We opened 03/04/2015 and grew.")).toEqual([]);
	});
	it("no false positives on prices, phone numbers, versions or times", () => {
		expect(dates("Classes $25.00. Call 713.555.0199, (713) 555-0199 or +1 713-555-0199. Book now, 10.12.20 offer, v2.1.2024, 1/2/24 at 7 pm, 12/2024 card, 2024-03-03 event")).toEqual([]);
		expect(dates("Monthly 12.50 / 3.04 registration, sale 1,999.2024")).toEqual([]);
	});
	it("other languages: German, French and Spanish day-month-year dates with their event words", () => {
		expect(dates("Kurs am 3. März 2024, Anmeldung bis Freitag.")).toEqual(["3. März 2024"]);
		expect(dates("Atelier le samedi 3 mars 2024")).toEqual(["samedi 3 mars 2024"]);
		expect(dates("Taller el 3 de marzo de 2024")).toEqual(["3 de marzo de 2024"]);
	});
});

describe("freshness: year-bound phrases", () => {
	const phrases = (s: string) => findStale(s, NOW).map((h) => [h.k, h.text, h.ended]);
	it("seasons and holidays end with their period; a year phrase ends with its year", () => {
		expect(phrases("Our Summer 2023 classes and Black Friday 2025 deals")).toEqual([
			["phrase", "Summer 2023", "2023-08-31"],
			["phrase", "Black Friday 2025", "2025-11-30"],
		]);
		expect(phrases("Summer 2026 schedule")).toEqual([["phrase", "Summer 2026", "2026-08-31"]]);
		expect(phrases("Winter 2026 retreat and Christmas 2026 specials")).toEqual([]);
		expect(phrases("See the 2024 offer and the schedule for 2025. Pricing 2024 applies.")).toEqual([
			["phrase", "2024 offer", "2024-12-31"],
			["phrase", "schedule for 2025", "2025-12-31"],
			["phrase", "Pricing 2024", "2024-12-31"],
		]);
		expect(phrases("The 2026 offer and 2027 schedule")).toEqual([]);
	});
	it("copyright lines older than this year, including ranges", () => {
		expect(phrases("© 2023 Acme. Copyright © 2019–2024 Acme. (c) 2022")).toEqual([
			["phrase", "© 2023", "2023-12-31"],
			["phrase", "Copyright © 2019–2024", "2024-12-31"],
			["phrase", "(c) 2022", "2022-12-31"],
		]);
		expect(phrases("© 2026 Acme. © 2019-2026 Acme")).toEqual([]);
	});
	it("from page HTML: <main> text, <time>, post cards, comments and scripts left out; the copyright from the footer", () => {
		const html = page({
			main: `<h1>News</h1><article class="post-card"><h3>Join us on Saturday, March 3, 2024</h3><time datetime="2024-03-01">March 1, 2024</time></article><p>Posted <time>Friday, March 1, 2024</time></p><p>Summer 2023 classes are open.</p><section class="section comments" id="comments"><p>Join us Saturday, March 3, 2024 — a visitor</p></section>`,
			footer: `<footer><p>© 2023 Acme</p></footer>`,
		});
		expect(inspectFreshness(html, NOW).map((h) => h.text)).toEqual(["Summer 2023", "© 2023"]);
		// The kit's own credit is this year: never stale.
		expect(inspectFreshness(page(), NOW)).toEqual([]);
	});
	it("text of an entry's data: strings and portable text spans, not addresses or ids", () => {
		const data = { title: "Classes", content: [{ _type: "block", children: [{ _type: "span", text: "Join us on Saturday, March 3, 2024." }] }, { _type: "cta", url: "https://x.example/2023-offer", label: "Summer 2023 deals", slug: "summer-2023" }] };
		expect(findStale(entryText(data), NOW).map((h) => h.text)).toEqual(["Saturday, March 3, 2024", "Summer 2023"]);
	});
});

describe("freshness: pages that change rarely, old pages, grouping", () => {
	it("legal and thank-you pages are detected by slug", () => {
		for (const p of ["/privacy-policy/", "/privacy", "/terms-and-conditions/", "/terms/", "/cookie-policy/", "/impressum/", "/legal/notice/", "/refund-policy", "/thank-you/", "/contact/thanks/", "/accessibility-statement/"]) expect(isRarelyChanged(p)).toBe(true);
		for (const p of ["/", "/about/", "/classes/", "/terminology-guide/", "/legally-blonde-night/", "/privacyscreen/"]) expect(isRarelyChanged(p)).toBe(false);
	});
	it("months-ago cut-off", () => {
		expect(new Date(staleCutoff(NOW, 18)).toISOString().slice(0, 10)).toBe("2025-05-22");
	});
	it("groups the same words across pages (a footer copyright is one item); old pages are one item each", () => {
		const items = groupStale({ "/": [{ k: "phrase", text: "© 2023", ended: "2023-12-31" }, { k: "old", text: "2024-01-01" }], "/about/": [{ k: "phrase", text: "©  2023", ended: "2023-12-31" }, { k: "old", text: "2024-02-01" }] }, ["/", "/about/"], new Map([["/about/", { collection: "pages", id: "01ABOUT" }]]));
		expect(items.map((x) => [x.k, x.text, x.pages, x.entry?.id])).toEqual([
			["phrase", "© 2023", ["/", "/about/"], undefined],
			["old", "2024-01-01", ["/"], undefined],
			["old", "2024-02-01", ["/about/"], "01ABOUT"],
		]);
		const many = Object.fromEntries(Array.from({ length: 30 }, (_, p) => [`/p${p}/`, [{ k: "phrase" as const, text: `Summer ${2000 + p}` }, { k: "old" as const, text: "2020-01-01" }, { k: "date" as const, text: `Saturday, May ${p + 1}, 2021` }]]));
		expect(groupStale(many, Object.keys(many))).toHaveLength(MAX_STALE_ITEMS);
	});
});

const content = (items: { id: string; slug: string; data?: Record<string, unknown>; updatedAt?: string; status?: string }[], collections = ["pages"]) => ({
	list: vi.fn(async (c: string) => {
		if (!collections.includes(c)) throw new Error("no such collection");
		return { items: items.map((i) => ({ data: {}, ...i })), hasMore: false };
	}),
});

describe("the review: HTML notes + content", () => {
	const old = new Date(NOW - 600 * DAY).toISOString();
	const recent = new Date(NOW - 30 * DAY).toISOString();
	it("pages only (posts never listed), drafts and legal pages skipped, old pages after staleMonths, HTML findings of non-pages dropped", async () => {
		const c = content([
			{ id: "01HOME", slug: "home", updatedAt: recent },
			{ id: "01ABOUT", slug: "about", updatedAt: old, data: { content: [{ text: "Join us on Saturday, March 3, 2024." }] } },
			{ id: "01PRIV", slug: "privacy-policy", updatedAt: old, data: { text: "Effective Monday, January 6, 2020. Summer 2020." } },
			{ id: "01DRAFT", slug: "draft", updatedAt: old, status: "draft" },
		]);
		const { entries, read } = await listEntries(c, ["pages"], NOW);
		expect(read).toBe(true);
		expect(c.list.mock.calls.map((x) => x[0])).toEqual(["pages"]);
		expect(entries.map((e) => e.path)).toEqual(["/", "/about", "/privacy-policy"]);
		const notes = { "/": { a11y: [], stale: [{ k: "phrase" as const, text: "© 2023", ended: "2023-12-31" }] }, "/about/": { stale: [{ k: "phrase" as const, text: "Summer 2023", ended: "2023-08-31" }] }, "/my-post/": { stale: [{ k: "date" as const, text: "Saturday, May 4, 2024" }, { k: "phrase" as const, text: "© 2023" }] }, "/privacy-policy/": { stale: [{ k: "phrase" as const, text: "Summer 2020" }] } };
		const r = buildReview({ notes, order: ["/", "/about/", "/my-post/", "/privacy-policy/"], entries, contentRead: read, now: NOW });
		expect(r.stale.map((x) => [x.k, x.text, x.pages])).toEqual([
			["date", "Saturday, March 3, 2024", ["/about/"]],
			["phrase", "© 2023", ["/", "/my-post/"]],
			["phrase", "Summer 2023", ["/about/"]],
			["old", old.slice(0, 10), ["/about/"]],
		]);
		expect(r.stale.find((x) => x.k === "old")?.entry).toEqual({ collection: "pages", id: "01ABOUT" });
		expect(r.edit).toEqual({ "/": { collection: "pages", id: "01HOME" }, "/about/": { collection: "pages", id: "01ABOUT" } });
		expect(r).toMatchObject({ pages: 4, staleMonths: 18, content: true, skipped: 1 });
		// staleMonths 0: no "not updated"; content unreadable: HTML findings of every page kept.
		expect(buildReview({ notes, order: Object.keys(notes), entries, contentRead: true, now: NOW, staleMonths: 0 }).stale.some((x) => x.k === "old")).toBe(false);
		expect(buildReview({ notes, order: Object.keys(notes), entries: [], contentRead: false, now: NOW }).stale.map((x) => x.text)).toContain("Saturday, May 4, 2024");
	});
	it("listEntries never throws and reads at most 3 pages of 100 per collection", async () => {
		expect(await listEntries(undefined, ["pages"], NOW)).toEqual({ entries: [], read: false });
		expect(await listEntries(content([], []), ["pages"], NOW)).toEqual({ entries: [], read: false });
		const list = vi.fn(async () => ({ items: [{ id: "x", slug: "a", data: {} }], hasMore: true, cursor: "c" }));
		await listEntries({ list } as never, ["pages"], NOW);
		expect(list).toHaveBeenCalledTimes(3);
	});
	it("the stored review stays small: 25 pages full of findings is well under 100 KB", () => {
		const hits = Array.from({ length: 40 }, (_, i) => ({ r: "image-alt" as const, el: `<img src="…/${"x".repeat(50)}${i}.jpg">` }));
		const stale = Array.from({ length: 10 }, (_, i) => ({ k: "date" as const, text: `Saturday, May ${i + 1}, 2021 ${"y".repeat(50)}` }));
		const notes = Object.fromEntries(Array.from({ length: MAX_VISUAL_PAGES }, (_, p) => [`/page-${"z".repeat(40)}-${p}/`, { a11y: hits, stale }]));
		const entries = Array.from({ length: 300 }, (_, i) => ({ collection: "pages", id: `01${i}`, path: `/p${i}`, updatedAt: "2020-01-01T00:00:00.000Z", stale: [] }));
		const r = buildReview({ notes, order: Object.keys(notes), entries, contentRead: true, now: NOW });
		expect(r.a11y.length).toBeLessThanOrEqual(60);
		expect(r.stale.length).toBeLessThanOrEqual(60);
		expect(JSON.stringify(r).length).toBeLessThan(100_000);
	});
});

describe("dismissals", () => {
	it("parses only offered periods and well-formed ids", () => {
		expect(parseDismissValue("abc1234:90")).toEqual({ id: "abc1234", days: 90 });
		expect(parseDismissValue("abc1234:1825")).toEqual({ id: "abc1234", days: 1825 });
		for (const v of ["abc1234:7", "ABC:90", "x:90", "abc1234", 42, "../../x:90", `${"a".repeat(30)}:90`]) expect(parseDismissValue(v)).toBeUndefined();
	});
	it("dismiss until a date, expire, restore one or all; bounded to MAX_DISMISSED (expired dropped first, then the oldest)", () => {
		let d: Dismissed = readDismissed(null);
		d = dismiss(d, "aaaa111", 90, "Past date: “Summer 2023”", NOW);
		expect(isDismissed(d, "aaaa111", NOW + 89 * DAY)).toBe(true);
		expect(isDismissed(d, "aaaa111", NOW + 91 * DAY)).toBe(false);
		expect(restore(d, "aaaa111", NOW).items).toEqual({});
		for (let i = 0; i < MAX_DISMISSED + 20; i++) d = dismiss(d, `id${String(i).padStart(5, "0")}`, 365, "x".repeat(500), NOW + i);
		expect(Object.keys(d.items)).toHaveLength(MAX_DISMISSED);
		expect(d.items.aaaa111).toBeUndefined();
		expect(d.items.id00219).toBeDefined();
		expect(d.items.id00000).toBeUndefined();
		expect(d.items.id00219?.label.length).toBe(120);
		// Expired entries leave on the next write.
		const later = dismiss(d, "bbbb222", 90, "y", NOW + 400 * DAY);
		expect(Object.keys(later.items)).toEqual(["bbbb222"]);
		expect(restore(d, "all", NOW).items).toEqual({});
		expect(dismiss(d, "BAD ID", 90, "z", NOW)).toBe(d);
		expect(readDismissed({ v: 2 })).toEqual({ v: 1, items: {} });
	});
	it("activeReview hides dismissed items within their period", () => {
		const r = buildReview({ notes: { "/": { a11y: [{ r: "html-has-lang", el: "<html>" }], stale: [{ k: "phrase", text: "© 2023" }] } }, order: ["/"], entries: [], contentRead: false, now: NOW });
		const d = dismiss(readDismissed(null), r.stale[0]?.id as string, 365, "x", NOW);
		expect(activeReview(r, d, NOW + DAY)?.stale).toEqual([]);
		expect(activeReview(r, d, NOW + DAY)?.a11y).toHaveLength(1);
		expect(activeReview(r, d, NOW + 400 * DAY)?.stale).toHaveLength(1);
		expect(activeReview(null, d, NOW)).toBeNull();
		expect(readReview({ v: 1, a11y: [] })).toBeNull();
	});
});

function review(o: Partial<ReviewStore> = {}): ReviewStore {
	return { v: 1, at: new Date(NOW).toISOString(), pages: 10, a11y: [], stale: [], staleMonths: 18, content: true, skipped: 0, accessibility: true, ...o };
}
const a11yItem = (r: keyof typeof A11Y_RULES, pages: string[], el = "<x>") => ({ id: itemId("a11y", r, el, pages.join()), r, el, pages, count: pages.length });

describe("What to improve", () => {
	it("issues on many pages rank above single-page ones; past dates in the middle; old pages low", () => {
		const r = review({
			a11y: [a11yItem("link-name", Array.from({ length: 10 }, (_, i) => `/p${i}/`)), a11yItem("html-has-lang", Array.from({ length: 10 }, (_, i) => `/p${i}/`)), a11yItem("image-alt", ["/about/"]), a11yItem("label", ["/contact/"])],
			stale: [
				{ id: "s1", k: "date", text: "Saturday, March 3, 2024", pages: ["/events/"], entry: { collection: "pages", id: "01EVENTS" } },
				{ id: "s2", k: "old", text: "2024-01-01", pages: ["/team/"], entry: { collection: "pages", id: "01TEAM" } },
			],
		});
		const list = improvements({ review: r, notFound: { at: "", probes: 0, top: [{ path: "/old/", hits: 9, lastSeen: "" }] } as never, seo: { thin: { count: 1, pages: [{ title: "x", words: 1 }] }, noDescription: { count: 0, pages: [] }, keyword: { count: 0, pages: [] }, missingAlt: { count: 0, pages: [] } } as never });
		expect(list.map((x) => x.id)).toEqual(["notfound", "a11y-wide", "thin", "a11y", "stale", "old"]);
		const wide = list.find((x) => x.id === "a11y-wide");
		expect(wide).toMatchObject({ impact: 62, count: 2, names: { label: "Issues", items: ["Link without a name (10 pages)", "Page language not set (10 pages)"] }, link: { tab: "accessibility" } });
		expect(list.find((x) => x.id === "a11y")).toMatchObject({ count: 2, names: { items: ["/about/", "/contact/"] }, link: { tab: "accessibility" } });
		const stale = list.find((x) => x.id === "stale");
		expect(stale?.text).toContain("“Saturday, March 3, 2024”");
		expect(improveUrl(ORIGIN, stale?.link as never)).toBe(`${ORIGIN}/_emdash/admin/content/pages/01EVENTS`);
		expect(improveUrl(ORIGIN, list.find((x) => x.id === "old")?.link as never)).toBe(`${ORIGIN}/_emdash/admin/content/pages/01TEAM`);
		// Several pages: the Content freshness tab instead of one editor.
		const many = improvements({ review: review({ stale: [{ id: "s1", k: "phrase", text: "© 2023", pages: ["/", "/about/"] }] }) });
		expect(many[0]).toMatchObject({ id: "stale", link: { tab: "freshness" } });
		// A single-page accessibility issue links to that page's editor when it is a known entry.
		const one = improvements({ review: review({ a11y: [a11yItem("image-alt", ["/about/"])], edit: { "/about/": { collection: "pages", id: "01ABOUT" } } }) });
		expect(improveUrl(ORIGIN, one[0]?.link as never)).toBe(`${ORIGIN}/_emdash/admin/content/pages/01ABOUT`);
		expect(editLink({ collection: "pages", id: "a b" }).admin).toBe("/content/pages/a%20b");
		// Plugin links are unchanged.
		expect(improveUrl(ORIGIN, { plugin: "site-seo", path: "/seo", label: "x" })).toBe(`${ORIGIN}/_emdash/admin/plugins/site-seo/seo`);
		expect(improvements({ review: review() })).toEqual([]);
		expect(improvements({ review: null })).toEqual([]);
	});
	it("currentImprovements reads the stored review and leaves dismissed items and switched-off parts out", async () => {
		const kv = memoryKv();
		const r = review({ a11y: [a11yItem("html-has-lang", ["/"])], stale: [{ id: "st00001", k: "phrase", text: "© 2023", pages: ["/", "/about/"] }] });
		await kv.set(KEYS.review, r);
		const d = { kv, options: OPTIONS, env: {} as never };
		expect((await currentImprovements(d, { now: NOW })).map((x) => x.id)).toEqual(["a11y", "stale"]);
		await kv.set(KEYS.reviewDismissed, dismiss(readDismissed(null), "st00001", 90, "x", NOW));
		expect((await currentImprovements(d, { now: NOW })).map((x) => x.id)).toEqual(["a11y"]);
		expect((await currentImprovements(d, { now: NOW + 100 * DAY })).map((x) => x.id)).toEqual(["a11y", "stale"]);
		expect(await currentImprovements({ ...d, options: { ...OPTIONS, accessibility: false } }, { now: NOW })).toEqual([]);
		expect(await currentImprovements({ ...d, options: { ...OPTIONS, visualPages: 0 } }, { now: NOW })).toEqual([]);
	});
});

describe("with the visual check: no extra requests, stored review, no email", () => {
	afterEach(() => vi.unstubAllGlobals());
	const site = (pages: Record<string, string>) => {
		const calls: string[] = [];
		const self = vi.fn(async (url: string) => {
			const u = new URL(url);
			calls.push(u.pathname);
			const html = pages[u.pathname];
			if (html !== undefined) return new Response(html, { headers: { "content-type": "text/html" } });
			if (/\.(css)$/.test(u.pathname)) return new Response("body{}", { headers: { "content-type": "text/css" } });
			if (/\.(png|jpe?g|webp|gif)$/.test(u.pathname)) return new Response("x", { headers: { "content-type": "image/png" } });
			return new Response("", { status: 404 });
		});
		return { self, calls };
	};
	const pages = {
		"/": page({ footer: `<footer><a href="https://instagram.com/acme"><svg></svg></a><p>© 2023 Acme</p></footer>` }),
		"/about/": page({ lang: null, footer: `<footer><a href="https://instagram.com/acme"><svg></svg></a><p>© 2023 Acme</p></footer>`, main: `<h1>About</h1><img src="/team.jpg"><p>Join us on Saturday, March 3, 2024 for our anniversary class.</p>` }),
	};

	it("the inspector reads the HTML already in hand: same requests with and without it", async () => {
		const a = site(pages);
		const b = site(pages);
		const job = startVisual(["/", "/about/"], "first", NOW);
		const io = { external: vi.fn() as never, origin: ORIGIN, budget: 50 };
		const plain = await stepVisual(job, { ...io, self: a.self as never });
		const inspected = await stepVisual(job, { ...io, self: b.self as never, inspect: pageInspector({}, NOW) });
		expect(b.calls).toEqual(a.calls);
		expect(plain.job.notes).toBeUndefined();
		expect(Object.keys(inspected.job.notes ?? {})).toEqual(["/", "/about/"]);
		expect(inspected.job.notes?.["/about/"]?.a11y?.map((h) => h.r)).toEqual(["html-has-lang", "image-alt", "link-name"]);
		expect(pageInspector({ accessibility: false, freshness: false }, NOW)).toBeUndefined();
		expect(pageInspector({ accessibility: false }, NOW)?.("/", pages["/"])).toEqual({ stale: [{ k: "phrase", text: "© 2023", ended: "2023-12-31" }] });
	});
	it("runVisual stores the review when the run finishes; nothing is emailed for it", async () => {
		const kv = memoryKv();
		const s = site(pages);
		const brevo = vi.fn(async () => new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", brevo);
		await kv.set(KEYS.state, { ...emptyState(), sitemap: { at: "", paths: ["/", "/about/"] } });
		const c = content([
			{ id: "01HOME", slug: "home", updatedAt: new Date(NOW - DAY).toISOString() },
			{ id: "01ABOUT", slug: "about", updatedAt: new Date(NOW - 700 * DAY).toISOString() },
		]);
		const logs: unknown[][] = [];
		const d = (now: number): RunDeps => ({ kv, options: OPTIONS, env: { EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "k", FORM_FROM: "Acme <noreply@acme.example>" } as never, self: s.self as never, fetch: vi.fn(async () => new Response("", { status: 404 })) as never, content: c as never, log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) }, now });
		let r = await runVisual(d(NOW));
		for (let i = 1; !r.run && i < 10; i++) r = await runVisual(d(NOW + i * 300_000));
		expect(r.run).toBeDefined();
		const stored = readReview(await kv.get(KEYS.review)) as ReviewStore;
		expect(stored.pages).toBe(2);
		expect(stored.a11y.map((x) => [x.r, x.pages])).toEqual([
			["link-name", ["/", "/about/"]],
			["html-has-lang", ["/about/"]],
			["image-alt", ["/about/"]],
		]);
		expect(stored.stale.map((x) => [x.k, x.text, x.pages])).toEqual([
			["date", "Saturday, March 3, 2024", ["/about/"]],
			["phrase", "© 2023", ["/", "/about/"]],
			["old", new Date(NOW - 700 * DAY).toISOString().slice(0, 10), ["/about/"]],
		]);
		// The job's notes are gone with the job; the first run is a baseline: no email at all.
		expect(await kv.get(KEYS.visualJob)).toBeNull();
		expect(brevo).not.toHaveBeenCalled();
		// Logs: counts only.
		const line = logs.find((l) => l[0] === "health page review");
		expect(line?.[1]).toEqual({ pages: 2, a11y: 3, stale: 3, content: true });
		expect(JSON.stringify(logs)).not.toContain("Saturday");
	});
});

describe("tabs, dismiss and restore in the admin", () => {
	const plugin = createPlugin(OPTIONS) as unknown as { routes: Record<string, { handler: (ctx: unknown) => Promise<unknown> }> };
	let kv: ReturnType<typeof memoryKv>;
	const cron = { schedule: vi.fn(async () => {}), list: vi.fn(async () => [{ name: "tick", schedule: "*/5 * * * *" }]) };
	const log = { info: vi.fn(), warn: vi.fn() };
	const ctx = (input: unknown, role = 50) => ({ input, kv, cron, request: new Request(`${ORIGIN}/_emdash/api/plugins/site-health/admin`), user: { id: "u1", role }, log });
	const call = (input: unknown, role = 50) => plugin.routes.admin?.handler(ctx(input, role)) as Promise<{ blocks: B[]; toast?: { message: string; type: string } }>;
	const tabOf = (r: { blocks: B[] }) => r.blocks.find((b) => b.type === "tab") as { default_tab: number; panels: { label: string; blocks: B[] }[] };
	const r = review({
		pages: 3,
		a11y: [a11yItem("link-name", ["/", "/about/", "/contact/"], `<a href="instagram.com/acme"> (icon only)`), a11yItem("image-alt", ["/about/"])],
		stale: [{ id: "st00001", k: "date", text: "Saturday, March 3, 2024", ended: "2024-03-03", pages: ["/about/"], entry: { collection: "pages", id: "01ABOUT" } }],
		edit: { "/about/": { collection: "pages", id: "01ABOUT" } },
	});

	beforeEach(async () => {
		kv = memoryKv();
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { EMAIL_PROVIDER: "brevo" });
		await kv.set(KEYS.review, r);
	});

	it("the tabs show the items in plain words with Edit links and a Dismiss menu; counts in the labels", async () => {
		const res = await call({ type: "block_action", action_id: "improve-tab", value: "accessibility" });
		const t = tabOf(res);
		expect(t.default_tab).toBe(TABS.accessibility);
		expect(t.panels[TABS.accessibility]?.label).toBe("Accessibility (2)");
		expect(t.panels[TABS.freshness]?.label).toBe("Content freshness (1)");
		const table = t.panels[TABS.accessibility]?.blocks.find((b) => b.block_id === "a11y");
		expect(table?.rows[0]).toMatchObject({ issue: "Link without a name", pages: "Every checked page (3)", why: A11Y_RULES["link-name"].why, edit: "" });
		expect(table?.rows[1]).toMatchObject({ issue: "Picture without a description", pages: "/about/", edit: { type: "link", target: { url: "/_emdash/admin/content/pages/01ABOUT" } } });
		expect(table?.rows[0].dismiss).toMatchObject({ type: "menu", action_id: "review-dismiss", items: [{ value: `${r.a11y[0]?.id}:90` }, { value: `${r.a11y[0]?.id}:365` }, { value: `${r.a11y[0]?.id}:1825` }] });
		const fresh = t.panels[TABS.freshness]?.blocks.find((b) => b.block_id === "freshness");
		expect(fresh?.rows[0]).toMatchObject({ what: "Past date", found: "“Saturday, March 3, 2024” (ended 2024-03-03)", edit: { target: { url: "/_emdash/admin/content/pages/01ABOUT" } } });
		const f = await call({ type: "block_action", action_id: "improve-tab", value: "freshness" });
		expect(tabOf(f).default_tab).toBe(TABS.freshness);
		// The overview's What to improve lists both.
		const improve = t.panels[0]?.blocks.find((b) => b.block_id === "improve");
		expect((improve?.rows as B[]).map((x) => x.open.value ?? x.open.target?.url)).toEqual(["accessibility", `${ORIGIN}/_emdash/admin/content/pages/01ABOUT`, `${ORIGIN}/_emdash/admin/content/pages/01ABOUT`]);
	});
	it("an admin dismisses an item for a period and can show it again; only listed items and offered periods; not for editors", async () => {
		const id = r.stale[0]?.id as string;
		expect((await call({ type: "block_action", action_id: "review-dismiss", value: `${id}:1825` }, 40)).blocks[0]).toMatchObject({ title: "Admins only" });
		expect(await kv.get(KEYS.reviewDismissed)).toBeNull();
		expect((await call({ type: "block_action", action_id: "review-dismiss", value: "zzzz999:90" })).toast?.message).toContain("no longer listed");
		expect((await call({ type: "block_action", action_id: "review-dismiss", value: `${id}:7` })).toast?.message).toContain("no longer listed");
		const ok = await call({ type: "block_action", action_id: "review-dismiss", value: `${id}:1825` });
		expect(ok.toast).toMatchObject({ type: "success" });
		const t = tabOf(ok);
		expect(t.default_tab).toBe(TABS.freshness);
		expect(t.panels[TABS.freshness]?.label).toBe("Content freshness");
		const dismissed = readDismissed(await kv.get(KEYS.reviewDismissed));
		expect(dismissed.items[id]?.label).toBe("Past date: “Saturday, March 3, 2024”");
		expect(t.panels[TABS.freshness]?.blocks.find((b) => b.block_id === "review-dismissed-stale")?.rows[0]).toMatchObject({ restore: { action_id: "review-restore", value: id } });
		expect(log.info).toHaveBeenCalledWith("health review item dismissed", { kind: "stale", days: 1825 });
		const back = await call({ type: "block_action", action_id: "review-restore", value: id });
		expect(tabOf(back).panels[TABS.freshness]?.label).toBe("Content freshness (1)");
	});
	it("off, not yet run, staging and the empty state read plainly", () => {
		const base = { visual: { on: true, store: { v: 1, baseline: {}, current: {}, runs: [] } } } as unknown as PageData;
		expect(accessibilityTab({ ...base, review: { store: null, dismissed: readDismissed(null), accessibility: true, freshness: true } }).find((b) => b.type === "empty")).toMatchObject({ title: "Not checked yet" });
		expect(accessibilityTab({ ...base, review: { store: r, dismissed: readDismissed(null), accessibility: false, freshness: true } }).find((b) => b.type === "banner")).toMatchObject({ title: "Accessibility check is off" });
		expect(freshnessTab({ ...base, visual: { on: false } as never, review: { store: r, dismissed: readDismissed(null), accessibility: true, freshness: true } }).find((b) => b.type === "banner")?.description).toContain("visualPages: 0");
		expect(freshnessTab({ ...base, staging: true, review: { store: r, dismissed: readDismissed(null), accessibility: true, freshness: true } }).at(-1)).toMatchObject({ text: "Checked on the production site only." });
		const clean = review({ pages: 4 });
		expect(accessibilityTab({ ...base, review: { store: clean, dismissed: readDismissed(null), accessibility: true, freshness: true } }).find((b) => b.type === "banner")).toMatchObject({ title: "No accessibility issues found" });
		expect(freshnessTab({ ...base, review: { store: clean, dismissed: readDismissed(null), accessibility: true, freshness: true } }).find((b) => b.type === "banner")).toMatchObject({ title: "Nothing out of date found" });
		const tabs = (healthPage({ ...base, state: emptyState(), today: null, history: [], incidents: [], links: null, cwv: null, reports: [], settings: {}, defaults: { alertsTo: [], reportTo: [] }, email: { ready: true, provider: "brevo" }, live: true, staging: false, secrets: { crux: false, zone: false, analytics: false }, selfBinding: true, productionUrl: ORIGIN, review: { store: r, dismissed: readDismissed(null), accessibility: true, freshness: false } })[1] as B).panels.map((p: B) => p.label);
		expect(tabs).toContain("Accessibility (2)");
		expect(tabs).toContain("Content freshness");
	});
});

describe("kit.config", () => {
	const config = (extra: Record<string, unknown> = {}) => kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: ORIGIN }, target: { productionUrl: ORIGIN }, email: { to: ["owner@acme.example"], stagingTo: ["team@agency.example"] }, ...extra });
	it("health.accessibility / freshness default on (not written); staleMonths 18 by default, 0–120", () => {
		const o = healthOptions({ config: config(), productionUrl: ORIGIN, live: true });
		expect(o?.accessibility).toBeUndefined();
		expect(o?.freshness).toBeUndefined();
		expect(o?.staleMonths).toBeUndefined();
		const off = healthOptions({ config: config({ health: { accessibility: false, freshness: false, staleMonths: 24 } }), productionUrl: ORIGIN, live: true });
		expect(off).toMatchObject({ accessibility: false, freshness: false, staleMonths: 24 });
		expect(healthOptions({ config: config({ health: { staleMonths: 18 } }), productionUrl: ORIGIN, live: true })?.staleMonths).toBeUndefined();
		expect(() => config({ health: { staleMonths: 500 } })).toThrow();
	});
});
