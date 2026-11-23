import { env as workerEnv } from "cloudflare:workers";
import handler, { createScheduledHandler, PluginBridge } from "@emdash-cms/cloudflare/worker";
import { type ChatEnv, flushChat } from "@wp2emdash/forms/chat";
import { type CrmEnv, flushCrm } from "@wp2emdash/forms/crm";
import { flushOutbox, type OutboxEnv } from "@wp2emdash/forms/outbox";
import { purgeUploads, type UploadEnv } from "@wp2emdash/forms/uploads";
import site from "./site.config.json";
import { rewarmTick } from "./utils/rewarm";
import { serveVideo, type VideoBucket } from "./utils/video";

export { PluginBridge };

const emdashScheduled = createScheduledHandler();

export default {
	...handler,
	// Background videos in web sizes, cacheable by the Worker cache in front (src/utils/video.ts); everything else is EmDash's.
	fetch: async (request, env, ctx) => (await serveVideo(request, (workerEnv as { MEDIA?: VideoBucket }).MEDIA)) ?? handler.fetch!(request, env, ctx),
	// EmDash's own cron work, plus the form outbox (queued messages are emailed once delivery works) and, on sites with
	// file upload fields, once an hour: files visitors sent that are past their retention period are deleted.
	scheduled: async (controller, env, ctx) => {
		ctx.waitUntil(flushOutbox(workerEnv as unknown as OutboxEnv).catch(() => {}));
		// Chat notifications (Telegram, Slack, webhook) that failed right after a form message are retried here.
		ctx.waitUntil(flushChat(workerEnv as unknown as ChatEnv).catch(() => {}));
		// CRM / mailing-list contacts (Brevo, HubSpot, Mailchimp) that failed with a temporary error, with backoff.
		ctx.waitUntil(flushCrm(workerEnv as unknown as CrmEnv).catch(() => {}));
		if ((site as { formUploads?: boolean }).formUploads && new Date(controller.scheduledTime).getUTCMinutes() < 5) ctx.waitUntil(purgeUploads(workerEnv as unknown as UploadEnv).catch(() => 0));
		// Pages an edit purged are rendered again here, not for the next visitor (src/utils/rewarm.ts).
		// Admins switch it and ask for a full refresh on Site health → Speed.
		const rw = (site as { rewarm?: { origin: string; everyMinutes: number } }).rewarm;
		if (rw)
			ctx.waitUntil(
				rewarmTick((workerEnv as { DB?: Parameters<typeof rewarmTick>[0] }).DB, rw, controller.scheduledTime)
					.then((line) => line && console.log(line))
					.catch(() => {}),
			);
		return emdashScheduled(controller, env, ctx);
	},
} satisfies ExportedHandler;
