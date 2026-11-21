/**
 * Footer contact block (starter components/BusinessInfo.astro): decided at scaffold time, so pages do no work for it.
 * Written into site.config.json (`businessFooter: true`) only when kit.config `business.footer` is on, the business has
 * an address or phone, and the migrated footer (its sections and footer widget areas) does not already show them.
 */
import { footerShowsContact, hasContact, type Business } from "../../starter/src/utils/business.js";

export type BusinessFooter = { show: true } | { show: false; why: "off" | "no-contact" | "footer-has-it" };

export function businessFooter(enabled: boolean, business: Business | undefined, footerText: string): BusinessFooter {
	if (!enabled) return { show: false, why: "off" };
	if (!hasContact(business)) return { show: false, why: "no-contact" };
	if (footerShowsContact(business, footerText)) return { show: false, why: "footer-has-it" };
	return { show: true };
}
