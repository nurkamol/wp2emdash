/**
 * WordPress oEmbed URLs (core/embed blocks store only the URL; WordPress fetches the markup at render time) → the
 * provider's official embed markup, so the embed section shows the post, video or player instead of a bare link.
 * Only providers whose embed markup follows from the URL alone; the scripts and iframes load from hosts in the provider
 * registry (starter/src/utils/providers.ts), which the starter's embed allowlist and CSP use. Anything else: undefined
 * (the adapter keeps the link and the registry decides whether it is an embed or legacy_html).
 */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function oembedMarkup(rawUrl: string): string | undefined {
	let u: URL;
	try {
		u = new URL(rawUrl);
	} catch {
		return undefined;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
	const host = u.host.replace(/^www\./, "").toLowerCase();
	const path = u.pathname;
	const href = esc(u.href);
	const iframe = (src: string, title: string, extra = "") => `<iframe src="${esc(src)}" title="${esc(title)}" loading="lazy" allowfullscreen${extra}></iframe>`;
	let m: RegExpExecArray | null;
	if (host === "dailymotion.com" && (m = /^\/video\/([a-z0-9]+)/i.exec(path))) return iframe(`https://www.dailymotion.com/embed/video/${m[1]}`, "Dailymotion video", ' allow="autoplay; fullscreen; picture-in-picture"');
	if (host === "dai.ly" && (m = /^\/([a-z0-9]+)/i.exec(path))) return iframe(`https://www.dailymotion.com/embed/video/${m[1]}`, "Dailymotion video", ' allow="autoplay; fullscreen; picture-in-picture"');
	if (host === "ted.com" && (m = /^\/talks\/([\w-]+)/.exec(path))) return iframe(`https://embed.ted.com/talks/${m[1]}`, "TED talk");
	if (host === "open.spotify.com" && (m = /^\/(?:intl-[\w-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/.exec(path))) return iframe(`https://open.spotify.com/embed/${m[1]}/${m[2]}`, "Spotify player", ' allow="encrypted-media"');
	if (host === "loom.com" && (m = /^\/share\/([0-9a-f]+)/i.exec(path))) return iframe(`https://www.loom.com/embed/${m[1]}`, "Loom video");
	if (host === "mixcloud.com" && /^\/[^/]+\/[^/]+\/?$/.test(path)) return iframe(`https://player-widget.mixcloud.com/widget/iframe/?feed=${encodeURIComponent(path.endsWith("/") ? path : `${path}/`)}`, "Mixcloud player");
	if ((host === "twitter.com" || host === "x.com") && /^\/[^/]+\/status\/\d+/.test(path)) return `<blockquote class="twitter-tweet"><a href="${href}">${href}</a></blockquote><script async src="https://platform.twitter.com/widgets.js"></script>`;
	if (host === "tiktok.com" && (m = /^\/@[\w.-]+\/video\/(\d+)/.exec(path))) return `<blockquote class="tiktok-embed" cite="${href}" data-video-id="${m[1]}"><a href="${href}">${href}</a></blockquote><script async src="https://www.tiktok.com/embed.js"></script>`;
	if (host === "instagram.com" && /^\/(?:p|reel|tv)\/[\w-]+/.test(path)) return `<blockquote class="instagram-media" data-instgrm-permalink="${href}"><a href="${href}">${href}</a></blockquote><script async src="https://www.instagram.com/embed.js"></script>`;
	if (host === "reddit.com" && /^\/r\/[^/]+\/comments\//.test(path)) return `<blockquote class="reddit-embed-bq"><a href="${href}">${href}</a></blockquote><script async src="https://embed.reddit.com/widgets.js"></script>`;
	if (/^(?:[a-z]{2}\.)?pinterest\.[a-z.]+$/.test(host) && /^\/pin\/\d+/.test(path)) return `<a data-pin-do="embedPin" href="${href}">${href}</a><script async defer src="https://assets.pinterest.com/js/pinit.js"></script>`;
	return undefined;
}
