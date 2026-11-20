/**
 * The provider registry (starter/src/utils/providers.ts via src/providers/registry.ts): one sample per provider in the
 * form its official embed/snippet uses. Each sample must be detected as that provider, and every URL it loads
 * (script/iframe src) must be allowed by the provider's own hosts — the embed allowlist and the CSP come from them.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { embedProvider } from "../src/adapters/wpbakery/elements.js";
import { EMBED_PROVIDER_IDS, embedCsp, hostAllowed, PROVIDER_BY_ID, PROVIDERS, providerCsp, validWidget, widgetIdIn } from "../src/providers/registry.js";
import { carriedWidgets } from "../src/scaffold/widgets.js";
import { BLOCK_TYPES } from "../src/starter/library.js";

/** provider id → [sample markup, widget id it carries (site widgets)]. */
const SAMPLES: Record<string, [string, string?]> = {
	marianatek: ['<div data-mariana-integrations="/schedule/daily"></div><script src="https://studio.marianaiframes.com/js"></script>'],
	momence: ['<script async src="https://momence.com/plugin/host-schedule/host-schedule.js" host_id="1"></script>'],
	janeapp: ['<iframe src="https://studio.janeapp.com/embed/book"></iframe>'],
	calendly: ['<div class="calendly-inline-widget" data-url="https://calendly.com/x"></div><script src="https://assets.calendly.com/assets/external/widget.js"></script>'],
	acuity: ['<iframe src="https://app.acuityscheduling.com/schedule.php?owner=1"></iframe><script src="https://embed.acuityscheduling.com/js/embed.js"></script>'],
	simplepractice: ['<script src="https://widget-cdn.simplepractice.com/assets/integration-1.0.js"></script>'],
	mindbody: ['<script src="https://widgets.mindbodyonline.com/javascripts/healcode.js"></script>'],
	"google-maps": ['<iframe src="https://www.google.com/maps/embed?pb=!1m18"></iframe>'],
	youtube: ['<iframe src="https://www.youtube-nocookie.com/embed/abc"></iframe>'],
	vimeo: ['<iframe src="https://player.vimeo.com/video/1"></iframe>'],
	instagram: ['<blockquote class="instagram-media"></blockquote><script async src="https://www.instagram.com/embed.js"></script>'],
	"reviews-widget": ['<script src="https://static.elfsight.com/platform/platform.js"></script>'],
	typeform: ['<div data-tf-live="x"></div><script src="https://embed.typeform.com/next/embed.js"></script>'],
	jotform: ['<script src="https://form.jotform.com/jsform/1"></script>'],
	hubspot: ['<script src="https://js.hsforms.net/forms/embed/v2.js"></script>'],
	// Mailchimp's embedded form is a plain <form> posting to list-manage.com (its mc-validate.js on s3.amazonaws.com is
	// not allowed: a bucket host cannot be scoped; docs/spikes/providers-findings.md).
	mailchimp: ['<iframe src="https://us1.list-manage.com/subscribe?u=1&id=2"></iframe>'],
	spotify: ['<iframe src="https://open.spotify.com/embed/playlist/1"></iframe>'],
	soundcloud: ['<iframe src="https://w.soundcloud.com/player/?url=x"></iframe>'],
	"google-calendar": ['<iframe src="https://calendar.google.com/calendar/embed?src=studio%40example.com&ctz=America%2FChicago"></iframe>'],
	"google-forms": ['<iframe src="https://docs.google.com/forms/d/e/1FAIpQL/viewform?embedded=true"></iframe>'],
	wistia: ['<script src="https://fast.wistia.com/embed/medias/abc123.jsonp" async></script><script src="https://fast.wistia.com/assets/external/E-v1.js" async></script><div class="wistia_embed wistia_async_abc123"></div>'],
	loom: ['<iframe src="https://www.loom.com/embed/0123456789abcdef"></iframe>'],
	tiktok: ['<blockquote class="tiktok-embed" cite="https://www.tiktok.com/@studio/video/1" data-video-id="1"></blockquote><script async src="https://www.tiktok.com/embed.js"></script>'],
	facebook: ['<iframe src="https://www.facebook.com/plugins/page.php?href=https%3A%2F%2Fwww.facebook.com%2Fstudio"></iframe>'],
	"x-twitter": ['<blockquote class="twitter-tweet"><a href="https://twitter.com/studio/status/1">x</a></blockquote><script async src="https://platform.twitter.com/widgets.js"></script>'],
	vagaro: ['<div class="vagaro"><script src="https://www.vagaro.com/resources/WidgetEmbeddedLoader/abc"></script></div>'],
	glofox: ['<iframe src="https://app.glofox.com/portal/#/branch/abc/classes-day-view"></iframe>'],
	zenoti: ['<iframe src="https://studio.zenoti.com/webstoreNew/services"></iframe>'],
	"square-appointments": ['<script src="https://app.squareup.com/appointments/buyer/widget/abc/LOC.js"></script>'],
	booksy: ['<script src="https://booksy.com/widget/code.js?id=1&country=us&lang=en"></script>'],
	fresha: ['<iframe src="https://www.fresha.com/a/studio-austin-1"></iframe>'],
	opentable: ['<script src="https://www.opentable.com/widget/reservation/loader?rid=1&type=standard"></script>'],
	resy: ['<script src="https://widgets.resy.com/embed.js"></script>'],
	tock: ['<div id="Tock_widget_container"></div><script src="https://www.exploretock.com/tock.js"></script>'],
	arketa: ['<iframe src="https://app.arketa.co/iframe/studio/schedule"></iframe>'],
	classpass: ['<iframe src="https://classpass.com/studios/studio-austin"></iframe>'],
	dailymotion: ['<iframe src="https://www.dailymotion.com/embed/video/x8abc12"></iframe>'],
	ted: ['<iframe src="https://embed.ted.com/talks/speaker_a_talk"></iframe>'],
	twitch: ['<iframe src="https://player.twitch.tv/?video=123&parent=example.com"></iframe>'],
	pinterest: ['<a data-pin-do="embedPin" href="https://www.pinterest.com/pin/123/"></a><script async defer src="https://assets.pinterest.com/js/pinit.js"></script>'],
	reddit: ['<blockquote class="reddit-embed-bq"><a href="https://www.reddit.com/r/x/comments/1/"></a></blockquote><script async src="https://embed.reddit.com/widgets.js"></script>'],
	bluesky: ['<blockquote class="bluesky-embed" data-bluesky-uri="at://did:plc:x/app.bsky.feed.post/1"></blockquote><script async src="https://embed.bsky.app/static/embed.js"></script>'],
	mixcloud: ['<iframe src="https://player-widget.mixcloud.com/widget/iframe/?feed=%2Fstudio%2Fshow%2F"></iframe>'],
	bandcamp: ['<iframe src="https://bandcamp.com/EmbeddedPlayer/album=1/size=large/"></iframe>'],
	"apple-embeds": ['<iframe src="https://embed.podcasts.apple.com/us/podcast/x/id1"></iframe>'],
	tawkto: ["<script>var s1=document.createElement('script');s1.src='https://embed.tawk.to/0123456789abcdef01234567/1abcdefgh';</script>", "0123456789abcdef01234567/1abcdefgh"],
	crisp: ['<script>window.$crisp=[];window.CRISP_WEBSITE_ID="01234567-89ab-cdef-0123-456789abcdef";s.src="https://client.crisp.chat/l.js";</script>', "01234567-89ab-cdef-0123-456789abcdef"],
	intercom: ['<script>window.intercomSettings = { api_base: "https://api-iam.intercom.io", app_id: "abc12345" }; s.src="https://widget.intercom.io/widget/abc12345";</script>', "abc12345"],
	"hubspot-chat": ['<script type="text/javascript" id="hs-script-loader" async defer src="https://js.hs-scripts.com/1234567.js"></script>', "1234567"],
	elfsight: ['<script src="https://elfsightcdn.com/platform.js" async></script><div class="elfsight-app-01234567-89ab-cdef-0123-456789abcdef" data-elfsight-app-lazy></div>', "01234567-89ab-cdef-0123-456789abcdef"],
	trustindex: ["<script defer async src='https://cdn.trustindex.io/loader.js?0123456789abcdef'></script>", "0123456789abcdef"],
	cookieyes: ['<script id="cookieyes" src="https://cdn-cookieyes.com/client_data/0123456789abcdef01234567/script.js"></script>', "0123456789abcdef01234567"],
	cookiebot: ['<script id="Cookiebot" src="https://consent.cookiebot.com/uc.js" data-cbid="01234567-89ab-cdef-0123-456789abcdef"></script>', "01234567-89ab-cdef-0123-456789abcdef"],
	termly: ['<script src="https://app.termly.io/resource-blocker/01234567-89ab-cdef-0123-456789abcdef?autoBlock=on"></script>', "01234567-89ab-cdef-0123-456789abcdef"],
	iubenda: ['<script src="https://embeds.iubenda.com/widgets/01234567-89ab-cdef-0123-456789abcdef.js"></script>', "01234567-89ab-cdef-0123-456789abcdef"],
};

