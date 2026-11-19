/**
 * @wp2emdash/forms — website forms for EmDash on Cloudflare Workers: a form endpoint (Turnstile, rate limit,
 * validation, email through Brevo/Resend/Postmark/SendGrid/Mailgun), an optional outbox in Workers KV that keeps
 * messages when email is unavailable, and the "Form messages" admin page (EmDash native plugin, admins only).
 *
 * This entry is safe to import from astro.config (Node): it only builds the plugin descriptor. The Worker-side
 * modules are `@wp2emdash/forms/endpoint`, `/outbox`, `/deliver` and `/plugin`. See README.md.
 */
import { FORMS_PLUGIN } from "./meta.js";

export type { ContentBlock, FormDefinition, FormField, FormFieldType, InlinePart } from "./types.js";
export { FORMS_PLUGIN };

/** The EmDash plugin descriptor for `emdash({ plugins: [formsPlugin()] })`: adds Plugins → Form messages and a dashboard widget. */
export function formsPlugin() {
	return {
		...FORMS_PLUGIN,
		format: "native" as const,
		displayName: "Form messages",
		description: "Messages waiting in the form outbox: inbox, insights, import and export",
		entrypoint: "@wp2emdash/forms/plugin",
	};
}
