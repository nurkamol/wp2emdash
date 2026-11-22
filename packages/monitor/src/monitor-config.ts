/**
 * Placeholder. `wp2emdash monitor build` writes the real file into the generated monitor project (URLs and alert
 * addresses only — never a token). Kept here so the package typechecks and the Worker runs empty.
 */
import type { MonitorConfig } from "./types.js";

const config: MonitorConfig = { version: 1, sites: [], alertTo: [], timeoutMs: 10_000, expiryWarnDays: 14, maxAlertsPerDay: 20, weeklySummary: false };

export default config;
