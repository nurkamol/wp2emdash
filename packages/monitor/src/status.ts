/**
 * The status page at the monitor's URL: one table of every site's state, certificate and domain expiry, and the
 * monitor's own health (last write, held alerts, failing channels). Private by default: without the STATUS_TOKEN
 * secret every request answers 404; with it, only `?token=<STATUS_TOKEN>` (or `Authorization: Bearer <token>`) sees the
 * page. Cloudflare Access in front of the workers.dev hostname is the stronger option (docs/monitor.md). No client
 * domain is listed publicly. The page is noindex, no-store, no-referrer (the token is in the URL), and loads nothing.
 */
import { channels } from "./alerts.js";
import { daysLeft } from "./expiry.js";
import { parseState, STATE_KEY, type MonitorState } from "./state.js";
import type { MonitorConfig, MonitorEnv } from "./types.js";

/** Constant-time string comparison (length leaks, content does not). */
export function safeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

/** Whether the request carries the status token. No token configured: nobody. Pure. */
export function authorized(url: URL, headers: { get(name: string): string | null }, token: string | undefined): boolean {
	if (!token || token.length < 16) return false;
	const q = url.searchParams.get("token") ?? "";
	const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1] ?? "";
	return safeEqual(q, token) || safeEqual(bearer, token);
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const when = (iso?: string) => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "—");

function expiryCell(iso: string | undefined, err: string | undefined, now: number, warn: number): string {
	if (!iso) return `<span class="muted">${esc(err ?? "—")}</span>`;
	const d = daysLeft(iso, now);
	return `<span class="${d <= warn ? "bad" : ""}">${iso.slice(0, 10)} (${d} d)</span>${err ? ` <span class="muted" title="${esc(err)}">*</span>` : ""}`;
}

/** The page. Pure. */
export function renderStatus(config: MonitorConfig, state: MonitorState, now: number, o: { channels: string[] }): string {
	const rows = config.sites
		.map((s) => {
			const st = state.sites[s.id];
			const e = state.expiry[s.id];
			const cls = !st ? "muted" : st.status === "down" ? "bad" : st.status === "suspect" ? "warn" : "ok";
			const label = !st ? "not checked yet" : st.status === "down" ? "DOWN" : st.status === "suspect" ? "1 failed check" : "up";
			return `<tr><td>${esc(s.id)}</td><td><a href="${esc(s.url)}" rel="noreferrer">${esc(s.url.replace(/^https:\/\//, ""))}</a></td><td class="${cls}">${label}</td><td>${when(st?.since)}${st?.reason && st.status !== "up" ? `<br><span class="muted">${esc(st.reason)}</span>` : ""}</td><td>${expiryCell(e?.cert, e?.certError, now, config.expiryWarnDays)}</td><td>${expiryCell(e?.domain, e?.domainError, now, config.expiryWarnDays)}</td></tr>`;
		})
		.join("");
	const down = config.sites.filter((s) => state.sites[s.id]?.status === "down").length;
	const suspect = config.sites.filter((s) => state.sites[s.id]?.status === "suspect").length;
	const notes = [
		`State last written ${when(state.writtenAt)} (written on every change and once a day; checks run every 5 minutes).`,
		o.channels.length ? `Alert channels: ${o.channels.join(", ")}.` : `<span class="bad">No alert channel is configured: set EMAIL_API_KEY (and "from" + "alertTo"), TELEGRAM_BOT_TOKEN or SLACK_WEBHOOK_URL.</span>`,
		state.lastDeliveryFailed?.length ? `<span class="bad">Last delivery failed on: ${esc(state.lastDeliveryFailed.join(", "))}.</span>` : "",
		state.alerts.held ? `<span class="warn">${state.alerts.held} alert(s) held today by the daily cap (${config.maxAlertsPerDay} messages).</span>` : "",
		state.pending.length ? `<span class="warn">${state.pending.length} alert(s) waiting to be retried.</span>` : "",
	].filter(Boolean);
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(config.label ? `${config.label} monitor` : "Site monitor")}</title><style>
:root{--bg:#fafaf9;--fg:#1a1a1a;--muted:#667085;--line:#e4e4e2;--ok:#067647;--warn:#b54708;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--fg:#ededed;--muted:#9a9a9a;--line:#2c2c2c;--ok:#47cd89;--warn:#fdb022;--bad:#f97066}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}
main{max-width:1000px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.wrap{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:16px 0}th,td{text-align:left;padding:8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}a{color:inherit}
.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad);font-weight:600}.muted{color:var(--muted)}p{margin:4px 0}
</style></head><body><main><h1>${esc(config.label ? `${config.label} monitor` : "Site monitor")}</h1><p class="${down ? "bad" : "ok"}">${down ? `${down} of ${config.sites.length} sites down` : `All ${config.sites.length} sites up${suspect ? ` (${suspect} with one failed check, rechecked in 5 minutes)` : ""}`}</p><div class="wrap"><table><thead><tr><th>Site</th><th>Address</th><th>Status</th><th>Since</th><th>Certificate</th><th>Domain</th></tr></thead><tbody>${rows || `<tr><td colspan="6" class="muted">No sites configured. Run wp2emdash monitor build.</td></tr>`}</tbody></table></div>${notes.map((n) => `<p class="muted">${n}</p>`).join("")}</main></body></html>`;
}

const HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" };

/** The Worker's fetch handler. */
export async function handleRequest(req: Request, env: MonitorEnv, config: MonitorConfig, now = Date.now()): Promise<Response> {
	const url = new URL(req.url);
	if (req.method !== "GET" || url.pathname !== "/" || !authorized(url, req.headers, env.STATUS_TOKEN)) return new Response("Not found", { status: 404, headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" } });
	const state = parseState(await env.MONITOR_KV.get(STATE_KEY));
	return new Response(renderStatus(config, state, now, { channels: channels(config, env) }), { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });
}
