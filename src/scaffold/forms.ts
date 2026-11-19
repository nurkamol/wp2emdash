/**
 * WordPress form plugin definitions → the starter's form JSON (src/forms/<provider>-<id>.json).
 * Field names, labels, required flags, options and the success message are kept; notification
 * recipients are not copied into the project (they become Worker secrets/config in M6).
 *
 * Field types match @wp2emdash/forms (packages/forms/src/types.ts): radio choices, consent checkboxes whose label keeps
 * its safe links (`labelParts`), signatures (drawn or typed), and `content` — text the form shows between fields
 * (Fluent `custom_html`, `section_break`), sanitised to paragraphs, lists, headings, bold/italic and safe links.
 */
import { type ContentBlock, htmlToContent, htmlToParts, type InlinePart } from "../../packages/forms/src/rich.js";

export interface FormFieldOut {
	name: string;
	label: string;
	type: "text" | "email" | "tel" | "number" | "url" | "date" | "textarea" | "select" | "checkbox" | "radio" | "consent" | "signature" | "content";
	/** Visible lines of a message box, as the source form set them. */
	rows?: number;
	required?: boolean;
	placeholder?: string;
	options?: string[];
	half?: boolean;
	autocomplete?: string;
	labelParts?: InlinePart[];
	content?: ContentBlock[];
}

/** Shown above the submit button of a form with a signature field (unless the form has its own notice). */
export const SIGNATURE_NOTICE = "When you submit this form, your answers and your signature are emailed to us as your signed copy, with the date and time and the terms shown above.";
export interface FormDefinitionOut {
	id: string;
	title: string;
	submitLabel: string;
	successMessage: string;
	fields: FormFieldOut[];
	sensitive?: boolean;
	notice?: string;
	/** After a successful send: hide the form and show the message (Fluent "Hide Form"), or reset it. */
	afterSubmit?: "hide" | "reset";
	warnings: string[];
	/** Fields of the WordPress form left out by the site's sensitive-form policy (reported, never silent). */
	withheld?: string[];
}

/** Contact details: email, phone, and name fields. Everything else may carry what a sensitive site must not send. */
export function isContactField(f: FormFieldOut): boolean {
	if (f.type === "email" || f.type === "tel") return true;
	return f.type === "text" && (/(^|[-_])name($|[-_])|^names?$/i.test(f.name) || /name/.test(f.autocomplete ?? ""));
}

/** Apply a sensitive site's form policy to a definition. */
export function applySensitivePolicy(def: FormDefinitionOut, policy: "contact-only" | "contact-and-message" | undefined, notice: string): FormDefinitionOut {
	if (!def.sensitive) return def;
	if (!policy) return { ...def, warnings: [...def.warnings, "site has sensitiveData: set forms.sensitive in kit.config (owner decision) before this form can be rebuilt"] };
	// contact-and-message keeps the first free-text box too (the notice above it asks for no health details).
	const message = policy === "contact-and-message" ? def.fields.find((f) => f.type === "textarea") : undefined;
	const kept = (f: FormFieldOut) => isContactField(f) || f === message;
	const keep = def.fields.filter(kept);
	const withheld = def.fields.filter((f) => !kept(f)).map((f) => f.label || f.name);
	if (!keep.some((f) => f.type === "email" || f.type === "tel")) return { ...def, warnings: [...def.warnings, "contact-only policy leaves no email or phone field to reply to"] };
	return { ...def, fields: keep, notice, ...(withheld.length ? { withheld } : {}) };
}

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const TYPE: Record<string, FormFieldOut["type"]> = {
	input_text: "text",
	input_email: "email",
	phone: "tel",
	input_phone: "tel",
	input_number: "number",
	input_url: "url",
	input_date: "date",
	textarea: "textarea",
	select: "select",
	input_radio: "radio",
	input_checkbox: "checkbox",
	gdpr_agreement: "consent",
	terms_and_condition: "consent",
	// The "Fluent Forms Signature Addon" (fluentform-signature) element.
	signature: "signature",
};
const AUTOCOMPLETE: Record<string, string> = { first_name: "given-name", last_name: "family-name", middle_name: "additional-name", email: "email", phone: "tel" };

