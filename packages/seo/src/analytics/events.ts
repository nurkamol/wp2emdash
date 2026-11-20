/**
 * Conversion events: which link click is which kind. Used by the starter's site script (scripts/site.ts), which hands
 * the result to the loader's `siteAnalytics.track()`; the loader sends it to every switched-on tracker that supports
 * it, if that kind is switched on in the admin. Only a kind and a non-personal label travel: the booking service's
 * host, "phone"/"email", the outbound domain or the form's id — never a number, address, URL path or form contents.
 */
import type { EventKind } from "./trackers.js";

/** Booking services (same list as the audit's integrations, src/audit/integrations.ts). */
export const BOOKING_HOSTS = ["calendly.com", "acuityscheduling.com", "as.me", "janeapp.com", "simplepractice.com", "mindbodyonline.com", "clients.mindbodyonline.com", "healcode.com", "square.site", "setmore.com", "zocdoc.com", "vagaro.com", "fresha.com", "booksy.com", "glofox.com", "momence.com", "marianatek.com", "marianaiframes.com", "cal.com", "calendar.app.google", "schedulicity.com", "wellnessliving.com", "zenoti.com", "opentable.com", "resy.com"];

export interface LinkEvent {
	kind: Exclude<EventKind, "lead">;
	/** "phone" | "email" for contact; the service or destination host otherwise. */
	label: string;
}

const matchesHost = (host: string, list: string[]) => list.some((h) => host === h || host.endsWith(`.${h}`));

/** Classifies a clicked link. `ownHost`: the page's host (links to the site itself are not events). */
export function classifyLink(href: string, ownHost: string): LinkEvent | undefined {
	const h = href.trim();
	if (/^tel:/i.test(h)) return { kind: "contact", label: "phone" };
	if (/^mailto:/i.test(h)) return { kind: "contact", label: "email" };
	if (/^sms:|^https?:\/\/(?:wa\.me|api\.whatsapp\.com)\//i.test(h)) return { kind: "contact", label: /^sms:/i.test(h) ? "sms" : "whatsapp" };
	let u: URL;
	try {
		u = new URL(h, `https://${ownHost}/`);
	} catch {
		return undefined;
	}
	if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
	const host = u.hostname.toLowerCase().replace(/^www\./, "");
	const own = ownHost.toLowerCase().replace(/^www\./, "");
	if (host === own) return undefined;
	if (matchesHost(host, BOOKING_HOSTS) || (host === "google.com" && u.pathname.startsWith("/calendar/appointments")) || (host === "squareup.com" && u.pathname.startsWith("/appointments"))) return { kind: "booking", label: host };
	return { kind: "outbound", label: host };
}
