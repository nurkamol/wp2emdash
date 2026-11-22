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
import { extensionsFrom, megabytes, PAYMENT_FIELD, paymentWarning, showIfFrom, withSteps } from "../extract/form-logic.js";

export interface FormFieldOut {
	name: string;
	label: string;
	type: "text" | "email" | "tel" | "number" | "url" | "date" | "textarea" | "select" | "checkbox" | "radio" | "consent" | "signature" | "content" | "file";
	/** Visible lines of a message box, as the source form set them. */
	rows?: number;
	required?: boolean;
	placeholder?: string;
	options?: string[];
	/** date: a date and a time (Fluent date with time enabled). */
	time?: boolean;
	half?: boolean;
	autocomplete?: string;
	labelParts?: InlinePart[];
	content?: ContentBlock[];
	/** file: allowed extensions (no dot), largest file in MB, how many files. */
	accept?: string[];
	maxMb?: number;
	maxFiles?: number;
	/** Shown only when another field has one of the values (or, with `not`, none of them). */
	showIf?: { field: string; equals: string[]; not?: boolean };
	/** Multi-step forms: the step (0-based). */
	step?: number;
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
	/** Multi-step forms: a title per step (fields carry `step`). */
	steps?: { title: string }[];
	warnings: string[];
	/** What the WordPress form did that the rebuilt form does not (payments, complex conditions…): reported, not blocking. */
	notes?: string[];
	/** Fields of the WordPress form left out by the site's sensitive-form policy (reported, never silent). */
	withheld?: string[];
}

/** Contact details: email, phone, and name fields. Everything else may carry what a sensitive site must not send. */
export function isContactField(f: FormFieldOut): boolean {
	if (f.type === "email" || f.type === "tel") return true;
	return f.type === "text" && (/(^|[-_])name($|[-_])|^names?$/i.test(f.name) || /name/.test(f.autocomplete ?? ""));
}

/**
 * File upload fields under the site's upload policy (kit.config forms.uploads): left out when uploads are off, or on a
 * sensitiveData site unless the owner allowed them; otherwise given the site's size limit when the source set none.
 */
export function applyUploadPolicy(def: FormDefinitionOut, uploads: false | { maxMb: number; sensitive: boolean }, sensitiveData: boolean): FormDefinitionOut {
	const files = def.fields.filter((f) => f.type === "file");
	if (!files.length) return def;
	const off = uploads === false ? "forms.uploads is false" : sensitiveData && !uploads.sensitive ? "sensitiveData site: file uploads are off unless forms.uploads.sensitive (owner decision)" : undefined;
	if (off) return { ...def, fields: def.fields.filter((f) => f.type !== "file"), withheld: [...(def.withheld ?? []), ...files.map((f) => `${f.label || f.name} (file upload: ${off})`)] };
	return { ...def, fields: def.fields.map((f) => (f.type === "file" && !f.maxMb && uploads ? { ...f, maxMb: uploads.maxMb } : f)) };
}

/** Apply a sensitive site's form policy to a definition. File fields the owner allowed (applyUploadPolicy) stay. */
export function applySensitivePolicy(def: FormDefinitionOut, policy: "contact-only" | "contact-and-message" | undefined, notice: string): FormDefinitionOut {
	if (!def.sensitive) return def;
	if (!policy) return { ...def, warnings: [...def.warnings, "site has sensitiveData: set forms.sensitive in kit.config (owner decision) before this form can be rebuilt"] };
	// contact-and-message keeps the first free-text box too (the notice above it asks for no health details).
	const message = policy === "contact-and-message" ? def.fields.find((f) => f.type === "textarea") : undefined;
	const kept = (f: FormFieldOut) => isContactField(f) || f === message || f.type === "file";
	const keep = def.fields.filter(kept);
	const withheld = def.fields.filter((f) => !kept(f)).map((f) => f.label || f.name);
	if (!keep.some((f) => f.type === "email" || f.type === "tel")) return { ...def, warnings: [...def.warnings, "contact-only policy leaves no email or phone field to reply to"] };
	return { ...def, fields: keep, notice, ...(withheld.length || def.withheld?.length ? { withheld: [...(def.withheld ?? []), ...withheld] } : {}) };
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
	input_file: "file",
	input_image: "file",
};
const AUTOCOMPLETE: Record<string, string> = { first_name: "given-name", last_name: "family-name", middle_name: "additional-name", email: "email", phone: "tel" };

