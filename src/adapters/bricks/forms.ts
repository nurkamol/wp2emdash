/**
 * Bricks form element (includes/elements/form.php) → the starter's form definition (src/scaffold/forms.ts).
 * Kept: fields (type, label, placeholder, required, options, width), submit text, success message.
 * Never copied: recipients (emailTo / emailToCustom / emailBcc / fromEmail), webhooks, API keys. Actions other
 * than email (Mailchimp, SendGrid, webhook, login, registration, create post…) become warnings.
 */
import type { FormDefinitionOut, FormFieldOut } from "../../scaffold/forms.js";
import { obj, str } from "./site.js";

const TYPE: Record<string, FormFieldOut["type"]> = { text: "text", email: "email", tel: "tel", number: "number", url: "url", textarea: "textarea", richtext: "textarea", select: "select", radio: "select", checkbox: "checkbox", datepicker: "date" };
/** Not rendered as an input, or anti-spam the starter replaces with Turnstile: left out without a warning. */
const SKIP = new Set(["html"]);
/** Bricks' default success message (form.php `successMessage` default). */
export const BRICKS_SUCCESS = "Message successfully sent. We will get back to you as soon as possible.";

const slug = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/[\s-]+/g, "_")
		.slice(0, 40);
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Options textarea: one per line; with valueLabelOptions each line is `value:label`. */
function optionsOf(f: Record<string, unknown>): string[] {
	const lines = (str(f.options) ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	return f.valueLabelOptions ? lines.map((l) => (l.includes(":") ? l.slice(l.indexOf(":") + 1).trim() : l)) : lines;
}

export function bricksFormToDefinition(id: string, settings: Record<string, unknown>, title: string): FormDefinitionOut {
	const warnings: string[] = [];
	const fields: FormFieldOut[] = [];
	const used = new Set<string>();
	const raw = (Array.isArray(settings.fields) ? (settings.fields as unknown[]) : []).map(obj).filter((f): f is Record<string, unknown> => !!f);
	for (const f of raw) {
		const btype = str(f.type) ?? "text";
		const label = stripHtml(str(f.label) ?? "") || str(f.placeholder) || "";
		if (f.isHoneypot || SKIP.has(btype)) continue;
		if (btype === "hidden") {
			warnings.push(`hidden field "${str(f.name) ?? label ?? str(f.id)}" not rebuilt (its value is set by the page); add it by hand if the receiver needs it`);
			continue;
		}
		const type = TYPE[btype];
		if (!type) {
			warnings.push(`field "${label || btype}" (${btype}) not supported; rebuild by hand`);
			continue;
		}
		if (btype === "radio") warnings.push(`radio field "${label}" shown as a select`);
		if (btype === "richtext") warnings.push(`rich-text field "${label}" shown as a plain textarea`);
		if (str(f.description)) warnings.push(`field "${label}" has a description (Bricks 2.5) that the form does not show`);
		let name = str(f.name)?.trim() || slug(label) || `field_${str(f.id) ?? fields.length}`;
		while (used.has(name)) name = `${name}_${str(f.id) ?? fields.length}`;
		used.add(name);
		const options = type === "select" || (type === "checkbox" && str(f.options)) ? optionsOf(f) : [];
		const width = Number(f.width);
		const autocomplete = str(f.autocomplete) && str(f.autocomplete) !== "on" && str(f.autocomplete) !== "off" ? str(f.autocomplete) : type === "email" ? "email" : type === "tel" ? "tel" : undefined;
		fields.push({ name, label: label || name, type, ...(f.required === true || f.required === "true" ? { required: true } : {}), ...(str(f.placeholder) ? { placeholder: str(f.placeholder) } : {}), ...(options.length ? { options } : {}), ...(width > 0 && width <= 50 ? { half: true } : {}), ...(autocomplete ? { autocomplete } : {}) });
	}
	// `actions` defaults to ['email'] when the element is created; a stored list without it does something else.
	const actions = Array.isArray(settings.actions) ? (settings.actions as unknown[]).map(String) : ["email"];
	const other = actions.filter((a) => a !== "email");
	if (!actions.includes("email")) warnings.push(`the Bricks form does not send email (actions: ${actions.join(", ") || "none"}); decide what the new form does`);
	if (other.length) warnings.push(`Bricks form actions not rebuilt: ${other.join(", ")}`);
	if (str(settings.emailTo) === "custom") warnings.push("recipient was a custom address in Bricks: set it in the admin (Forms → recipients), it is not copied");
	if (!fields.some((f) => f.type === "email" || f.type === "tel")) warnings.push("no email or phone field to reply to");
	const success = str(settings.successMessage);
	return { id: `bricks-${id}`, title, submitLabel: stripHtml(str(settings.submitButtonText) ?? "") || "Send", successMessage: success ? stripHtml(success) : BRICKS_SUCCESS, fields, warnings };
}
