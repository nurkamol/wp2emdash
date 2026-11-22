/**
 * Alerts: one per incident opened, one per recovery, one expiry warning per site and kind per day, and the optional
 * weekly summary. Every event has a key (`open:<incident>`, `close:<incident>`, `cert:<site>:<day>`, …) recorded in
 * the alert log when it is sent, so it is never sent twice. All events of one tick go out as ONE message (a Cloudflare
 * outage that takes ten sites down is one email, not ten), and at most `maxAlertsPerDay` messages go out per UTC day;
 * past that, events are held (counted on the status page) — the status page always shows the current state.
 *
 * Messages name the site id, its address, what failed and when: never page content. Pure, except `deliverAll`.
 */
import { deliver, parseAddress } from "@wp2emdash/forms/deliver";
import { daysLeft, type ExpiryInfo } from "./expiry.js";
import type { IncidentEvent } from "./incident.js";
import type { Fetch, MonitorConfig, MonitorEnv, MonitorSite } from "./types.js";

export interface AlertEvent {
	key: string;
	kind: "down" | "up" | "cert" | "domain" | "summary";
	severity: "problem" | "recovery" | "info";
	site?: string;
	/** One line, e.g. "acme is down: HTTP 522". */
	title: string;
	lines: string[];
}

export interface AlertLog {
	/** Event key → UTC day it was sent (kept 8 days). */
	sent: Record<string, string>;
	/** Messages sent on `day`. */
	day: string;
	count: number;
	/** Events held today by the daily cap. */
	held: number;
}

export const emptyLog = (): AlertLog => ({ sent: {}, day: "", count: 0, held: 0 });
export const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);

const time = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

export function duration(ms: number): string {
	const m = Math.max(1, Math.round(ms / 60_000));
	if (m < 60) return `${m} min`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h} h ${m % 60} min`;
	return `${Math.floor(h / 24)} days ${h % 24} h`;
}

/** Incident transitions → events. Pure. */
export function incidentEvents(events: IncidentEvent[], sites: MonitorSite[]): AlertEvent[] {
	const url = (id: string) => sites.find((s) => s.id === id)?.url ?? "";
	return events.map((e) =>
		e.type === "open"
			? { key: `open:${e.incident}`, kind: "down", severity: "problem", site: e.site, title: `${e.site} is DOWN: ${e.reason}`, lines: [`${url(e.site)} failed two checks in a row from outside (first failure ${time(e.startedAt)}).`, `Last reason: ${e.reason}.`, "Checked every 5 minutes; you get one message when it answers again."] }
			: { key: `close:${e.incident}`, kind: "up", severity: "recovery", site: e.site, title: `${e.site} is back up after ${duration(e.durationMs ?? 0)}`, lines: [`${url(e.site)} answers again (${time(e.at)}); it was down since ${time(e.startedAt)}.`] },
	);
}

/** Daily expiry warnings for one site (only called in its daily lookup tick). Pure. */
export function expiryEvents(site: MonitorSite, info: ExpiryInfo, now: number, warnDays: number): AlertEvent[] {
	const out: AlertEvent[] = [];
	const day = dayOf(now);
	if (info.cert) {
		const d = daysLeft(info.cert, now);
		if (d <= warnDays) out.push({ key: `cert:${site.id}:${day}`, kind: "cert", severity: "problem", site: site.id, title: `${site.id}: the TLS certificate expires in ${d} day${d === 1 ? "" : "s"}`, lines: [`The newest valid certificate for ${new URL(site.url).hostname} in the Certificate Transparency logs expires ${info.cert.slice(0, 10)} and no renewed one has been issued yet.`, "Cloudflare-managed certificates renew on their own; check the zone's SSL/TLS → Edge Certificates (a paused zone, moved DNS or a CAA record can block renewal)."] });
	}
	if (info.domain) {
		const d = daysLeft(info.domain, now);
		if (d <= warnDays) out.push({ key: `domain:${site.id}:${day}`, kind: "domain", severity: "problem", site: site.id, title: `${site.id}: the domain expires in ${d} day${d === 1 ? "" : "s"}`, lines: [`${site.domain ?? new URL(site.url).hostname} is registered until ${info.domain.slice(0, 10)} (RDAP). Renew it at the registrar, or ask the client to.`] });
	}
	return out;
}

/** Which events go out now, which are held by the daily cap, and the updated log. Already-sent keys are dropped. Pure. */
export function pickAlerts(events: AlertEvent[], log: AlertLog, now: number, maxPerDay: number): { send: AlertEvent[]; held: AlertEvent[]; log: AlertLog } {
	const today = dayOf(now);
	const cutoff = dayOf(now - 8 * 86_400_000);
	const sent = Object.fromEntries(Object.entries(log.sent).filter(([, d]) => d >= cutoff));
	const base: AlertLog = log.day === today ? { ...log, sent } : { sent, day: today, count: 0, held: 0 };
	const fresh = events.filter((e, i) => !sent[e.key] && events.findIndex((x) => x.key === e.key) === i);
	if (!fresh.length) return { send: [], held: [], log: base };
	if (base.count >= maxPerDay) return { send: [], held: fresh, log: { ...base, held: base.held + fresh.length } };
	for (const e of fresh) sent[e.key] = today;
	return { send: fresh, held: [], log: { ...base, sent, count: base.count + 1 } };
}

export interface Message {
	subject: string;
	text: string;
	html: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** One message for all events of a tick. Pure. */
export function composeMessage(events: AlertEvent[], o: { label?: string; statusUrl?: string }): Message {
	const prefix = o.label ? `${o.label} monitor` : "Site monitor";
	const down = events.filter((e) => e.kind === "down").length;
	const up = events.filter((e) => e.kind === "up").length;
	const exp = events.filter((e) => e.kind === "cert" || e.kind === "domain").length;
	const subject =
		events.length === 1
			? `${prefix}: ${(events[0] as AlertEvent).title}`
			: `${prefix}: ${[down ? `${down} down` : "", up ? `${up} back up` : "", exp ? `${exp} expiring` : "", events.length - down - up - exp ? "summary" : ""].filter(Boolean).join(", ")}`;
	const blocks = events.map((e) => [e.title, ...e.lines.map((l) => `  ${l}`)].join("\n"));
	const footer = ["Sent by the wp2emdash outside-in monitor (one Worker, 5-minute checks).", ...(o.statusUrl ? [`Status page: ${o.statusUrl}`] : [])];
	const text = [...blocks, "", ...footer].join("\n\n");
	const colour = (e: AlertEvent) => (e.severity === "problem" ? "#b42318" : e.severity === "recovery" ? "#067647" : "#344054");
	const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a"><table role="presentation" width="100%" style="max-width:640px;margin:0 auto;background:#fff;border-radius:8px"><tr><td style="padding:24px"><p style="margin:0 0 12px;font-size:13px;color:#667085">${esc(prefix)}</p>${events.map((e) => `<div style="border-left:4px solid ${colour(e)};padding:4px 12px;margin:0 0 16px"><p style="margin:0 0 6px;font-weight:600;color:${colour(e)}">${esc(e.title)}</p>${e.lines.map((l) => `<p style="margin:0 0 4px">${esc(l)}</p>`).join("")}</div>`).join("")}<p style="margin:16px 0 0;font-size:12px;color:#667085">${footer.map(esc).join("<br>")}</p></td></tr></table></body></html>`;
	return { subject, text, html };
}

