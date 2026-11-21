/**
 * Security headers of the live home page (hourly, from that tick's uptime probe through the Worker itself — what the
 * starter's middleware sends visitors): HSTS, Content-Security-Policy (and whether it names the violation-report
 * endpoint), X-Content-Type-Options, Referrer-Policy, frame protection (CSP frame-ancestors or X-Frame-Options) and
 * Permissions-Policy. Headers a Cloudflare zone rule adds outside the Worker are not seen here. Pure.
 */
import type { CheckState } from "../store.js";

/** The response headers the probe keeps (lower case). */
export const SECURITY_HEADERS = ["strict-transport-security", "content-security-policy", "x-content-type-options", "referrer-policy", "x-frame-options", "permissions-policy"] as const;

export interface SecurityFacts {
	at: string;
	/** HTTP status of the home page when read. */
	status: number;
	headers: Partial<Record<(typeof SECURITY_HEADERS)[number], string>>;
}

export interface HeaderRow {
	id: "hsts" | "csp" | "reports" | "nosniff" | "referrer" | "frames" | "permissions";
	label: string;
	ok: boolean;
	value: string;
	/** What it does, in plain words. */
	about: string;
}

const SIX_MONTHS = 15_552_000;
const cut = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One row per protection. `reports`: whether the build put the report endpoint into the CSP (site.config cspReport). */
export function headerRows(h: SecurityFacts["headers"], o: { reports: boolean }): HeaderRow[] {
	const csp = h["content-security-policy"] ?? "";
	const hsts = h["strict-transport-security"] ?? "";
	const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0);
	const referrer = (h["referrer-policy"] ?? "").toLowerCase();
	const xfo = (h["x-frame-options"] ?? "").toUpperCase();
	const ancestors = /(?:^|;)\s*frame-ancestors\s+([^;]+)/i.exec(csp)?.[1]?.trim();
	const rows: HeaderRow[] = [
		{ id: "hsts", label: "HTTPS only (HSTS)", ok: maxAge >= SIX_MONTHS, value: hsts ? cut(hsts) : "Missing", about: "Browsers always use the secure address, even if someone types http://." },
		{ id: "csp", label: "Content Security Policy", ok: !!csp, value: csp ? `${csp.split(";").length} rules` : "Missing", about: "Only scripts and embeds the site allows can run: injected code is blocked." },
	];
	if (o.reports) rows.push({ id: "reports", label: "Blocked-content reports", ok: /(?:^|;)\s*report-uri\s/i.test(csp), value: /(?:^|;)\s*report-uri\s/i.test(csp) ? "On" : "Missing from the policy", about: "Visitors' browsers report what the policy blocked (Security tab above)." });
	rows.push(
		{ id: "nosniff", label: "No content sniffing", ok: (h["x-content-type-options"] ?? "").toLowerCase() === "nosniff", value: h["x-content-type-options"] ?? "Missing", about: "Browsers do not guess file types, so an upload cannot run as a script." },
		{ id: "referrer", label: "Referrer policy", ok: !!referrer && !["unsafe-url", "no-referrer-when-downgrade"].includes(referrer), value: h["referrer-policy"] ?? "Missing", about: "Other sites only learn the site's name when a visitor follows a link, not the full page address." },
		{ id: "frames", label: "No framing by other sites", ok: (!!ancestors && !/\*/.test(ancestors)) || xfo === "DENY" || xfo === "SAMEORIGIN", value: ancestors ? `frame-ancestors ${ancestors}` : xfo || "Missing", about: "Other sites cannot show this site inside theirs to trick visitors into clicks." },
		{ id: "permissions", label: "Permissions policy", ok: !!h["permissions-policy"], value: h["permissions-policy"] ? cut(h["permissions-policy"]) : "Missing", about: "Camera, microphone and location stay off unless the site needs them." },
	);
	return rows;
}

export function headersCheck(f: SecurityFacts | undefined, at: string, o: { reports: boolean }): CheckState {
	if (!f) return { status: "unknown", summary: "Not checked yet: the home page's security headers are read every hour.", at };
	if (f.status !== 200) return { status: "unknown", summary: `Not checked: the home page answered HTTP ${f.status || "—"}.`, at };
	const rows = headerRows(f.headers, o);
	const missing = rows.filter((r) => !r.ok);
	if (missing.some((r) => r.id === "csp")) return { status: "fail", summary: "The home page is sent without its Content Security Policy: injected scripts would not be blocked.", at, detail: [`Also missing or weak: ${missing.filter((r) => r.id !== "csp").map((r) => r.label).join(", ") || "nothing else"}.`] };
	if (missing.length) return { status: "warn", summary: `${missing.map((r) => r.label).join(", ")}: missing or weak on the home page.`, at };
	return { status: "ok", summary: `All ${rows.length} security protections are sent with the home page.`, at };
}
