/**
 * Embed allowlist: an embed section renders only iframes/scripts whose src is on the selected
 * provider's hosts, plus plain container markup and <style>. Everything else is removed.
 */
export const PROVIDER_HOSTS: Record<string, string[]> = {
	marianatek: ["marianaiframes.com"],
	momence: ["momence.com"],
	janeapp: ["janeapp.com"],
	calendly: ["calendly.com"],
	acuity: ["acuityscheduling.com", "as.me"],
	simplepractice: ["simplepractice.com"],
	mindbody: ["mindbodyonline.com", "healcode.com", "brandedweb.mindbodyonline.com"],
	"google-maps": ["google.com", "maps.google.com"],
	youtube: ["youtube.com", "youtube-nocookie.com"],
	vimeo: ["player.vimeo.com"],
	instagram: ["instagram.com"],
	"reviews-widget": ["elfsight.com", "trustindex.io", "trustpilot.com"],
	typeform: ["typeform.com"],
	jotform: ["jotform.com"],
	hubspot: ["hsforms.net", "hubspot.com", "hs-scripts.com"],
	mailchimp: ["list-manage.com", "mailchimp.com"],
	spotify: ["open.spotify.com"],
	soundcloud: ["w.soundcloud.com"],
};

const hostOk = (src: string, provider: string) => {
	try {
		const host = new URL(src, "https://x.invalid").host;
		return (PROVIDER_HOSTS[provider] ?? []).some((h) => host === h || host.endsWith(`.${h}`));
	} catch {
		return false;
	}
};

export function sanitizeEmbed(html: string, provider: string): string {
	return html
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/<(script|iframe)\b([^>]*)>([\s\S]*?)<\/\1>/gi, (whole, tag: string, attrs: string, body: string) => {
			const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
			if (!src || !hostOk(src, provider)) return "";
			if (tag.toLowerCase() === "script" && body.trim()) return ""; // inline JS never allowed
			return whole;
		})
		.replace(/<(object|embed|form|input|button|link|meta|base)\b[^>]*>/gi, "")
		.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
		.replace(/javascript:/gi, "");
}