export function fluentFormToDefinition(raw: { id: string; title: string; form: { form_fields?: Obj }; settings?: Obj }, sensitive: boolean): FormDefinitionOut {
	const warnings: string[] = [];
	const fields: FormFieldOut[] = [];
	let customSubmit: string | undefined;
	const visit = (f: Obj, half: boolean) => {
		const el = str(f.element) ?? "";
		const s = o(f.settings);
		const a = o(f.attributes);
		if (el === "container") {
			const cols = Array.isArray(f.columns) ? (f.columns as Obj[]) : [];
			for (const c of cols) for (const x of (Array.isArray(c.fields) ? c.fields : []) as Obj[]) visit(x, cols.length > 1);
			return;
		}
		if (el === "input_name") {
			for (const sub of Object.values(o(f.fields)) as Obj[]) {
				const ss = o(sub.settings);
				if (ss.visible === false) continue;
				visit({ ...sub, element: "input_text" }, half);
			}
			return;
		}
		if (el === "custom_submit_button") {
			customSubmit = str(o(s.button_ui).text) ?? str(s.btn_text) ?? customSubmit;
			return;
		}
		// Text the form shows between fields (a waiver's terms, a section heading): kept, sanitised, in field order.
		if (el === "custom_html" || el === "section_break") {
			const blocks = el === "custom_html" ? htmlToContent(str(s.html_codes) ?? "") : [...(str(s.label)?.trim() ? [{ kind: "h" as const, parts: htmlToParts(str(s.label) as string) }] : []), ...htmlToContent(str(s.description) ?? ""), { kind: "hr" as const }];
			const content = blocks.filter((b) => b.kind === "hr" || b.parts?.length);
			if (content.some((b) => b.kind !== "hr")) fields.push({ name: `content-${++contentCount}`, label: el === "section_break" ? (str(s.label) ?? "Section") : "Text", type: "content", content });
			return;
		}
		const type = TYPE[el];
		if (!type) {
			if (!["recaptcha", "hcaptcha", "turnstile", "input_hidden"].includes(el)) warnings.push(`field "${el}" not supported; rebuild by hand`);
			return;
		}
		const name = str(a.name) ?? el;
		const placeholder = type === "signature" ? str(s.sign_instruction) : str(a.placeholder);
		const required = o(o(s.validation_rules).required).value === true || el === "gdpr_agreement";
		if (type === "consent") {
			// Fluent keeps the checkbox text as HTML (tnc_html, with links to the terms): runs + safe links only.
			const labelParts = htmlToParts(str(s.tnc_html) ?? str(s.label) ?? "");
			const label = str(s.admin_field_label)?.trim() || (el === "gdpr_agreement" ? "GDPR Agreement" : "Terms and Conditions");
			fields.push({ name, label, type, ...(required ? { required } : {}), ...(labelParts.length ? { labelParts } : {}) });
			if (!labelParts.length) warnings.push(`consent field "${name}" has no text; write it by hand`);
			return;
		}
		const label = str(s.label) || (placeholder ?? name).replace(/\*\s*$/, "").trim();
		const options = Array.isArray(s.advanced_options) ? (s.advanced_options as Obj[]).map((x) => str(x.label) ?? str(x.value) ?? "").filter(Boolean) : undefined;
		fields.push({ name, label, type, ...(required ? { required } : {}), ...(placeholder ? { placeholder } : {}), ...(options?.length ? { options } : {}), ...(type === "textarea" && Number(a.rows) >= 2 && Number(a.rows) <= 20 ? { rows: Number(a.rows) } : {}), ...(half && type !== "signature" ? { half } : {}), ...(AUTOCOMPLETE[name] ? { autocomplete: AUTOCOMPLETE[name] } : {}) });
	};
	let contentCount = 0;
	const ff = o(raw.form.form_fields);
	for (const f of (Array.isArray(ff.fields) ? ff.fields : []) as Obj[]) visit(f, false);
	const submitLabel = customSubmit ?? str(o(o(o(ff.submitButton).settings).button_ui).text) ?? "Send";
	const fs = (Array.isArray(o(raw.settings).formSettings) ? (o(raw.settings).formSettings as Obj[]) : [])[0];
	const confirmation = o(o(o(fs).value).confirmation);
	const success = str(confirmation.messageToShow);
	const afterSubmit = str(confirmation.samePageFormBehavior) === "hide_form" ? "hide" : str(confirmation.samePageFormBehavior) === "reset_form" ? "reset" : undefined;
	const signed = fields.some((f) => f.type === "signature");
	return { id: `fluent-forms-${raw.id}`, title: raw.title, submitLabel, successMessage: success ? stripHtml(success) : "Thank you — we will be in touch.", fields, ...(signed ? { notice: SIGNATURE_NOTICE } : {}), ...(afterSubmit ? { afterSubmit } : {}), ...(sensitive ? { sensitive: true } : {}), warnings };
}
