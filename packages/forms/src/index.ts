/**
 * @wp2emdash/forms — website forms for EmDash on Cloudflare Workers: a form endpoint (Turnstile, rate limit,
 * validation, email through Brevo/Resend/Postmark/SendGrid/Mailgun), an optional outbox in Workers KV that keeps
 * messages when email is unavailable, and the "Form messages" admin page (EmDash native plugin, admins only).
 *
 * This entry is safe to import from astro.config (Node): it only builds the plugin descriptor. The Worker-side
 * modules are `@wp2emdash/forms/endpoint`, `/outbox`, `/deliver`, `/chat`, `/crm` and `/plugin`. See README.md.
 */
import { FORMS_PLUGIN } from "./meta.js";

export type { ContentBlock, FormDefinition, FormField, FormFieldType, InlinePart } from "./types.js";
export { FORMS_PLUGIN };

/** A form as the plugin's Settings see it: the chat form picker (id, title) and the CRM field mapping (fields, sensitive). */
export interface PluginForm {
	id: string;
	title: string;
	/** Sensitive form: never sent to a CRM or mailing list. */
	sensitive?: boolean;
	/** Inputs the CRM mapping can offer (name, label, type; a checkbox group is "checkbox-group"). Never values. */
	fields?: { name: string; label: string; type: string; autocomplete?: string }[];
}

/** Descriptor options: the site's forms, for Settings → Chat notifications and → CRM & mailing lists. */
export interface FormsPluginOptions {
	forms?: PluginForm[];
}

const MAPPABLE = new Set(["text", "email", "tel", "textarea", "select", "radio", "checkbox", "consent"]);

/** A form definition → what the plugin descriptor carries (no options, help texts or content). */
export function pluginForm(f: { id: string; title: string; sensitive?: boolean; fields: { name: string; label: string; type: string; autocomplete?: string; options?: string[] }[] }): PluginForm {
	const fields = f.fields.filter((x) => MAPPABLE.has(x.type)).map((x) => ({ name: x.name, label: x.label, type: x.type === "checkbox" && (x.options?.length ?? 0) > 1 ? "checkbox-group" : x.type, ...(x.autocomplete ? { autocomplete: x.autocomplete } : {}) }));
	return { id: f.id, title: f.title, ...(f.sensitive ? { sensitive: true } : {}), ...(fields.length ? { fields } : {}) };
}

/** The EmDash plugin descriptor for `emdash({ plugins: [formsPlugin()] })`: adds Plugins → Form messages and a dashboard widget. */
export function formsPlugin(options?: FormsPluginOptions) {
	return {
		...FORMS_PLUGIN,
		format: "native" as const,
		displayName: "Form messages",
		description: "Messages waiting in the form outbox: inbox, insights, import and export, chat notifications, CRM sync",
		entrypoint: "@wp2emdash/forms/plugin",
		...(options?.forms?.length ? { options: { forms: options.forms.map((f) => ({ id: f.id, title: f.title, ...(f.sensitive ? { sensitive: true } : {}), ...(f.fields?.length ? { fields: f.fields } : {}) })) } } : {}),
	};
}
