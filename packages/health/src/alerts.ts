/**
 * Alerts: an email when the site goes down or comes back, when a page keeps failing, when new broken links are found,
 * and when search-engine access, form email, the mail DNS records, the certificate or the analytics tags start failing.
 *
 * Rate limit: at most ONE email per issue per day (an issue = what happened, e.g. "site down", "site back up", "new
 * broken links"), and at most MAX_PER_DAY alert emails a day in total; the Site health page always shows the current
 * state. Sent only when the site is live, alerts are on, and never from a staging Worker. Alerts carry what failed,
 * where (paths of the site) and when — never form contents or anyone's personal data.
 */
import type { CheckId, CheckState, Incident, Status } from "./store.js";
import { CHECK_LABELS } from "./store.js";
import { DAY, dayOf, esc, shortTime } from "./util.js";

export const MAX_PER_DAY = 6;

export interface AlertEvent {
	/** The issue: one email per issue per day. */
	issue: string;
	subject: string;
	lines: string[];
	severity: "problem" | "recovery" | "info";
}

export type AlertLog = Record<string, string>;

/** Which events may be emailed today, and the log with them recorded. Pure. */
export function pickAlerts(events: AlertEvent[], log: AlertLog, now: number, max = MAX_PER_DAY): { send: AlertEvent[]; held: AlertEvent[]; log: AlertLog } {
	const today = dayOf(now);
	const cutoff = dayOf(now - 7 * DAY);
	const next: AlertLog = Object.fromEntries(Object.entries(log).filter(([, d]) => d >= cutoff));
	let sentToday = Object.values(next).filter((d) => d === today).length;
	const send: AlertEvent[] = [];
	const held: AlertEvent[] = [];
	for (const e of events) {
		if (next[e.issue] === today || sentToday >= max) {
			held.push(e);
			continue;
		}
		next[e.issue] = today;
		sentToday++;
		send.push(e);
	}
	return { send, held, log: next };
}

const FAILING: Status[] = ["fail"];
const ALERT_CHECKS: CheckId[] = ["indexability", "forms", "dns", "ssl", "analytics"];

const CHECK_ADVICE: Partial<Record<CheckId, string>> = {
	indexability: "Search engines are told not to index the site, or cannot read its sitemap. Pages can drop out of Google within days.",
	forms: "Website form messages are not being emailed. They are kept in Form messages in the admin until email works again.",
	dns: "The domain's email records changed since go-live. Email to and from the domain may stop working.",
	ssl: "The domain's security certificate needs attention: browsers may show a warning.",
	analytics: "The pages no longer carry a tracking code that is switched on, so visits may not be counted.",
};

const CHECK_SUBJECT: Partial<Record<CheckId, string>> = {
	indexability: "search engines are kept out",
	forms: "form messages are not being emailed",
	dns: "the domain's email records changed",
	ssl: "the security certificate needs attention",
	analytics: "a tracking code is missing from the pages",
};

/** Alert events from this run's changes. Pure. */
export function alertEvents(o: { siteName: string; before: Partial<Record<CheckId, CheckState>>; after: Partial<Record<CheckId, CheckState>>; opened: Incident[]; closed: Incident[]; freshLinks: { url: string; status: number; on: string[] }[] }): AlertEvent[] {
	const out: AlertEvent[] = [];
	for (const i of o.opened) {
		const down = i.kind === "down";
		out.push({ issue: down ? "down" : "page-error", severity: "problem", subject: down ? `${o.siteName}: the website is down` : `${o.siteName}: a page is not working`, lines: [down ? `The home page did not answer two checks in a row (since ${shortTime(i.startedAt)}).` : `${i.title} since ${shortTime(i.startedAt)}.`, ...(i.detail ? [`Details: ${i.detail}.`] : []), "The site is checked every 5 minutes; you get another email when it answers again."] });
	}
	for (const i of o.closed) {
		const down = i.kind === "down";
		out.push({ issue: down ? "up" : "page-ok", severity: "recovery", subject: down ? `${o.siteName}: the website is back up` : `${o.siteName}: the page works again`, lines: [`${down ? "The site" : i.title.replace(/^Page error on /, "The page ")} answers again (${i.endedAt ? shortTime(i.endedAt) : "now"}).`, ...(i.detail ? [`Details: ${i.detail}.`] : [])] });
	}
	for (const id of ALERT_CHECKS) {
		const a = o.after[id];
		const b = o.before[id];
		if (!a || !FAILING.includes(a.status) || (b && FAILING.includes(b.status))) continue;
		out.push({ issue: `${id}-fail`, severity: "problem", subject: `${o.siteName}: ${CHECK_SUBJECT[id] ?? `${CHECK_LABELS[id]} needs attention`}`, lines: [a.summary, ...(CHECK_ADVICE[id] ? [CHECK_ADVICE[id] as string] : [])] });
	}
	if (o.freshLinks.length) {
		const n = o.freshLinks.length;
		out.push({ issue: "links-new", severity: "problem", subject: `${o.siteName}: ${n} new broken link${n === 1 ? "" : "s"}`, lines: [`The daily link check found ${n} link${n === 1 ? "" : "s"} that no longer work${n === 1 ? "s" : ""}:`, ...o.freshLinks.slice(0, 10).map((l) => `${l.url} (${l.status ? `HTTP ${l.status}` : "no answer"})${l.on.length ? ` — linked from ${l.on.join(", ")}` : ""}`), ...(n > 10 ? [`…and ${n - 10} more on the Site health page.`] : [])] });
	}
	return out;
}

export interface Mail {
	subject: string;
	text: string;
	html: string;
}

/** The email for one alert: plain words, a link to the page, the footer. */
export function alertMail(e: AlertEvent, o: { siteName: string; adminUrl: string; footer: string; accent?: string }): Mail {
	const note = e.severity === "problem" ? "You get at most one email about this per day. The Site health page always shows the current state." : "";
	const text = [...e.lines, "", `Site health: ${o.adminUrl}`, ...(note ? ["", note] : []), ...(o.footer ? ["", o.footer] : [])].join("\n");
	const accent = /^#[0-9a-f]{3,8}$/i.test(o.accent ?? "") ? (o.accent as string) : "#1a1a1a";
	const colour = e.severity === "problem" ? "#b42318" : e.severity === "recovery" ? "#067647" : "#344054";
	const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a"><table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;border-top:4px solid ${colour}"><tr><td style="padding:24px"><p style="margin:0 0 4px;font-size:13px;color:#667085">${esc(o.siteName)} · Site health</p><h1 style="margin:0 0 16px;font-size:20px;color:${colour}">${esc(e.subject.replace(`${o.siteName}: `, ""))}</h1>${e.lines.map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join("")}<p style="margin:20px 0"><a href="${esc(o.adminUrl)}" style="display:inline-block;padding:10px 16px;background:${accent};color:#fff;text-decoration:none;border-radius:6px">Open Site health</a></p>${note ? `<p style="margin:0;font-size:13px;color:#667085">${esc(note)}</p>` : ""}</td></tr>${o.footer ? `<tr><td style="padding:12px 24px;border-top:1px solid #eee;font-size:12px;color:#667085">${esc(o.footer)}</td></tr>` : ""}</table></body></html>`;
	return { subject: e.subject, text, html };
}
