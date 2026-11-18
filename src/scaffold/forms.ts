/**
 * WordPress form plugin definitions → the starter's form JSON (src/forms/<provider>-<id>.json).
 * Field names, labels, required flags, options and the success message are kept; notification
 * recipients are not copied into the project (they become Worker secrets/config in M6).
 */
export interface FormFieldOut {
	name: string;
	label: string;
	type: "text" | "email" | "tel" | "number" | "url" | "date" | "textarea" | "select" | "checkbox";
	required?: boolean;
	placeholder?: string;
	options?: string[];
	half?: boolean;
	autocomplete?: string;
}
export interface FormDefinitionOut {
	id: string;
	title: string;
	submitLabel: string;
	successMessage: string;
	fields: FormFieldOut[];
	sensitive?: boolean;
	notice?: string;
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
export function applySensitivePolicy(def: FormDefinitionOut, policy: "contact-only" | undefined, notice: string): FormDefinitionOut {
	if (!def.sensitive) return def;
	if (!policy) return { ...def, warnings: [...def.warnings, "site has sensitiveData: set forms.sensitive in kit.config (owner decision) before this form can be rebuilt"] };
	const keep = def.fields.filter(isContactField);
	const withheld = def.fields.filter((f) => !isContactField(f)).map((f) => f.label || f.name);
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
	input_checkbox: "checkbox",
	gdpr_agreement: "checkbox",
	terms_and_condition: "checkbox",
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
		const type = TYPE[el];
		if (!type) {
			if (!["custom_html", "section_break", "recaptcha", "hcaptcha", "turnstile", "input_hidden"].includes(el)) warnings.push(`field "${el}" not supported; rebuild by hand`);
			return;
		}
		const name = str(a.name) ?? el;
		const placeholder = str(a.placeholder);
		const label = str(s.label) || (placeholder ?? name).replace(/\*\s*$/, "").trim();
		const required = o(o(s.validation_rules).required).value === true;
		const options = Array.isArray(s.advanced_options) ? (s.advanced_options as Obj[]).map((x) => str(x.label) ?? str(x.value) ?? "").filter(Boolean) : undefined;
		fields.push({ name, label, type, ...(required ? { required } : {}), ...(placeholder ? { placeholder } : {}), ...(options?.length ? { options } : {}), ...(half ? { half } : {}), ...(AUTOCOMPLETE[name] ? { autocomplete: AUTOCOMPLETE[name] } : {}) });
	};
	const ff = o(raw.form.form_fields);
	for (const f of (Array.isArray(ff.fields) ? ff.fields : []) as Obj[]) visit(f, false);
	const submitLabel = customSubmit ?? str(o(o(o(ff.submitButton).settings).button_ui).text) ?? "Send";
	const fs = (Array.isArray(o(raw.settings).formSettings) ? (o(raw.settings).formSettings as Obj[]) : [])[0];
	const success = str(o(o(o(fs).value).confirmation).messageToShow);
	return { id: `fluent-forms-${raw.id}`, title: raw.title, submitLabel, successMessage: success ? stripHtml(success) : "Thank you — we will be in touch.", fields, ...(sensitive ? { sensitive: true } : {}), warnings };
}
