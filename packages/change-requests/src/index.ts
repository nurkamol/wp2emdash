/**
 * @wp2emdash/change-requests — Change Requests for EmDash on Cloudflare Workers (experimental, 0.x). A PixelKraft
 * plugin, on by default in every site the wp2emdash kit builds (`changeRequests: false` in kit.config.ts
 * turns it off).
 *
 * Clients (editors and admins) ask the agency for a change from inside the admin instead of email or WhatsApp — title,
 * description, which page (or anywhere), priority, up to three screenshots / PDFs stored privately, how they want to
 * hear back — and follow its status (New → Seen → In progress → Waiting for you → Done / Declined) with a comment
 * timeline. The agency replies on the same page; new requests email the agency, status changes and replies email the
 * requester (opt-out); an optional signed webhook feeds the agency's tracker.
 *
 * This entry is safe to import from astro.config (Node): it only builds the plugin descriptor. The Worker-side module
 * is `@wp2emdash/change-requests/plugin`; the upload page (the only React part: Block Kit has no file input) is
 * `@wp2emdash/change-requests/admin`. Facts it relies on: the kit's docs/spikes/change-requests-findings.md.
 */
import { CR_PLUGIN } from "./meta.js";

export { CR_PLUGIN };

export interface ChangeRequestsOptions {
	productionUrl: string;
	siteName: string;
	/** Who gets an email for each new request (the agency). Empty: no emails to the agency (the page still works). */
	agencyTo: string[];
	/**
	 * Which admins act for the agency (change any status, reply as the agency): admins whose email domain is listed.
	 * Empty (default): every admin. Editors are always the client side.
	 */
	agencyDomains?: string[];
	/** Optional webhook to the agency's tracker (https). Signed with the Worker secret CHANGE_REQUESTS_WEBHOOK_SECRET. */
	webhook?: string;
	/** Keep closed (done / declined) requests this many months, then delete them and their files. Default 12. */
	retentionMonths?: number;
	/** Collections that get the "Request a change" editor panel. Default ["pages"]. */
	collections?: string[];
	/** The site handles sensitive data (kit.config sensitiveData): the form asks people not to include any. */
	sensitive?: boolean;
	/** Footer line of the emails (agency name). */
	footer?: string;
}

export const DEFAULT_RETENTION_MONTHS = 12;

/** The EmDash plugin descriptor for `emdash({ plugins: [changeRequestsPlugin({...})] })`: adds Plugins → Change requests. */
export function changeRequestsPlugin(options: ChangeRequestsOptions) {
	return {
		...CR_PLUGIN,
		format: "native" as const,
		displayName: "Change requests",
		description: "Ask your agency for changes and follow their status",
		entrypoint: "@wp2emdash/change-requests/plugin",
		// Only the upload page is React (Block Kit has no file input). The Worker plugin does NOT set admin.entry, so the
		// admin keeps rendering the Block Kit page, widget and editor panel (docs/spikes/change-requests-findings.md).
		adminEntry: "@wp2emdash/change-requests/admin",
		options,
	};
}
