import { env as workerEnv } from "cloudflare:workers";
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { flushOutbox, type OutboxEnv } from "./forms/outbox";

export { PluginBridge };

const emdashScheduled = createScheduledHandler();

export default {
	...handler,
	// EmDash's own cron work, plus the form outbox (queued messages are emailed once delivery works).
	scheduled: async (controller, env, ctx) => {
		ctx.waitUntil(flushOutbox(workerEnv as unknown as OutboxEnv).catch(() => {}));
		return emdashScheduled(controller, env, ctx);
	},
} satisfies ExportedHandler;
