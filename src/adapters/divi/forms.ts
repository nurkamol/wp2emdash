/**
 * Divi Contact Form module (`[et_pb_contact_form][et_pb_contact_field …][/et_pb_contact_form]`) → the starter's form
 * definition (src/scaffold/forms.ts), like the Elementor and Bricks forms.
 * Kept: fields (`field_id`, `field_title`, `field_type` input/email/text/checkbox/radio/select, `required_mark`,
 * `fullwidth_field`, `*_options` JSON), the submit text (`submit_button_text`), the success message (`success_message`).
 * Never copied: the recipient (`email`), redirects, spam-service keys. The captcha (`captcha`, on by default) is
 * replaced by the starter's Turnstile. Conditional logic becomes a warning.
 */
import type { FormDefinitionOut, FormFieldOut } from "../../scaffold/forms.js";
import type { ShortcodeNode } from "../wpbakery/parser.js";
import { decodeAttrJson } from "./site.js";

const TYPE: Record<string, FormFieldOut["type"]> = { input: "text", email: "email", text: "textarea", checkbox: "checkbox", radio: "radio", select: "select" };
/** Divi's default success message. */
export const DIVI_SUCCESS = "Thanks for contacting us";

const slug = (s: string) =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[^\w\s-]/g, "")
		.trim()
		.replace(/[\s-]+/g, "_")
		.slice(0, 40);
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** `checkbox_options="%91{%22value%22:%22Yes%22,%22checked%22:0}%93"` → the option labels. */
export function diviOptions(v: string | undefined): string[] {
	if (!v?.trim()) return [];
	try {
		const list = JSON.parse(decodeAttrJson(v)) as unknown[];
		return list.map((o) => (o && typeof o === "object" ? String((o as { value?: unknown }).value ?? "") : String(o)).trim()).filter(Boolean);
	} catch {
		return [];
	}
}

export function diviFormToDefinition(id: string, form: ShortcodeNode, title: string): FormDefinitionOut {
	const a = form.attrs;
	const warnings: string[] = [];
	const fields: FormFieldOut[] = [];
	const used = new Set<string>();
	const raw = form.children.filter((c): c is ShortcodeNode => c.type === "shortcode" && c.tag === "et_pb_contact_field");
	for (const f of raw) {
		const fa = f.attrs;
		const dtype = fa.field_type ?? "input";
		const label = stripHtml(fa.field_title ?? "") || fa.field_id || "";
		const type = TYPE[dtype];
		if (!type) {
			warnings.push(`field "${label || dtype}" (${dtype}) not supported; rebuild by hand`);
			continue;
		}
		let name = slug(fa.field_id ?? "") || slug(label) || `field_${fields.length}`;
		while (used.has(name)) name = `${name}_${fields.length}`;
		used.add(name);
		const options = type === "select" || type === "radio" || type === "checkbox" ? diviOptions(fa[`${dtype}_options`]) : [];
		// Divi marks fields required unless required_mark="off"; fields are half width unless fullwidth_field="on".
		const required = (fa.required_mark ?? "on") !== "off";
		const half = fa.fullwidth_field !== "on" && type !== "textarea";
		const autocomplete = type === "email" ? "email" : /name/i.test(name) ? "name" : undefined;
		if (fa.conditional_logic === "on") warnings.push(`field "${label}" is shown conditionally in Divi; it is always shown`);
		fields.push({ name, label: label || name, type, ...(required ? { required: true } : {}), ...(options.length ? { options } : {}), ...(half ? { half: true } : {}), ...(autocomplete ? { autocomplete } : {}) });
	}
	if (a.email?.trim()) warnings.push("recipient set in Divi: set it in the admin (Forms → recipients), it is not copied");
	if (a.use_redirect === "on") warnings.push(`Divi redirects after sending${a.redirect_url ? ` to ${a.redirect_url}` : ""}; the new form shows its message instead`);
	if (a.custom_message?.trim()) warnings.push("custom email body set in Divi; the starter's notification lists every field");
	if (!fields.some((f) => f.type === "email")) warnings.push("no email field to reply to");
	const success = stripHtml(a.success_message ?? "");
	return { id: `divi-${id}`, title: stripHtml(a.title ?? "") || title, submitLabel: stripHtml(a.submit_button_text ?? "") || "Submit", successMessage: success || DIVI_SUCCESS, fields, warnings };
}
