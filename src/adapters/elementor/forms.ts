/**
 * Elementor Pro Form widget → the starter's form definition (src/scaffold/forms.ts), like Bricks forms.
 * Kept: fields (`form_fields[{ custom_id, field_type, field_label, placeholder, required, field_options, width }]`),
 * the submit text (`button_text`), the success message (`success_message`).
 * Never copied: recipients (`email_to`, `email_to_cc`, `email_to_bcc`, `email_from`), webhooks, API keys. Actions other
 * than email (`submit_actions`: redirect, mailchimp, webhook, …) become warnings.
 */
import type { FormDefinitionOut, FormFieldOut } from "../../scaffold/forms.js";
import { obj, str } from "./site.js";

const TYPE: Record<string, FormFieldOut["type"]> = { text: "text", email: "email", tel: "tel", number: "number", url: "url", textarea: "textarea", select: "select", radio: "radio", checkbox: "checkbox", acceptance: "consent", date: "date" };
/** Not inputs, or anti-spam the starter replaces with Turnstile: left out without a warning. */
const SKIP = new Set(["html", "recaptcha", "recaptcha_v3", "honeypot", "step"]);
/** Elementor Pro's default success message. */
export const ELEMENTOR_SUCCESS = "Your submission was successful.";

const slug = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/[\s-]+/g, "_")
		.slice(0, 40);
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Options: one per line; `label|value` lines show the label. */
const optionsOf = (f: Record<string, unknown>) =>
	(str(f.field_options) ?? "")
		.split(/\r?\n/)
		.map((l) => l.split("|")[0]?.trim() ?? "")
		.filter(Boolean);

export function elementorFormToDefinition(id: string, settings: Record<string, unknown>, title: string): FormDefinitionOut {
	const warnings: string[] = [];
	const fields: FormFieldOut[] = [];
	const used = new Set<string>();
	const raw = (Array.isArray(settings.form_fields) ? (settings.form_fields as unknown[]) : []).map(obj).filter((f): f is Record<string, unknown> => !!f);
	for (const f of raw) {
		const etype = str(f.field_type) ?? "text";
		const label = stripHtml(str(f.field_label) ?? "") || str(f.placeholder) || "";
		if (SKIP.has(etype)) continue;
		if (etype === "hidden") {
			warnings.push(`hidden field "${str(f.custom_id) ?? label}" not rebuilt (its value is set by the page); add it by hand if the receiver needs it`);
			continue;
		}
		const type = TYPE[etype];
		if (!type) {
			warnings.push(`field "${label || etype}" (${etype}) not supported; rebuild by hand`);
			continue;
		}
		let name = str(f.custom_id)?.trim() || slug(label) || `field_${fields.length}`;
		while (used.has(name)) name = `${name}_${fields.length}`;
		used.add(name);
		const options = type === "select" || type === "radio" || (type === "checkbox" && str(f.field_options)) ? optionsOf(f) : [];
		const width = Number(str(f.width));
		const required = f.required === true || f.required === "true" || f.required === "yes";
		const autocomplete = type === "email" ? "email" : type === "tel" ? "tel" : undefined;
		fields.push({ name, label: label || name, type, ...(required ? { required: true } : {}), ...(str(f.placeholder) ? { placeholder: str(f.placeholder) } : {}), ...(options.length ? { options } : {}), ...(width > 0 && width <= 50 ? { half: true } : {}), ...(autocomplete ? { autocomplete } : {}) });
	}
	const actions = Array.isArray(settings.submit_actions) ? (settings.submit_actions as unknown[]).map(String) : ["email"];
	const other = actions.filter((a) => a !== "email" && a !== "email2");
	if (!actions.includes("email")) warnings.push(`the Elementor form does not send email (actions: ${actions.join(", ") || "none"}); decide what the new form does`);
	if (other.length) warnings.push(`Elementor form actions not rebuilt: ${other.join(", ")}`);
	if (str(settings.email_to)) warnings.push("recipient set in Elementor: set it in the admin (Forms → recipients), it is not copied");
	if (!fields.some((f) => f.type === "email" || f.type === "tel")) warnings.push("no email or phone field to reply to");
	const success = str(settings.success_message);
	return { id: `elementor-${id}`, title: str(settings.form_name) || title, submitLabel: stripHtml(str(settings.button_text) ?? "") || "Send", successMessage: success ? stripHtml(success) : ELEMENTOR_SUCCESS, fields, warnings };
}
