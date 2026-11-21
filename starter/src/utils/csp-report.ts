/**
 * CSP violation reports (Site health → Security, @wp2emdash/health `csp` route). When site.config.json carries
 * `cspReport` (scaffold: Site health on and kit.config health.cspReports not false), the public CSP names the endpoint
 * twice — `report-to` for browsers with the Reporting API (Chrome, Edge; endpoint from the Reporting-Endpoints header)
 * and `report-uri` for the others (Safari, Firefox) — so the first visitor whose browser blocks a script reports it.
 * Signed-in editors' CSP never names it (they get 'unsafe-inline' anyway). Baked in at build: the middleware reads no
 * setting per request; the admin switch only stops storing and alerts (docs/spikes/csp-reports-findings.md).
 *
 * No imports here: this file must load in Node (kit tests) and in the Worker (starter).
 */

/** The plugin route that receives the reports. */
export const CSP_REPORT_PATH = "/_emdash/api/plugins/site-health/csp";
/** The Reporting API endpoint name used by `report-to` and the Reporting-Endpoints header. */
export const CSP_REPORT_GROUP = "csp-endpoint";

const PATH = /^\/[A-Za-z0-9_\-/.]+$/;

/** The CSP directives that send reports, or none (editors, reporting off, an unusable path). */
export function reportDirectives(path: string | undefined, editor: boolean): string[] {
	if (editor || !path || !PATH.test(path)) return [];
	return [`report-uri ${path}`, `report-to ${CSP_REPORT_GROUP}`];
}

/** The Reporting-Endpoints header value (absolute: the Reporting API wants a secure URL), or undefined. */
export function reportingEndpoints(origin: string, path: string | undefined, editor: boolean): string | undefined {
	if (editor || !path || !PATH.test(path) || !/^https?:\/\/[^/"\s]+$/.test(origin)) return undefined;
	return `${CSP_REPORT_GROUP}="${origin}${path}"`;
}
