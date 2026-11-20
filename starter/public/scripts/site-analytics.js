// Analytics loader (components/Analytics.astro): a real file, so the public Content-Security-Policy ('self') allows it
// without inline-script hashes. Reads the switched-on trackers from <meta name="site-analytics"> (managed in SEO &
// Analytics → Analytics, @wp2emdash/seo) and starts each service the way its own snippet does, from its ID only:
// Google tag (GA4 / GT- / Google Ads), Tag Manager, Cloudflare Web Analytics, Meta Pixel, Microsoft Clarity, Hotjar.
// Every ID is checked again here against the service's format; anything else is ignored.
//
// window.siteAnalytics.track(kind, label): conversion events from the site script (scripts/site.ts) — "lead" (form
// sent; label = form id), "contact" (phone/email link), "booking" (booking service host), "outbound" (link domain).
// Sent only when that kind is switched on, to every started tracker that understands it. Labels are reduced to
// [a-z0-9._-]: no form contents, numbers or addresses ever leave the page.
// window.siteAnalytics.grantConsent(): consent mode's hook for a cookie banner (none ships yet). With consent mode on,
// Google starts with consent denied and Meta, Clarity and Hotjar start only after this call.
(() => {
	const meta = document.querySelector('meta[name="site-analytics"]');
	let a = {};
	try {
		a = JSON.parse(meta ? meta.content : "{}") || {};
	} catch {}
	const list = (v, re) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x) => typeof x === "string" && re.test(x));
	const google = list(a.google, /^(?:G|GT|AW)-[A-Z0-9]{4,14}$/);
	const gtm = list(a.gtm, /^GTM-[A-Z0-9]{4,10}$/);
	// "cloudflareToken": the site.config.json name from before the admin page.
	const cloudflare = list(a.cloudflare || a.cloudflareToken, /^[a-f0-9]{32}$/)[0];
	const pixels = list(a.meta, /^\d{12,20}$/);
	const clarity = list(a.clarity, /^[a-z0-9]{8,12}$/)[0];
	const hotjar = list(a.hotjar, /^\d{5,10}$/)[0];
	const events = new Set(list(a.events, /^(?:lead|contact|booking|outbound)$/));
	const consentMode = a.consent === true;
	const add = (src, attrs = {}) => {
		const s = document.createElement("script");
		s.async = true;
		s.src = src;
		for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
		document.head.appendChild(s);
	};
	window.dataLayer = window.dataLayer || [];
	if (google.length || (consentMode && gtm.length)) {
		// gtag() must push the arguments object itself (Google's snippet does the same).
		window.gtag = function gtag() {
			window.dataLayer.push(arguments);
		};
		if (consentMode) window.gtag("consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" });
	}
	if (google.length) {
		window.gtag("js", new Date());
		for (const id of google) window.gtag("config", id);
		add(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(google[0])}`);
	}
	for (const id of gtm) {
		window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
		add(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`);
	}
	// Cookieless: not held back by consent mode.
	if (cloudflare) add("https://static.cloudflareinsights.com/beacon.min.js", { defer: "", "data-cf-beacon": JSON.stringify({ token: cloudflare }) });

	// Services that store cookies or device data: started now, or after consent in consent mode.
	let started = false;
	const startStorageTrackers = () => {
		if (started) return;
		started = true;
		if (pixels.length) {
			// Meta Pixel base code (fbevents.js queue stub), as in Meta's snippet; the <noscript> image is left out.
			if (!window.fbq) {
				const n = function fbq() {
					n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
				};
				window.fbq = n;
				if (!window._fbq) window._fbq = n;
				n.push = n;
				n.loaded = true;
				n.version = "2.0";
				n.queue = [];
				add("https://connect.facebook.net/en_US/fbevents.js");
			}
			for (const id of pixels) window.fbq("init", id);
			window.fbq("track", "PageView");
		}
		if (clarity) {
			// Microsoft Clarity tracking code: a queue stub, then the project's tag.
			window.clarity =
				window.clarity ||
				function clarity() {
					(window.clarity.q = window.clarity.q || []).push(arguments);
				};
			add(`https://www.clarity.ms/tag/${encodeURIComponent(clarity)}`);
		}
		if (hotjar) {
			// Hotjar tracking code: a queue stub and settings, then the site's script.
			window.hj =
				window.hj ||
				function hj() {
					(window.hj.q = window.hj.q || []).push(arguments);
				};
			window._hjSettings = { hjid: Number(hotjar), hjsv: 6 };
			add(`https://static.hotjar.com/c/hotjar-${encodeURIComponent(hotjar)}.js?sv=6`);
		}
	};
	if (!consentMode) startStorageTrackers();

	const NAMES = { lead: "generate_lead", contact: "contact", booking: "schedule", outbound: "click" };
	const META = { lead: "Lead", contact: "Contact", booking: "Schedule" };
	window.siteAnalytics = {
		track(kind, label) {
			if (!events.has(kind)) return;
			const l = String(label || "").toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 80);
			const params = kind === "lead" ? { form_name: l } : kind === "contact" ? { method: l } : kind === "booking" ? { booking_service: l } : { outbound: true, link_domain: l };
			if (google.length && window.gtag) window.gtag("event", NAMES[kind], params);
			if (gtm.length) window.dataLayer.push({ event: kind === "outbound" ? "outbound_click" : NAMES[kind], ...params });
			if (started && window.fbq && META[kind]) window.fbq("track", META[kind]);
			if (started && clarity && window.clarity) window.clarity("event", NAMES[kind]);
			if (started && hotjar && window.hj) window.hj("event", NAMES[kind]);
		},
		grantConsent() {
			if (window.gtag) window.gtag("consent", "update", { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted", analytics_storage: "granted" });
			startStorageTrackers();
		},
	};
})();
