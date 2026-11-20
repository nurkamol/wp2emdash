/**
 * Embed allowlist: an embed section renders only iframes/scripts whose src is on the selected provider's hosts (the
 * provider registry, utils/providers.ts), plus plain container markup and <style>. Everything else is removed.
 */
import { hostAllowed } from "./providers";

export { PROVIDER_HOSTS } from "./providers";

const hostOk = (src: string, provider: string) => {
	try {
		return hostAllowed(new URL(src, "https://x.invalid").host, provider);
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
