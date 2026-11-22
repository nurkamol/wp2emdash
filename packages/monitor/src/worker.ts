/**
 * The monitor Worker: `scheduled` runs one tick (wrangler.jsonc triggers.crons ["*\/5 * * * *"]), `fetch` serves the
 * token-protected status page. Logs carry counts and channel names only — never a token, an address or page content.
 */
import config from "./monitor-config.js";
import { handleRequest } from "./status.js";
import { runTick } from "./tick.js";
import type { MonitorEnv } from "./types.js";

interface Controller {
	scheduledTime: number;
	cron: string;
}
interface Ctx {
	waitUntil(p: Promise<unknown>): void;
}

export default {
	async scheduled(controller: Controller, env: MonitorEnv, _ctx: Ctx): Promise<void> {
		const r = await runTick({ config, env, fetch: (u, i) => fetch(u, i), scheduledTime: controller.scheduledTime });
		console.log(JSON.stringify({ monitor: { checked: r.checked, failing: r.failing, opened: r.opened, closed: r.closed, expiry: r.expiryLookups, sent: r.sent, held: r.held, delivered: r.delivered, failed: r.failedChannels, wrote: r.wrote } }));
	},
	async fetch(req: Request, env: MonitorEnv): Promise<Response> {
		return handleRequest(req, env, config);
	},
};
