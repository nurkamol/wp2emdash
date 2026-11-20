// Site widgets loader (components/SiteWidgets.astro): a real file, so the public Content-Security-Policy ('self')
// allows it without inline-script hashes. Reads the widgets from <meta name="site-widgets"> (site.config.json
// `siteWidgets`, carried over from WordPress by provider + ID) and starts each one the way the provider's own snippet
// does, from its ID only. Every ID is checked again here against the provider's format (the same patterns as
// src/utils/providers.ts); anything else is ignored. No free-form code is ever run.
(() => {
	const meta = document.querySelector('meta[name="site-widgets"]');
	let list = [];
	try {
		list = JSON.parse(meta ? meta.content : "[]") || [];
	} catch {}
	if (!Array.isArray(list)) return;
	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	const add = (src, attrs = {}, parent = document.head) => {
		const s = document.createElement("script");
		s.async = true;
		s.src = src;
		for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
		parent.appendChild(s);
		return s;
	};
	const box = (cls) => {
		const d = document.createElement("div");
		if (cls) d.className = cls;
		document.body.appendChild(d);
		return d;
	};
	// Consent tools tell the analytics loader (window.siteAnalytics.grantConsent, consent mode) when visitors accept
	// statistics cookies. Only the two tools with a documented browser event are wired; the others manage their own blocking.
	const grant = () => window.siteAnalytics && typeof window.siteAnalytics.grantConsent === "function" && window.siteAnalytics.grantConsent();
	const START = {
		tawkto: [/^[0-9a-f]{24}\/[a-z0-9]{6,12}$/i, (id) => {
			window.Tawk_API = window.Tawk_API || {};
			window.Tawk_LoadStart = new Date();
			add(`https://embed.tawk.to/${id}`, { charset: "UTF-8", crossorigin: "*" });
		}],
		crisp: [UUID, (id) => {
			window.$crisp = window.$crisp || [];
			window.CRISP_WEBSITE_ID = id;
			add("https://client.crisp.chat/l.js");
		}],
		intercom: [/^[a-z0-9]{8}$/, (id) => {
			window.intercomSettings = Object.assign({ api_base: "https://api-iam.intercom.io" }, window.intercomSettings, { app_id: id });
			if (typeof window.Intercom !== "function") {
				const i = function () {
					i.c(arguments);
				};
				i.q = [];
				i.c = (args) => i.q.push(args);
				window.Intercom = i;
			}
			add(`https://widget.intercom.io/widget/${id}`);
		}],
		"hubspot-chat": [/^\d{5,10}$/, (id) => add(`https://js.hs-scripts.com/${id}.js`, { id: "hs-script-loader", defer: "" })],
		elfsight: [UUID, (id) => {
			box(`elfsight-app-${id}`).setAttribute("data-elfsight-app-lazy", "");
			if (!document.querySelector('script[src="https://elfsightcdn.com/platform.js"]')) add("https://elfsightcdn.com/platform.js");
		}],
		// Trustindex draws the widget where its loader script sits: a box at the end of the page.
		trustindex: [/^[0-9a-f]{10,40}$/i, (id) => add(`https://cdn.trustindex.io/loader.js?${id}`, { defer: "" }, box("site-widget-trustindex"))],
		cookieyes: [/^[0-9a-f]{20,40}$/i, (id) => {
			document.addEventListener("cookieyes_consent_update", (e) => {
				const accepted = e && e.detail && Array.isArray(e.detail.accepted) ? e.detail.accepted : [];
				if (accepted.includes("analytics")) grant();
			});
			add(`https://cdn-cookieyes.com/client_data/${id}/script.js`, { id: "cookieyes" });
		}],
		cookiebot: [UUID, (id) => {
			window.addEventListener("CookiebotOnAccept", () => {
				if (window.Cookiebot && window.Cookiebot.consent && window.Cookiebot.consent.statistics) grant();
			});
			add("https://consent.cookiebot.com/uc.js", { id: "Cookiebot", "data-cbid": id });
		}],
		termly: [UUID, (id) => add(`https://app.termly.io/resource-blocker/${id}`)],
		iubenda: [UUID, (id) => add(`https://embeds.iubenda.com/widgets/${id}.js`)],
	};
	const seen = new Set();
	for (const w of list) {
		const entry = w && typeof w.provider === "string" && Object.hasOwn(START, w.provider) ? START[w.provider] : undefined;
		if (!entry || typeof w.id !== "string" || !entry[0].test(w.id) || seen.has(`${w.provider}:${w.id}`)) continue;
		seen.add(`${w.provider}:${w.id}`);
		// Deferred script: <body> exists for the widgets that add a box.
		try {
			entry[1](w.id);
		} catch {}
	}
})();
