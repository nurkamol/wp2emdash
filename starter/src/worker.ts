import { env as workerEnv } from "cloudflare:workers";
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { flushOutbox, type OutboxEnv } from "@wp2emdash/forms/outbox";
import { purgeUploads, type UploadEnv } from "@wp2emdash/forms/uploads";
import site from "./site.config.json";
import { rewarm, rewarmDue } from "./utils/rewarm";

export { PluginBridge };

const emdashScheduled = createScheduledHandler();

export default {
	...handler,
	// EmDash's own cron work, plus the form outbox (queued messages are emailed once delivery works) and, on sites with
	// file upload fields, once an hour: files visitors sent that are past their retention period are deleted.
	scheduled: async (controller, env, ctx) => {
		ctx.waitUntil(flushOutbox(workerEnv as unknown as OutboxEnv).catch(() => {}));
		if ((site as { formUploads?: boolean }).formUploads && new Date(controller.scheduledTime).getUTCMinutes() < 5) ctx.waitUntil(purgeUploads(workerEnv as unknown as UploadEnv).catch(() => 0));
		// Pages an edit purged are rendered again here, not for the next visitor (src/utils/rewarm.ts).
		const rw = (site as { rewarm?: { origin: string; everyMinutes: number } }).rewarm;
		if (rw && rewarmDue(controller.scheduledTime, rw.everyMinutes))
			ctx.waitUntil(
				rewarm(rw.origin)
					.then((r) => console.log(`rewarm: ${r.pages} pages, ${r.rendered} rendered, ${r.failed} failed`))
					.catch(() => {}),
			);
		return emdashScheduled(controller, env, ctx);
	},
} satisfies ExportedHandler;
