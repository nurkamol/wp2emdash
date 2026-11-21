/**
 * Form messages: the health of the form outbox (@wp2emdash/forms), read through that package's own functions — the
 * message summaries in Workers KV metadata (no message is opened), the per-day counts and its email status. Counts
 * only: nothing anyone wrote is read, kept or shown here.
 */
import { type ChatEnv, readChatFailures } from "@wp2emdash/forms/chat";
import { deliveryOf, listSummaries, type OutboxEnv, outboxStatus, readCounts } from "@wp2emdash/forms/outbox";
import type { CheckState } from "../store.js";
import { DAY, dayOf, HOUR, plural } from "../util.js";

export interface FormsFacts {
	outbox: boolean;
	status?: "held" | "no-email" | "ready";
	waiting: number;
	failed: number;
	/** Oldest message still waiting (ISO). */
	oldest?: string;
	/** Last day a message was emailed right away (per-day counts). */
	lastEmailedDay?: string;
	/** Messages in the last 7 days (counts). */
	week: number;
	/** Chat notifications given up on in the last 7 days (after every retry), all channels. */
	chatFailed?: number;
}

/**
 * Reads the outbox. `emdashEmail`: whether EmDash's email pipeline has a provider (the plugin's `ctx.email`), used for
 * EMAIL_PROVIDER=emdash instead of asking EmDash's runtime again from inside a plugin run.
 */
export async function readForms(env: OutboxEnv & ChatEnv, o: { emdashEmail?: boolean; now?: number } = {}): Promise<FormsFacts> {
	if (!env.FORM_OUTBOX) return { outbox: false, waiting: 0, failed: 0, week: 0 };
	const now = o.now ?? Date.now();
	let status: FormsFacts["status"];
	if (env.FORM_OUTBOX_HOLD === "1") status = "held";
	else if (env.EMAIL_PROVIDER === "emdash") status = o.emdashEmail ? "ready" : "no-email";
	else status = await outboxStatus(env);
	const [{ items }, counts, chat] = await Promise.all([listSummaries(env, 1000), readCounts(env, dayOf(now - 6 * DAY)), readChatFailures(env, dayOf(now - 6 * DAY)).catch(() => undefined)]);
	const chatFailed = chat ? chat.telegram + chat.slack + chat.webhook : 0;
	// Test messages (workers.dev / preview links) and imports kept for reference are not the site's deliveries.
	const pending = items.filter((i) => !i.s.test && !i.s.noEmail && deliveryOf(i.s) !== "emailed");
	const failed = pending.filter((i) => deliveryOf(i.s) === "failed").length;
	const emailedDays = counts.filter((c) => c.outcome === "emailed" && c.count > 0).map((c) => c.day).sort();
	return { outbox: true, status, waiting: pending.length, failed, ...(pending[0] ? { oldest: pending[0].s.at } : {}), ...(emailedDays.length ? { lastEmailedDay: emailedDays.at(-1) as string } : {}), week: counts.reduce((n, c) => n + c.count, 0), ...(chatFailed ? { chatFailed } : {}) };
}

/** Messages per outcome in a month (YYYY-MM), from the outbox's per-day counts. */
export async function monthCounts(env: OutboxEnv, month: string): Promise<{ total: number; emailed: number; kept: number } | undefined> {
	if (!env.FORM_OUTBOX) return undefined;
	const rows = (await readCounts(env, `${month}-01`)).filter((c) => c.day.startsWith(month));
	const sum = (o?: string) => rows.filter((r) => !o || r.outcome === o).reduce((n, r) => n + r.count, 0);
	return { total: sum(), emailed: sum("emailed"), kept: sum("kept") };
}

export function formsCheck(f: FormsFacts, at: string, now = Date.now(), lastEmailedDay = f.lastEmailedDay): CheckState {
	const c = emailCheck(f, at, now, lastEmailedDay);
	if (!f.chatFailed || c.status === "off") return c;
	// Chat notifications that failed after every retry: worth a look, but email and the inbox are unaffected.
	const line = `${plural(f.chatFailed, "chat notification")} could not be delivered in the last 7 days (Form messages → Settings → Chat notifications).`;
	return { ...c, ...(c.status === "ok" ? { status: "warn" as const, summary: `${c.summary} ${line}` } : {}), detail: [...(c.detail ?? []), line] };
}

function emailCheck(f: FormsFacts, at: string, now: number, lastEmailedDay: string | undefined): CheckState {
	if (!f.outbox) return { status: "off", summary: "No form outbox on this site: messages are emailed directly and nothing is kept to watch.", at };
	const detail = [`${plural(f.week, "message")} in the last 7 days.`, ...(lastEmailedDay ? [`Last emailed right away: ${lastEmailedDay}.`] : [])];
	if (f.failed) return { status: "fail", summary: `${plural(f.failed, "form message")} refused by the email provider; ${f.waiting} waiting in total.`, at, detail };
	if (f.status === "held") return { status: f.waiting ? "warn" : "ok", summary: f.waiting ? `Email is on hold: ${plural(f.waiting, "message")} kept, none sent.` : "Email is on hold (owner's choice); no message is waiting.", at, detail };
	if (f.status === "no-email" && f.waiting) return { status: "fail", summary: `Email is not working: ${plural(f.waiting, "message")} waiting in the outbox.`, at, detail };
	if (f.status === "no-email") return { status: "warn", summary: "Email is not set up: new form messages would wait in the outbox.", at, detail };
	if (f.waiting && f.oldest && now - Date.parse(f.oldest) > HOUR) return { status: "warn", summary: `${plural(f.waiting, "message")} waiting for more than an hour.`, at, detail };
	return { status: "ok", summary: f.waiting ? `Email works; ${plural(f.waiting, "message")} about to be sent.` : "Email works; nothing is waiting.", at, detail };
}