export function fluentFormToDefinition(raw: { id: string; title: string; form: { form_fields?: Obj }; settings?: Obj }, sensitive: boolean): FormDefinitionOut {
	const warnings: string[] = [];
	const notes: string[] = [];
	const fields: FormFieldOut[] = [];
	// Conditional logic is resolved once every field is known (rules name fields by their `name` attribute).
	const rules: { field: FormFieldOut; logic: Obj }[] = [];
	const optionLabels = new Map<string, Map<string, string>>();
	let customSubmit: string | undefined;
	let step = 0;
	const visit = (f: Obj, half: boolean) => {
		const el = str(f.element) ?? "";
		const s = o(f.settings);
		const a = o(f.attributes);
		// Multi-step forms: a `form_step` element ends a step.
		if (el === "form_step") {
			step++;
			return;
		}
		const before = fields.length;
		visitField(f, el, s, a, half);
		for (const added of fields.slice(before)) {
			if (step) added.step = step;
			const logic = o(s.conditional_logics);
			if (logic.status === true || logic.status === "yes" || logic.status === 1) rules.push({ field: added, logic });
		}
	};
	const visitField = (f: Obj, el: string, s: Obj, a: Obj, half: boolean) => {
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
			if (PAYMENT_FIELD.test(el)) warnings.push(paymentWarning(el, str(s.label) ?? ""));
			else if (!["recaptcha", "hcaptcha", "turnstile", "input_hidden"].includes(el)) warnings.push(`field "${el}" not supported; rebuild by hand`);
			return;
		}
		const name = str(a.name) ?? el;
		if (type === "file") {
			// Fluent upload settings: allowed types under validation_rules.allowed_file_types (or allowed_image_types), max_file_size (MB), max_file_count.
			const vr = o(s.validation_rules);
			const accept = extensionsFrom(o(vr.allowed_file_types).value ?? o(vr.allowed_image_types).value) ?? (el === "input_image" ? ["jpg", "jpeg", "png", "gif", "webp"] : undefined);
			const maxMb = megabytes(o(vr.max_file_size).value ?? o(vr.max_file_size)._valueFrom);
			const maxFiles = Number(o(vr.max_file_count).value) || undefined;
			const required = o(vr.required).value === true;
			fields.push({ name, label: str(s.label) || name, type, ...(required ? { required } : {}), ...(accept ? { accept } : {}), ...(maxMb ? { maxMb } : {}), ...(maxFiles && maxFiles > 1 ? { maxFiles: Math.min(5, maxFiles) } : {}) });
			return;
		}
		const placeholder = type === "signature" ? str(s.sign_instruction) : str(a.placeholder) ?? (type === "select" ? str(s.placeholder) : undefined);
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
		// The rebuilt form submits the option's label; Fluent's rules compare its value — remember value → label.
		if (options?.length) optionLabels.set(name, new Map((s.advanced_options as Obj[]).flatMap((x) => (str(x.value) !== undefined && (str(x.label) ?? str(x.value)) ? [[(str(x.value) as string).trim().toLowerCase(), (str(x.label) ?? str(x.value)) as string]] : []))));
		// Fluent date: `is_time_enabled`, or a format with hours (`m/d/Y h:i K`) → a date and time picker.
		const time = type === "date" && (s.is_time_enabled === true || s.is_time_enabled === "yes" || /[hHgGi]/.test(str(s.date_format) ?? ""));
		fields.push({ name, label, type, ...(required ? { required } : {}), ...(placeholder ? { placeholder } : {}), ...(options?.length ? { options } : {}), ...(time ? { time } : {}), ...(type === "textarea" && Number(a.rows) >= 2 && Number(a.rows) <= 20 ? { rows: Number(a.rows) } : {}), ...(half && type !== "signature" ? { half } : {}), ...(AUTOCOMPLETE[name] ? { autocomplete: AUTOCOMPLETE[name] } : {}) });
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
	// Fluent conditional_logics: { status, type: "any" | "all", conditions: [{ field, operator: "=" | "!=" | …, value }] }.
	// On a choice field (checkbox group, radio, select) "=" means "this option is chosen" — for a checkbox group, ticked
	// among others — which is what showIf's equals does with the submitted values (packages/forms/src/logic.ts), so
	// "any" over several options of one group is "one of [A, B, …]". Fluent's contains / doNotContains on a choice field
	// test the same membership. Rule values are mapped to the option labels the rebuilt form submits. A name part is
	// referenced as names[first_name]; the rebuilt form has it as first_name.
	const byName = new Map(fields.map((f) => [f.name, f]));
	const resolve = (ref: string) => {
		const part = /^[\w-]+\[([\w-]+)\]$/.exec(ref)?.[1];
		return byName.has(ref) ? ref : part && byName.has(part) ? part : undefined;
	};
	for (const { field, logic } of rules) {
		const conditions = (Array.isArray(logic.conditions) ? logic.conditions : []).map((c) => o(c)).filter((c) => str(c.field));
		// A rule on the field itself would hide it for good (it can never be filled in while hidden): reported instead.
		if (conditions.some((c) => resolve(str(c.field) as string) === field.name)) {
			notes.push(`“${field.label}”: conditional logic not carried (it depends on the field itself); the field is always shown`);
			continue;
		}
		const r = showIfFrom(
			field.label,
			conditions.map((c) => {
				const ctl = resolve(str(c.field) as string);
				const choice = ctl ? byName.get(ctl)?.options?.length : false;
				const raw = str(c.operator) ?? "=";
				const op = choice && /^contains$/i.test(raw) ? "=" : choice && /^(doNotContains|not_contains|notContains)$/i.test(raw) ? "!=" : raw;
				const value = str(c.value) ?? String(c.value ?? "");
				return { field: ctl, op, value: (ctl && optionLabels.get(ctl)?.get(value.trim().toLowerCase())) ?? value };
			}),
			str(logic.type) === "all" ? "all" : "any",
		);
		if (r.showIf) field.showIf = r.showIf;
		if (r.note) notes.push(r.note);
	}
	const stepTitles = (Array.isArray(o(o(o(ff.stepsWrapper).stepStart).settings).step_titles) ? (o(o(o(ff.stepsWrapper).stepStart).settings).step_titles as unknown[]) : []).map((t) => str(t) ?? "");
	const stepped = withSteps(fields, stepTitles);
	return { id: `fluent-forms-${raw.id}`, title: raw.title, submitLabel, successMessage: success ? stripHtml(success) : "Thank you — we will be in touch.", fields: stepped.fields, ...(stepped.steps ? { steps: stepped.steps } : {}), ...(signed ? { notice: SIGNATURE_NOTICE } : {}), ...(afterSubmit ? { afterSubmit } : {}), ...(sensitive ? { sensitive: true } : {}), warnings, ...(notes.length ? { notes } : {}) };
}
