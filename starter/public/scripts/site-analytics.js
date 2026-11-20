// Analytics loader (components/Analytics.astro): a real file, so the public Content-Security-Policy ('self') allows it
// without inline-script hashes. Reads the IDs from <meta name="site-analytics">; loads Google tag / GA4, Tag Manager and
// Cloudflare Web Analytics, as the WordPress site did.
(() => {
	const meta = document.querySelector('meta[name="site-analytics"]');
	let a = {};
	try {
		a = JSON.parse(meta ? meta.content : "{}");
	} catch {}
	window.dataLayer = window.dataLayer || [];
	const add = (src, attrs = {}) => {
		const s = document.createElement("script");
		s.async = true;
		s.src = src;
		for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v);
		document.head.appendChild(s);
	};
	if (Array.isArray(a.google) && a.google.length) {
		// gtag() must push the arguments object itself (Google's snippet does the same).
		window.gtag = function gtag() {
			window.dataLayer.push(arguments);
		};
		window.gtag("js", new Date());
		for (const id of a.google) window.gtag("config", id);
		add(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(a.google[0])}`);
	}
	if (a.gtm) {
		window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
		add(`https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(a.gtm)}`);
	}
	if (a.cloudflareToken) add("https://static.cloudflareinsights.com/beacon.min.js", { defer: "", "data-cf-beacon": JSON.stringify({ token: a.cloudflareToken }) });
})();