const loadedUrls = (html: string) => [...html.matchAll(/(?:\bsrc\s*=\s*["']|\.src\s*=\s*["'])(https:\/\/[^"']+)/gi)].map((m) => new URL(m[1] as string));
const cspAllows = (sources: string[], url: URL) => sources.some((s) => s === url.origin || (s.startsWith("https://*.") && url.host.endsWith(s.slice("https://*".length))));

describe("provider registry", () => {
	it("has a sample for every provider, and no sample without a provider", () => {
		expect(Object.keys(SAMPLES).sort()).toEqual(PROVIDERS.map((p) => p.id).sort());
		expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
	});

	it("keeps the adapters' original embed providers first, in their original order (goldens depend on it)", () => {
		expect(EMBED_PROVIDER_IDS.slice(0, 18)).toEqual(["marianatek", "momence", "janeapp", "calendly", "acuity", "simplepractice", "mindbody", "google-maps", "youtube", "vimeo", "instagram", "reviews-widget", "typeform", "jotform", "hubspot", "mailchimp", "spotify", "soundcloud"]);
	});

	for (const p of PROVIDERS) {
		it(`${p.id}: detected from its sample, every loaded URL covered by its hosts and CSP`, () => {
			const [html, widgetId] = SAMPLES[p.id] ?? [""];
			expect(p.detect.test(html)).toBe(true);
			if (p.embed) expect(embedProvider(html)).toBe(p.id);
			const csp = providerCsp([p.id]);
			for (const u of loadedUrls(html)) {
				expect(hostAllowed(u.host, p.id), `${u.host} not in ${p.id} hosts`).toBe(true);
				expect(cspAllows(csp.script, u) && cspAllows(csp.frame, u), `${u.href} not in ${p.id} CSP`).toBe(true);
			}
			if (p.widget) {
				expect(widgetIdIn(p.id, html)).toBe(widgetId);
				expect(validWidget({ provider: p.id, id: widgetId })).toBe(true);
				expect(validWidget({ provider: p.id, id: `${widgetId}"><script>` })).toBe(false);
			}
		});
	}

	it("section_embed offers exactly the embed providers", () => {
		const block = BLOCK_TYPES.find((b) => b.slug === "section_embed") as unknown as { versions: { fields: { slug: string; validation?: { options?: string[] } }[] }[] };
		expect(block.versions[0]?.fields.find((f) => f.slug === "provider")?.validation?.options).toEqual(EMBED_PROVIDER_IDS);
	});

	it("the always-on embed CSP keeps every host the starter allowed before the registry", () => {
		const before = ["marianaiframes.com", "momence.com", "janeapp.com", "calendly.com", "acuityscheduling.com", "as.me", "simplepractice.com", "mindbodyonline.com", "healcode.com", "brandedweb.mindbodyonline.com", "google.com", "maps.google.com", "youtube.com", "youtube-nocookie.com", "player.vimeo.com", "instagram.com", "elfsight.com", "trustindex.io", "trustpilot.com", "typeform.com", "jotform.com", "hsforms.net", "hubspot.com", "hs-scripts.com", "list-manage.com", "mailchimp.com", "open.spotify.com", "w.soundcloud.com"];
		const csp = embedCsp();
		for (const h of before) for (const list of [csp.script, csp.frame, csp.connect]) expect(list).toEqual(expect.arrayContaining([`https://${h}`, `https://*.${h}`]));
		// Site widgets are not in the always-on list: only the ones a site switches on.
		expect(csp.script.some((s) => s.includes("tawk.to") || s.includes("cookieyes"))).toBe(false);
	});

	it("the starter's widget loader knows every widget provider and checks IDs with the registry's patterns", () => {
		const js = readFileSync(join(import.meta.dirname, "..", "starter", "public", "scripts", "site-widgets.js"), "utf8");
		for (const p of PROVIDERS.filter((x) => x.widget)) {
			const m = new RegExp(`(?:^|\\s)"?${p.id.replace(/-/g, "\\-")}"?:\\s*\\[(.+?), \\(id\\) =>`, "m").exec(js);
			expect(m, `${p.id} missing in site-widgets.js`).toBeTruthy();
			const pattern = (m?.[1] ?? "").trim();
			expect(pattern === "UUID" ? String(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) : pattern).toBe(String(PROVIDER_BY_ID[p.id]?.widget?.id));
		}
	});

	it("kit.config siteWidgets accepts registry widgets only", () => {
		const base = { name: "x", source: { url: "https://example.com" }, target: { productionUrl: "https://example.com" } };
		const ok = kitConfigSchema.safeParse({ ...base, siteWidgets: [{ provider: "tawkto", id: "0123456789abcdef01234567/1abcdefgh" }] });
		const bad = kitConfigSchema.safeParse({ ...base, siteWidgets: [{ provider: "tawkto", id: "<script>" }] });
		const unknown = kitConfigSchema.safeParse({ ...base, siteWidgets: [{ provider: "nope", id: "1" }] });
		expect(bad.success).toBe(false);
		expect(unknown.success).toBe(false);
		if (!ok.success) expect(ok.error.issues.filter((i) => i.path[0] === "siteWidgets")).toEqual([]);
	});

	it("scaffold carries the recognised widgets unless kit.config decides", () => {
		const ir = mkdtempSync(join(tmpdir(), "wp2emdash-widgets-"));
		writeFileSync(join(ir, "site-snippets.json"), JSON.stringify({ widgets: [{ provider: "crisp", id: "01234567-89ab-cdef-0123-456789abcdef" }, { provider: "crisp", id: "01234567-89ab-cdef-0123-456789abcdef" }, { provider: "evil", id: "x" }] }));
		expect(carriedWidgets(undefined, ir)).toEqual([{ provider: "crisp", id: "01234567-89ab-cdef-0123-456789abcdef" }]);
		expect(carriedWidgets(false, ir)).toEqual([]);
		expect(carriedWidgets([{ provider: "hubspot-chat", id: "1234567" }], ir)).toEqual([{ provider: "hubspot-chat", id: "1234567" }]);
		expect(carriedWidgets(undefined, join(ir, "missing"))).toEqual([]);
	});
});
