/**
 * Change requests (@wp2emdash/change-requests, on by default): the plugin options scaffold writes into astro.config —
 * agency recipients (kit.config changeRequests.agencyTo → email.stagingTo), agency domains, the optional webhook URL
 * (its signing secret is the Worker secret CHANGE_REQUESTS_WEBHOOK_SECRET, never here), retention and the collections
 * that get the editor panel. Plus the client docs (editor guide section and docs/change-requests.md).
 */
import type { ChangeRequestsOptions } from "../../packages/change-requests/src/index.js";
import type { KitConfig } from "../config/schema.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const valid = (list: string[]) => [...new Set(list.map((x) => x.trim()).filter((x) => EMAIL.test(x)))];

export interface ChangeRequestsInputs {
	config: Pick<KitConfig, "name" | "email" | "changeRequests" | "sensitiveData"> & Partial<Pick<KitConfig, "health">>;
	productionUrl: string;
	collections: string[];
}

export function changeRequestsOptions(i: ChangeRequestsInputs): ChangeRequestsOptions | undefined {
	const c = i.config.changeRequests;
	if (c === false) return undefined;
	const brand = i.config.health ? i.config.health.brand : undefined;
	return {
		productionUrl: i.productionUrl,
		siteName: i.config.name,
		agencyTo: valid(c.agencyTo ?? i.config.email.stagingTo),
		...(c.agencyDomains.length ? { agencyDomains: c.agencyDomains.map((d) => d.replace(/^@/, "").toLowerCase()) } : {}),
		...(c.webhook ? { webhook: c.webhook } : {}),
		...(c.retentionMonths !== 12 ? { retentionMonths: c.retentionMonths } : {}),
		collections: i.collections,
		...(i.config.sensitiveData ? { sensitive: true } : {}),
		...(brand ? { footer: brand } : {}),
	};
}

export interface ChangeRequestsDocInput {
	retentionMonths: number;
	webhook: boolean;
}

/** The editor guide's section (the full guide is docs/change-requests.md). */
export const changeRequestsGuide = (c: ChangeRequestsDocInput | undefined) =>
	c
		? `
## Asking us for a change

**Plugins → Change requests → Request a change** (editors and administrators) sends a change request to your agency:
what should change, on which page, how urgent it is, and up to three screenshots or PDF files. You see its status —
New, Seen, In progress, Waiting for you, Done or Declined — and every reply on the same page, and get an email when it
changes. On a page in the editor, the **Request a change** panel does the same with the page already chosen. See
[Change requests](change-requests.md).
`
		: "";

/** docs/change-requests.md: how the client asks for a change. */
export function changeRequestsDoc(c: ChangeRequestsDocInput, o: { sensitiveData: boolean }): string {
	return `
# Change requests

Ask your agency for a change from inside the admin instead of by email or messages: everything about one change stays
in one place, with its status.

## Send a request

1. Open **Plugins → Change requests** and choose the **Request a change** tab.
2. Give it a short **title** ("Update the opening hours on Contact") and describe **what should change** — what is
   there now and what it should be.
3. Choose **which page** (or *Anywhere on the site*) and, if it helps, **which part of the page** ("the price table").
4. **Priority**: *Normal*, or *Urgent* when something is wrong on the live site.
5. **How should we get back to you?** Here in the admin, by email, or by phone.
6. Leave **Email me when the status changes** on to hear about progress (you can switch it off on the request later).
7. **Send request**.

Then add **screenshots or PDF files** (up to 3, 5 MB each): **Add screenshots or PDF files…** opens an upload page in a
new tab — choose files, or paste a screenshot with Ctrl/Cmd + V. Files are private: only signed-in editors and
administrators of the site can download them.

While editing a page, the **Request a change** panel in the sidebar sends a request about that page directly.
${o.sensitiveData ? "\n**Please leave out personal information** about clients or visitors (names, health, legal or financial details): describe the change itself.\n" : ""}
## Follow it

The **Requests** tab lists open requests (filter by status, priority, or only yours). **Open** one to see its details,
files and timeline.

| Status | Means |
|---|---|
| New | Sent; the agency has not opened it yet |
| Seen | The agency has read it |
| In progress | Being worked on |
| Waiting for you | The agency needs something from you — answer in the comment box |
| Done | Finished |
| Declined | Not done (or you withdrew it) |

- **Comment** to add information; answering a request that is *Waiting for you* hands it back to the agency.
- The person who sent a request can **withdraw** it, **mark it as done**, or **reopen** it within 30 days after it was
  done.
- Everyone with editor access sees all of the site's requests and can comment on open ones.

## Emails

The agency gets an email for each new request. You get one when the status of your request changes (except "Seen") or
the agency replies — unless you switched it off (**Stop update emails** on the request). Emails only contain the
request itself and a link to it.${c.webhook ? " Your agency also receives each request in its project tracker." : ""}

## How long requests are kept

Open requests are kept until they are closed. Done and declined requests are deleted, with their files, ${c.retentionMonths} months after
they were closed. They are part of the site's nightly backups in the meantime.
`;
}