/** Telegram sendMessage body (parse_mode HTML: only &, < and > need escaping; 4096 characters at most). */
export function telegramBody(m: Message, chatId: string): Record<string, unknown> {
	const t = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	return { chat_id: chatId, text: `<b>${t(m.subject)}</b>\n\n${t(m.text)}`.slice(0, 4096), parse_mode: "HTML", link_preview_options: { is_disabled: true } };
}

/** Slack incoming-webhook body. */
export const slackBody = (m: Message) => ({ text: `*${m.subject}*\n${m.text}`.slice(0, 3900) });

export type Channel = "email" | "telegram" | "slack";

/** The channels configured (secret present and the non-secret part set). Never exposes a secret. */
export function channels(config: MonitorConfig, env: MonitorEnv): Channel[] {
	const out: Channel[] = [];
	if (env.EMAIL_API_KEY && parseAddress(config.from) && config.alertTo.length) out.push("email");
	if (/^\d{3,20}:[\w-]{20,100}$/.test(env.TELEGRAM_BOT_TOKEN ?? "") && config.telegramChatId) out.push("telegram");
	if (/^https:\/\//.test(env.SLACK_WEBHOOK_URL ?? "")) out.push("slack");
	return out;
}

/** Sends one message on every configured channel. Returns channel names that worked / failed (no addresses, no secrets). */
export async function deliverAll(m: Message, config: MonitorConfig, env: MonitorEnv, fetch: Fetch): Promise<{ ok: Channel[]; failed: Channel[] }> {
	const ok: Channel[] = [];
	const failed: Channel[] = [];
	for (const ch of channels(config, env)) {
		try {
			let good = false;
			if (ch === "email") {
				const r = await deliver(config.emailProvider ?? "brevo", env.EMAIL_API_KEY as string, { from: parseAddress(config.from) as { email: string; name?: string }, to: config.alertTo, subject: m.subject, text: m.text, html: m.html }, env.MAILGUN_REGION ? { region: env.MAILGUN_REGION } : {});
				good = r.ok;
			} else {
				const url = ch === "telegram" ? `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage` : (env.SLACK_WEBHOOK_URL as string);
				const body = ch === "telegram" ? telegramBody(m, config.telegramChatId as string) : slackBody(m);
				const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), redirect: "manual" });
				await res.body?.cancel().catch(() => {});
				good = res.ok;
			}
			(good ? ok : failed).push(ch);
		} catch {
			failed.push(ch);
		}
	}
	return { ok, failed };
}
