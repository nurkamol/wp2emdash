/**
 * Plugin data the WordPress REST API does not expose (or only to some plugins): the owner exports it from the plugin's
 * own Import/Export screen, the operator drops the files into `sites/<slug>/raw/plugin-exports/` (any name), and
 * extract recognises each file by its content and turns it into the kit's shapes:
 *
 * - forms → `raw/forms/<provider>/<id>.json` (`definition` = the starter's form shape; Fluent keeps its own raw shape)
 * - redirects → `raw/redirects.json` (EmDash redirect rules) plus the rules EmDash cannot hold, reported, never dropped
 *
 * Formats follow each plugin's documented export (Gravity Forms JSON, WPForms JSON, Contact Form 7 via WordPress
 * Tools → Export, Fluent Forms JSON, Ninja Forms .nff, Formidable XML, WS Form JSON, Forminator JSON, Redirection JSON,
 * Rank Math .htaccess/Nginx, Yoast CSV). The parsers read the data shapes only (no plugin code). Fixtures are synthetic:
 * check a parser against the first real file a client sends and add that case to the fixtures.
 *
 * Every form parser maps fields, file uploads (type "file" with the plugin's size/type limits), simple conditional logic
 * (`showIf`, form-logic.ts) and page breaks (steps); payment fields become a blocking warning (out of scope); logic the
 * rebuilt form cannot express is reported in `notes`. Recipients are counted, never copied into the project.
 */
import { isAcfExport, isMetaBoxExport, isPodsExport } from "../transform/cpt-fields.js";
import type { FormDefinitionOut, FormFieldOut } from "../scaffold/forms.js";
import { extensionsFrom, fileField, megabytes, PAYMENT_FIELD, paymentWarning, showIfFrom, type SourceRule, withSteps } from "./form-logic.js";

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Obj) : []);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const slugName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "field";
const AUTOCOMPLETE: Record<string, string> = { first_name: "given-name", last_name: "family-name", name: "name", full_name: "name", email: "email", phone: "tel", your_name: "name", your_email: "email", your_phone: "tel" };

// ── What to ask the owner for ────────────────────────────────────────────────────────────────────────────────────

export interface PluginExportSpec {
	id: string;
	name: string;
	kind: "forms" | "redirects" | "fields";
	/** Matched against the audit's plugin names and form providers. */
	match: RegExp;
	/** Extract already reads this plugin over REST when the app password is set: the file is only a fallback. */
	automatic?: boolean;
	steps: string;
}

export const PLUGIN_EXPORTS: PluginExportSpec[] = [
	{ id: "fluent-forms", name: "Fluent Forms", kind: "forms", match: /fluent[- ]?forms?/i, automatic: true, steps: "Fluent Forms → Tools → Export Forms → select all forms → Export Forms (.json)" },
	{ id: "gravity-forms", name: "Gravity Forms", kind: "forms", match: /gravity[- ]?forms?|gravityforms/i, steps: "Forms → Import/Export → Export Forms → select all → Download Export File (.json)" },
	{ id: "wpforms", name: "WPForms", kind: "forms", match: /wpforms/i, steps: "WPForms → Tools → Export → Form Exports → select all forms → Export (.json)" },
	{ id: "contact-form-7", name: "Contact Form 7", kind: "forms", match: /contact[- ]?form[- ]?7|wpcf7/i, steps: "Tools → Export → choose “Contact Forms” → Download Export File (.xml)" },
	{ id: "ninja-forms", name: "Ninja Forms", kind: "forms", match: /ninja[- ]?forms?/i, steps: "Ninja Forms → Import/Export → Export Forms → each form (.nff); name each file after its form id, e.g. ninja-form-3.nff" },
	{ id: "formidable", name: "Formidable Forms", kind: "forms", match: /formidable/i, steps: "Formidable → Import/Export → Export → select the forms, format XML → Export (.xml)" },
	{ id: "ws-form", name: "WS Form", kind: "forms", match: /ws[- ]?form/i, steps: "WS Form → Forms → hover each form → Export (.json)" },
	{ id: "forminator", name: "Forminator", kind: "forms", match: /forminator/i, steps: "Forminator → Forms → each form's gear menu → Export → Download (.txt/.json); name each file after its form id, e.g. forminator-12.json" },
	{ id: "redirection", name: "Redirection", kind: "redirects", match: /^redirection$|redirection plugin|\bredirection\/v1/i, steps: "Tools → Redirection → Import/Export → Export: “Everything”, format “JSON” → Download" },
	{ id: "rank-math-redirects", name: "Rank Math redirections", kind: "redirects", match: /rank[- ]?math/i, steps: "Rank Math → Redirections → Export → “Apache (.htaccess)” (or Nginx) — only if the Redirections module is on" },
	{ id: "acf-field-groups", name: "Advanced Custom Fields field groups", kind: "fields", match: /advanced[- ]custom[- ]fields|^acf\b|\bacf pro\b/i, automatic: true, steps: "Custom Fields → Tools → Export Field Groups → select all → Export As JSON (gives the custom post type mapper repeater sub-fields, choices and relationship targets)" },
	{ id: "meta-box", name: "Meta Box field groups", kind: "fields", match: /meta[- ]?box/i, steps: "Meta Box → Custom Fields → select all field groups → Bulk actions: Export (.json)" },
	{ id: "pods", name: "Pods", kind: "fields", match: /^pods\b|pods framework/i, steps: "Pods Admin → Components → turn on Migrate: Packages → Pods Admin → Migrate: Packages → Export → select all → Export (.json)" },
	{ id: "yoast-redirects", name: "Yoast SEO Premium redirects", kind: "redirects", match: /yoast/i, steps: "Yoast SEO → Redirects → Import/Export → Export redirects (.csv) — Premium only" },
];

/** Which exports to ask for, from the plugins and form providers the audit found. */
export function exportsFor(signals: string[]): PluginExportSpec[] {
	return PLUGIN_EXPORTS.filter((s) => signals.some((x) => s.match.test(x)));
}

const MARK_START = "<!-- wp2emdash:plugin-exports -->";
const MARK_END = "<!-- /wp2emdash:plugin-exports -->";

/** The ACCESS.md section (kept between markers so audit can rewrite it; ticks the owner made are kept). */
export function accessSection(specs: PluginExportSpec[], slug: string, previous = ""): string {
	const ticked = new Set([...previous.matchAll(/^- \[x\] (?:\(required\) )?\*\*([^*]+)\*\*/gim)].map((m) => m[1]));
	const lines = specs.map((s) => {
		const required = !s.automatic && s.kind === "forms";
		const tick = ticked.has(s.name) ? "x" : " ";
		const note = s.automatic ? " (read automatically over REST with the app password; the file is a fallback)" : s.kind === "redirects" ? " (or, if there are none, set `redirects: { source: \"none\" }` in overrides.ts)" : "";
		return `- [${tick}] ${required ? "(required) " : ""}**${s.name}**: ${s.steps}${note}`;
	});
	return `${MARK_START}
## Plugin data (before extract)

The REST API does not expose these plugins' settings. Export each one from WordPress admin and put the files in
\`sites/${slug}/raw/plugin-exports/\` (any file name; extract recognises the format). Never put form *entries*
(submissions) here: only the form definitions and redirect rules.

${lines.length ? lines.join("\n") : "- Nothing to export: no form or redirect plugin was detected."}
${MARK_END}`;
}

/** Replace (or append) the generated section in an ACCESS.md text. */
export function withAccessSection(access: string, section: string): string {
	const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
	return re.test(access) ? access.replace(re, section) : `${access.trimEnd()}\n\n${section}\n`;
}
export const previousSection = (access: string): string => new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`).exec(access)?.[0] ?? "";

// ── Forms ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImportedForm {
	provider: string;
	id: string;
	title: string;
	status: "publish" | "draft";
	/** Fluent Forms keeps its REST shape (scaffold's own converter reads it); the others carry the definition. */
	raw?: Obj;
	definition?: Omit<FormDefinitionOut, "sensitive"> & { sensitive?: boolean };
	/** Number of notification recipients configured in WordPress (the addresses stay in raw/, never in the project). */
	recipients?: string[];
	/** Other ids the same form is embedded with (Contact Form 7 5.8+ shortcodes use a short hash). */
	aliases?: string[];
}

const field = (name: string, label: string, type: FormFieldOut["type"], extra: Partial<FormFieldOut> = {}): FormFieldOut => {
	const ac = AUTOCOMPLETE[name] ?? (type === "email" ? "email" : type === "tel" ? "tel" : undefined);
	return { name, label: label || name, type, ...extra, ...(ac && !extra.autocomplete ? { autocomplete: ac } : {}) };
};
const def = (id: string, title: string, fields: FormFieldOut[], submitLabel: string | undefined, success: string | undefined, warnings: string[], extra: { notes?: string[]; stepTitles?: string[] } = {}): ImportedForm["definition"] => {
	const stepped = withSteps(fields, extra.stepTitles ?? []);
	return {
		id,
		title,
		submitLabel: submitLabel?.trim() || "Send",
		successMessage: success ? stripHtml(success) : "Thank you — we will be in touch.",
		fields: stepped.fields,
		...(stepped.steps ? { steps: stepped.steps } : {}),
		warnings,
		...(extra.notes?.length ? { notes: extra.notes } : {}),
	};
};
/** Resolve rules once all fields exist: `byId` maps the plugin's field id (or key) to the rebuilt field name. */
const applyRules = (pending: { field: FormFieldOut; rules: { id: string; op: string; value: string }[]; match: "any" | "all"; action: "show" | "hide" }[], byId: Map<string, string>, notes: string[]) => {
	for (const p of pending) {
		const r = showIfFrom(p.field.label, p.rules.map((x): SourceRule => ({ field: byId.get(x.id), op: x.op, value: x.value })), p.match, p.action);
		if (r.showIf) p.field.showIf = r.showIf;
		if (r.note) notes.push(r.note);
	}
};
const emails = (s: string | undefined) => [...new Set((s ?? "").split(/[\s,;]+/).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];

/** Gravity Forms export: `{ "0": form, "1": form, …, "version": "2.x" }` (older exports: an array). */
export function parseGravityForms(json: unknown): ImportedForm[] {
	const forms = (Array.isArray(json) ? json : Object.entries(o(json)).filter(([k]) => /^\d+$/.test(k)).map(([, v]) => v)).map(o).filter((f) => Array.isArray(f.fields));
	const TYPE: Record<string, FormFieldOut["type"]> = { text: "text", name: "text", email: "email", phone: "tel", number: "number", website: "url", date: "date", textarea: "textarea", select: "select", radio: "select", checkbox: "checkbox", consent: "checkbox", multiselect: "select" };
	const PAYMENT = new Set(["product", "total", "creditcard", "shipping", "option", "quantity", "donation", "calculation", "stripe_creditcard", "paypal", "square", "singleproduct", "singleshipping"]);
	return forms.map((f, i) => {
		const id = str(f.id) ?? String(i + 1);
		const warnings: string[] = [];
		const notes: string[] = [];
		const fields: FormFieldOut[] = [];
		const byId = new Map<string, string>();
		const pending: Parameters<typeof applyRules>[0] = [];
		let step = 0;
		for (const x of (f.fields as unknown[]).map(o)) {
			const t = str(x.type) ?? "";
			const label = stripHtml(str(x.label) ?? "");
			const required = truthy(x.isRequired);
			const before = fields.length;
			const logic = o(x.conditionalLogic);
			if (t === "page") {
				step++;
				continue;
			}
			if (PAYMENT.has(t) || PAYMENT.has(str(x.inputType) ?? "")) {
				warnings.push(paymentWarning(t, label));
				continue;
			}
			if (t === "name" && Array.isArray(x.inputs)) {
				for (const sub of (x.inputs as unknown[]).map(o)) {
					if (truthy(sub.isHidden)) continue;
					const l = stripHtml(str(sub.customLabel) || str(sub.label) || "");
					const n = /first/i.test(l) ? "first_name" : /last/i.test(l) ? "last_name" : slugName(l);
					fields.push(field(n, l, "text", { ...(required ? { required } : {}), half: true }));
				}
			} else if (t === "fileupload") {
				const name = slugName(str(x.adminLabel) || label || `file_${str(x.id)}`);
				const max = Number(x.maxFiles);
				fields.push(fileField(name, label, { required, accept: extensionsFrom(x.allowedExtensions), maxMb: megabytes(x.maxFileSize), maxFiles: truthy(x.multipleFiles) ? (max > 0 ? max : 5) : 1 }));
			} else {
				const type = TYPE[t];
				if (!type) {
					if (!["html", "section", "captcha", "hidden"].includes(t)) warnings.push(`field "${t}" (${label || "no label"}) not supported; rebuild by hand`);
					continue;
				}
				const name = slugName(str(x.adminLabel) || (t === "email" ? "email" : t === "phone" ? "phone" : label) || `${t}_${str(x.id)}`);
				const options = t === "consent" ? undefined : arr(x.choices).map((c) => str(o(c).text) ?? "").filter(Boolean);
				const placeholder = str(x.placeholder);
				fields.push(field(name, t === "consent" ? stripHtml(str(x.checkboxLabel) ?? label) : label, type, { ...(required ? { required } : {}), ...(placeholder ? { placeholder } : {}), ...(options?.length ? { options } : {}) }));
			}
			for (const added of fields.slice(before)) {
				if (step) added.step = step;
				byId.set(str(x.id) ?? "", added.name);
			}
			const rules = arr(logic.rules).map(o);
			if (rules.length) for (const added of fields.slice(before)) pending.push({ field: added, rules: rules.map((r) => ({ id: (str(r.fieldId) ?? "").split(".")[0] ?? "", op: str(r.operator) ?? "is", value: str(r.value) ?? "" })), match: str(logic.logicType) === "all" ? "all" : "any", action: str(logic.actionType) === "hide" ? "hide" : "show" });
		}
		applyRules(pending, byId, notes);
		const confirmation = arr(f.confirmations).map(o).find((c) => truthy(c.isDefault)) ?? arr(f.confirmations).map(o)[0];
		if (confirmation && str(confirmation.type) && confirmation.type !== "message") warnings.push(`confirmation is a ${str(confirmation.type)} (redirect/page): rebuilt as a message`);
		const recipients = arr(f.notifications).map(o).filter((n) => !n.isActive || truthy(n.isActive)).flatMap((n) => emails(str(n.to)));
		const title = str(f.title) ?? `Form ${id}`;
		const stepTitles = arr(o(f.pagination).pages).map((p) => str(p) ?? "");
		return { provider: "gravity-forms", id, title, status: f.is_active === undefined || truthy(f.is_active) ? "publish" : "draft", definition: def(`gravity-forms-${id}`, title, fields, str(o(f.button).text), str(confirmation?.message), warnings, { notes, stepTitles }), recipients };
	});
}

/** WPForms export: an array of forms (`fields` keyed by field id, `settings`). */
export function parseWpForms(json: unknown): ImportedForm[] {
	const TYPE: Record<string, FormFieldOut["type"]> = { text: "text", name: "text", email: "email", phone: "tel", number: "number", "number-slider": "number", url: "url", "date-time": "date", textarea: "textarea", select: "select", radio: "select", checkbox: "checkbox", gdpr: "checkbox", "gdpr-checkbox": "checkbox" };
	return arr(json)
		.map(o)
		.filter((f) => f.fields && f.settings)
		.map((f, i) => {
			const id = str(f.id) ?? String(i + 1);
			const s = o(f.settings);
			const warnings: string[] = [];
			const notes: string[] = [];
			const fields: FormFieldOut[] = [];
			const byId = new Map<string, string>();
			const pending: Parameters<typeof applyRules>[0] = [];
			const stepTitles: string[] = [];
			let step = 0;
			for (const x of arr(f.fields).map(o)) {
				const t = str(x.type) ?? "";
				const label = stripHtml(str(x.label) ?? "");
				const required = truthy(x.required);
				const before = fields.length;
				if (t === "pagebreak") {
					// position "top" carries the first step's title; "bottom" closes the last; a normal break starts a step.
					const pos = str(x.position) ?? "";
					if (pos === "top") stepTitles[0] = str(x.title) ?? "";
					else if (pos !== "bottom") stepTitles[++step] = str(x.title) ?? "";
					continue;
				}
				if (/^payment-|^stripe-|^paypal|^square|^authorize/.test(t)) {
					warnings.push(paymentWarning(t, label));
					continue;
				}
				if (t === "name" && /first/.test(str(x.format) ?? "")) {
					fields.push(field("first_name", "First name", "text", { ...(required ? { required } : {}), half: true }));
					fields.push(field("last_name", "Last name", "text", { ...(required ? { required } : {}), half: true }));
				} else if (t === "file-upload") {
					const max = Number(x.max_file_number);
					fields.push(fileField(slugName(label || `file_${str(x.id)}`), label, { required, accept: extensionsFrom(x.extensions), maxMb: megabytes(x.max_size), maxFiles: max > 0 ? max : 1 }));
				} else {
					const type = TYPE[t];
					if (!type) {
						if (!["html", "divider", "hidden", "captcha", "content", "entry-preview"].includes(t)) warnings.push(`field "${t}" (${label || "no label"}) not supported; rebuild by hand`);
						continue;
					}
					const name = t === "email" ? "email" : t === "phone" ? "phone" : t === "name" ? "name" : slugName(label || `${t}_${str(x.id)}`);
					const options = ["select", "radio", "checkbox"].includes(t) ? arr(x.choices).map((c) => str(o(c).label) ?? "").filter(Boolean) : undefined;
					const placeholder = str(x.placeholder);
					fields.push(field(name, label, type, { ...(required ? { required } : {}), ...(placeholder ? { placeholder } : {}), ...(options && options.length > 1 ? { options } : {}) }));
				}
				for (const added of fields.slice(before)) {
					if (step) added.step = step;
					byId.set(str(x.id) ?? "", added.name);
				}
				// conditionals: OR groups of AND rules ([[rule, rule], [rule]]); the rebuilt form takes one group, or one rule per group.
				if (truthy(x.conditional_logic)) {
					const groups = arr(x.conditionals).map((g) => arr(g).map(o));
					const flat = groups.length === 1 ? groups[0] ?? [] : groups.every((g) => g.length === 1) ? groups.flat() : [];
					const match = groups.length === 1 ? "all" : "any";
					const rules = flat.map((r) => ({ id: str(r.field) ?? "", op: str(r.operator) ?? "==", value: str(r.value) ?? "" }));
					for (const added of fields.slice(before)) {
						if (!flat.length) notes.push(`“${added.label}”: conditional logic not carried (several groups of rules); the field is always shown`);
						else pending.push({ field: added, rules, match, action: str(x.conditional_type) === "hide" ? "hide" : "show" });
					}
				}
			}
			applyRules(pending, byId, notes);
			const confirmation = arr(s.confirmations).map(o)[0];
			if (confirmation && str(confirmation.type) && confirmation.type !== "message") warnings.push(`confirmation is a ${str(confirmation.type)} (redirect/page): rebuilt as a message`);
			const recipients = arr(s.notifications).flatMap((n) => emails(str(o(n).email)));
			if (arr(s.notifications).some((n) => /\{admin_email\}/.test(str(o(n).email) ?? ""))) warnings.push("a notification goes to {admin_email}: set the recipients in the site's admin (Form messages → Settings)");
			const title = str(s.form_title) ?? str(f.post_title) ?? `Form ${id}`;
			return { provider: "wpforms", id, title, status: "publish" as const, definition: def(`wpforms-${id}`, title, fields, str(s.submit_text), str(confirmation?.message), warnings, { notes, stepTitles }), recipients };
		});
}

/** One value from a PHP-serialised array: `s:12:"mail_sent_ok";s:N:"…"`. */
const phpValue = (serialised: string, key: string): string | undefined => {
	const re = new RegExp(`s:\\d+:"${key}";s:(\\d+):"`);
	const m = re.exec(serialised);
	if (!m) return undefined;
	const start = m.index + m[0].length;
	// Lengths are in bytes; read up to the closing quote that ends the value.
	const end = serialised.indexOf('";', start + Math.max(0, Number(m[1]) - 8));
	return end > start ? serialised.slice(start, end) : undefined;
};
const xmlText = (s: string) => s.replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");

/** Contact Form 7, from WordPress Tools → Export (WXR items of post type wpcf7_contact_form). */
export function parseContactForm7(xml: string): ImportedForm[] {
	const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1] ?? "").filter((i) => /<wp:post_type>(?:<!\[CDATA\[)?wpcf7_contact_form/.test(i));
	const meta = (item: string, key: string) => {
		const m = new RegExp(`<wp:meta_key>(?:<!\\[CDATA\\[)?${key}(?:\\]\\]>)?</wp:meta_key>\\s*<wp:meta_value>([\\s\\S]*?)</wp:meta_value>`).exec(item);
		return m?.[1] ? xmlText(m[1].trim()) : undefined;
	};
	const TYPE: Record<string, FormFieldOut["type"]> = { text: "text", email: "email", tel: "tel", number: "number", url: "url", date: "date", textarea: "textarea", select: "select", radio: "select", checkbox: "checkbox", acceptance: "checkbox" };
	return items.map((item) => {
		const id = /<wp:post_id>(\d+)<\/wp:post_id>/.exec(item)?.[1] ?? "0";
		const title = xmlText(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1]?.trim() ?? `Form ${id}`);
		const template = meta(item, "_form") ?? "";
		const warnings: string[] = [];
		const notes: string[] = [];
		const fields: FormFieldOut[] = [];
		let submit: string | undefined;
		// Add-ons, not core: Conditional Fields ([group]) and Multi-Step ([multistep]) — reported, the fields are kept.
		if (/\[group\s/.test(template)) notes.push("conditional groups ([group], Conditional Fields for CF7) not carried: every field is always shown");
		if (/\[multistep\s/.test(template)) notes.push("multi-step ([multistep] add-on) not carried: the form is one step");
		// Label text written right before a tag (`<label> Your name [text* your-name] </label>`).
		const tagRe = /\[(\w+)(\*?)\s+([\w-]+)([^\]]*)\]/g;
		let last = 0;
		for (let m = tagRe.exec(template); m; m = tagRe.exec(template)) {
			const [, t = "", star, name = "", rest = ""] = m;
			const before = stripHtml(template.slice(last, m.index).split(/<\/label>|<br\s*\/?>|\n\s*\n/i).pop() ?? "");
			last = m.index + m[0].length;
			if (t === "submit") continue;
			const type = TYPE[t];
			if (t === "file") {
				// [file* name limit:2mb filetypes:pdf|doc]
				const limit = /\blimit:(\d+(?:\.\d+)?)(kb|mb)?/i.exec(rest);
				const types = /\bfiletypes:([\w|.]+)/i.exec(rest)?.[1];
				const label = before || name.replace(/^your-/, "").replace(/-/g, " ");
				fields.push(fileField(name.replace(/-/g, "_"), label, { required: !!star, accept: extensionsFrom(types?.split("|")), maxMb: limit ? Math.max(1, Math.min(25, Math.round(Number(limit[1]) / (/kb/i.test(limit[2] ?? "") ? 1024 : /mb/i.test(limit[2] ?? "") ? 1 : 1024 * 1024)))) : 1 }));
				continue;
			}
			if (!type) {
				if (!["hidden", "recaptcha", "quiz", "response", "group", "multistep"].includes(t)) warnings.push(`field "${t}" (${name}) not supported; rebuild by hand`);
				continue;
			}
			const quoted = [...rest.matchAll(/"([^"]*)"/g)].map((q) => q[1] ?? "");
			const placeholder = /\bplaceholder\b/.test(rest) ? quoted[0] : undefined;
			const options = ["select", "radio", "checkbox"].includes(t) && quoted.length > 1 ? quoted : undefined;
			const acceptance = t === "acceptance" ? stripHtml(new RegExp(`\\[acceptance[^\\]]*\\b${name}\\b[^\\]]*\\]([\\s\\S]*?)\\[/acceptance\\]`).exec(template)?.[1] ?? "") : undefined;
			const n = name.replace(/-/g, "_");
			const label = acceptance || before || placeholder || (t === "checkbox" && quoted.length === 1 ? quoted[0] : undefined) || name.replace(/^your-/, "").replace(/-/g, " ");
			fields.push(field(n, label ?? n, type, { ...(star || t === "acceptance" ? { required: true } : {}), ...(placeholder ? { placeholder } : {}), ...(options ? { options } : {}) }));
		}
		submit = /\[submit\s+"([^"]+)"\]/.exec(template)?.[1];
		const messages = meta(item, "_messages") ?? "";
		const mail = meta(item, "_mail") ?? "";
		const recipients = emails(phpValue(mail, "recipient"));
		if (/\[_site_admin_email\]/.test(phpValue(mail, "recipient") ?? "")) warnings.push("mail goes to [_site_admin_email]: set the recipients in the site's admin (Form messages → Settings)");
		const status = /<wp:status>(?:<!\[CDATA\[)?publish/.test(item) ? "publish" : "draft";
		// CF7 5.8+ embeds forms by a short hash ([contact-form-7 id="1a2b3c4"]): the first 7 characters of `_hash`.
		const hash = meta(item, "_hash")?.slice(0, 7);
		return { provider: "contact-form-7", id, title, status, definition: def(`contact-form-7-${id}`, title, fields, submit, phpValue(messages, "mail_sent_ok"), warnings, { notes }), recipients, ...(hash && /^[0-9a-f]{7}$/i.test(hash) ? { aliases: [hash] } : {}) };
	});
}

/** Fluent Forms Tools → Export: an array of forms with `form_fields` (JSON string) and `metas`; kept in the REST shape. */
export function parseFluentFormsExport(json: unknown): ImportedForm[] {
	return arr(json)
		.map(o)
		.filter((f) => f.form_fields !== undefined && (f.title !== undefined || f.id !== undefined))
		.map((f) => {
			const parse = (v: unknown) => {
				if (typeof v !== "string") return v;
				try {
					return JSON.parse(v);
				} catch {
					return v;
				}
			};
			const settings: Obj = {};
			for (const m of arr(f.metas).map(o)) {
				const key = str(m.meta_key);
				if (key && ["formSettings", "notifications", "advancedValidationSettings", "double_optin_settings"].includes(key)) settings[key] = [...((settings[key] as unknown[]) ?? []), { value: parse(m.value) }];
			}
			const id = str(f.id) ?? "0";
			const title = str(f.title) ?? `Form ${id}`;
			const recipients = ((settings.notifications as Obj[] | undefined) ?? []).flatMap((n) => emails(str(o(o(n).value).sendTo && o(o(o(n).value).sendTo).email)));
			return { provider: "fluent-forms", id, title, status: str(f.status) === "unpublished" ? ("draft" as const) : ("publish" as const), raw: { provider: "fluent-forms", id, title, status: str(f.status) ?? "published", form: { form_fields: parse(f.form_fields) }, settings }, recipients };
		});
}

/** A form id from the file name when the export does not carry one (`ninja-form-3.nff`, `forminator-12.json`). */
const idFromFile = (fileName: string) => /(\d+)(?=[^\d]*$)/.exec(fileName.replace(/\.[a-z]+$/i, ""))?.[1];

/**
 * Ninja Forms .nff export (Import/Export → Export Forms): `{ settings, fields: [...], actions: [...] }`, one form per
 * file. Field types: textbox, firstname, lastname, email, phone, textarea, listselect/listradio/listcheckbox/
 * listmultiselect, checkbox, date, number, zip, city, address, liststate, listcountry, file_upload (add-on)… Conditional
 * Logic (add-on) lives in `settings.conditions` ({ when: [{ key, comparator, value }], then: [{ key, trigger }] }),
 * Multi-Part (add-on) in `settings.formContentData` ([{ title, formContentData: [field keys] }]). The export has no
 * form id: it comes from `settings.id`, else from the file name.
 */
export function parseNinjaForms(json: unknown, fileName = ""): ImportedForm[] {
	const top = o(json);
	const st = o(top.settings);
	const id = str(st.id) ?? str(top.id) ?? idFromFile(fileName) ?? slugName(str(st.title) ?? "form");
	const TYPE: Record<string, FormFieldOut["type"]> = { textbox: "text", firstname: "text", lastname: "text", address: "text", address2: "text", city: "text", zip: "text", spam: "text", email: "email", phone: "tel", textarea: "textarea", listselect: "select", listradio: "radio", listcheckbox: "checkbox", listmultiselect: "checkbox", liststate: "select", listcountry: "select", checkbox: "checkbox", date: "date", number: "number" };
	const PAYMENT = new Set(["product", "quantity", "shipping", "total", "creditcard", "creditcardnumber", "creditcardcvc", "creditcardexpiration", "creditcardzip", "creditcardfullname", "stripe", "paypal_express", "tax"]);
	const warnings: string[] = [];
	const notes: string[] = [];
	const fields: FormFieldOut[] = [];
	const byKey = new Map<string, string>();
	const fieldsRaw = arr(top.fields).map(o).sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
	// Multi-Part: the parts list which field keys sit on which step.
	const parts = arr(st.formContentData).map(o).filter((p) => Array.isArray(p.formContentData));
	const stepOf = new Map<string, number>();
	parts.forEach((p, i) => arr(p.formContentData).forEach((k) => stepOf.set(typeof k === "string" ? k : (str(o(k).key) ?? ""), i)));
	for (const x of fieldsRaw) {
		const t = str(x.type) ?? "";
		const key = str(x.key) ?? "";
		const label = stripHtml(str(x.label) ?? "");
		const required = truthy(x.required);
		if (["submit", "html", "hr", "hidden", "recaptcha", "recaptcha_v3", "note", "confirm", "password", "passwordconfirm", "save"].includes(t)) continue;
		if (PAYMENT.has(t)) {
			warnings.push(paymentWarning(t, label));
			continue;
		}
		let out: FormFieldOut | undefined;
		if (t === "file_upload") out = fileField(slugName(key || label), label, { required, accept: extensionsFrom(x.upload_types), maxMb: megabytes(x.max_file_size), maxFiles: truthy(x.upload_multi_count) ? Number(x.upload_multi_count) : 1 });
		else {
			const type = TYPE[t];
			if (!type) {
				warnings.push(`field "${t}" (${label || "no label"}) not supported; rebuild by hand`);
				continue;
			}
			const name = t === "firstname" ? "first_name" : t === "lastname" ? "last_name" : t === "email" ? "email" : t === "phone" ? "phone" : slugName(key || label);
			const options = arr(x.options).map((c) => str(o(c).label) ?? "").filter(Boolean);
			const placeholder = str(x.placeholder);
			out = field(name, label, type, { ...(required ? { required } : {}), ...(placeholder ? { placeholder } : {}), ...(options.length && (type !== "checkbox" || options.length > 1) ? { options } : {}), ...(t === "firstname" || t === "lastname" ? { half: true } : {}) });
		}
		const s = stepOf.get(key);
		if (s) out.step = s;
		fields.push(out);
		byKey.set(key, out.name);
	}
	// Conditions: each { when, then, else } names fields by key; only "show_field"/"hide_field" on single fields is carried.
	const pending: Parameters<typeof applyRules>[0] = [];
	for (const c of arr(st.conditions).map(o)) {
		const when = arr(c.when).map(o);
		const connectors = new Set(when.map((w) => (str(w.connector) ?? "AND").toUpperCase()));
		for (const then of arr(c.then).map(o)) {
			const target = fields.find((f) => f.name === byKey.get(str(then.key) ?? ""));
			const trigger = str(then.trigger) ?? "";
			if (!target) continue;
			if (trigger !== "show_field" && trigger !== "hide_field") {
				notes.push(`“${target.label}”: conditional action "${trigger}" not carried`);
				continue;
			}
			pending.push({ field: target, rules: when.map((w) => ({ id: str(w.key) ?? "", op: str(w.comparator) ?? "equal", value: str(w.value) ?? "" })), match: connectors.has("OR") ? "any" : "all", action: trigger === "show_field" ? "show" : "hide" });
		}
	}
	applyRules(pending, byKey, notes);
	const actions = arr(top.actions).map(o);
	const success = actions.find((a) => str(a.type) === "successmessage" && !(a.active === 0 || a.active === "0"));
	const recipients = actions.filter((a) => str(a.type) === "email" && !(a.active === 0 || a.active === "0")).flatMap((a) => emails(str(a.to)));
	if (actions.some((a) => str(a.type) === "email" && /\{wp:admin_email\}|\{system:admin_email\}/.test(str(a.to) ?? ""))) warnings.push("an email action goes to the WordPress admin address: set the recipients in the site's admin (Form messages → Settings)");
	if (actions.some((a) => str(a.type) === "redirect")) warnings.push("a redirect action (to a page) is rebuilt as a message");
	const title = str(st.title) ?? `Form ${id}`;
	return [{ provider: "ninja-forms", id, title, status: "publish", definition: def(`ninja-forms-${id}`, title, fields, str(fieldsRaw.find((x) => x.type === "submit")?.label), str(success?.success_msg), warnings, { notes, stepTitles: parts.map((p) => str(p.title) ?? "") }), recipients }];
}

/** Text of `<tag>…</tag>` in an XML fragment (CDATA unwrapped, entities decoded). */
const xmlTag = (xml: string, tag: string) => {
	const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
	return m ? xmlText(m[1]?.trim() ?? "") : undefined;
};
/** A Formidable options value: JSON, PHP-serialised (strings only) or empty. */
const looseJson = (v: string | undefined): unknown => {
	if (!v) return undefined;
	try {
		return JSON.parse(v);
	} catch {
		const strings = [...v.matchAll(/s:\d+:"([^"]*)";/g)].map((m) => m[1] ?? "");
		return strings.length ? strings : undefined;
	}
};

/**
 * Formidable Forms XML export (Import/Export → XML): `<form>` elements with `<field>` children (`type`, `name`,
 * `required`, `options`, `field_options` JSON: `hide_field`/`hide_field_cond`/`hide_opt`/`show_hide`/`any_all` for
 * conditional logic, `ftypes`/`size`/`max` for uploads) and `frm_form_actions` items for the email recipients.
 * A `break` field is a page break (steps).
 */
export function parseFormidable(xml: string): ImportedForm[] {
	const TYPE: Record<string, FormFieldOut["type"]> = { text: "text", name: "text", address: "text", email: "email", phone: "tel", url: "url", website: "url", number: "number", range: "number", textarea: "textarea", rte: "textarea", select: "select", radio: "radio", checkbox: "checkbox", date: "date", toggle: "checkbox" };
	const PAYMENT = new Set(["product", "quantity", "total", "credit_card", "stripe", "paypal", "square", "authnet"]);
	// Email actions: items of post type frm_form_actions whose content names `email_to`; the form is the item's menu_order (Formidable keeps the form id there).
	const actionRecipients = new Map<string, string[]>();
	for (const item of [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1] ?? "")) {
		if (!/frm_form_actions/.test(item)) continue;
		const formId = xmlTag(item, "wp:menu_order") ?? xmlTag(item, "menu_order") ?? xmlTag(item, "wp:post_parent") ?? "";
		const content = xmlTag(item, "content:encoded") ?? xmlTag(item, "post_content") ?? "";
		const to = /"email_to"\s*:\s*"([^"]*)"/.exec(content)?.[1];
		if (to) actionRecipients.set(formId, [...(actionRecipients.get(formId) ?? []), ...emails(to.replace(/\\\//g, "/"))]);
	}
	return [...xml.matchAll(/<form>([\s\S]*?)<\/form>/g)].flatMap((m) => {
		const body = m[1] ?? "";
		const head = body.split(/<field>/)[0] ?? "";
		const id = xmlTag(head, "id") ?? "0";
		if (xmlTag(head, "is_template") === "1") return [];
		const title = xmlTag(head, "name") ?? `Form ${id}`;
		const options = o(looseJson(xmlTag(head, "options")));
		const warnings: string[] = [];
		const notes: string[] = [];
		const fields: FormFieldOut[] = [];
		const byId = new Map<string, string>();
		const pending: Parameters<typeof applyRules>[0] = [];
		const stepTitles: string[] = [];
		let step = 0;
		const raw = [...body.matchAll(/<field>([\s\S]*?)<\/field>/g)].map((f) => f[1] ?? "").sort((a, b) => Number(xmlTag(a, "field_order") ?? 0) - Number(xmlTag(b, "field_order") ?? 0));
		for (const f of raw) {
			const t = xmlTag(f, "type") ?? "";
			const fid = xmlTag(f, "id") ?? "";
			const label = stripHtml(xmlTag(f, "name") ?? "");
			const required = xmlTag(f, "required") === "1";
			const fo = o(looseJson(xmlTag(f, "field_options")));
			if (t === "break") {
				stepTitles[++step] = label;
				continue;
			}
			if (["html", "divider", "end_divider", "captcha", "hidden", "user_id", "password", "summary"].includes(t)) continue;
			if (PAYMENT.has(t)) {
				warnings.push(paymentWarning(t, label));
				continue;
			}
			let out: FormFieldOut | undefined;
			if (t === "file") out = fileField(slugName(xmlTag(f, "field_key") || label), label, { required, accept: Object.keys(o(fo.ftypes)).flatMap((k) => k.split("|")).filter(Boolean), maxMb: megabytes(fo.size), maxFiles: truthy(fo.multiple) ? Number(fo.max) || 5 : 1 });
			else {
				const type = TYPE[t];
				if (!type) {
					warnings.push(`field "${t}" (${label || "no label"}) not supported; rebuild by hand`);
					continue;
				}
				const opts = arr(looseJson(xmlTag(f, "options"))).map((c) => (typeof c === "string" ? c : (str(o(c).label) ?? str(o(c).value) ?? ""))).filter(Boolean);
				const name = t === "email" ? "email" : t === "phone" ? "phone" : slugName(label || xmlTag(f, "field_key") || `${t}_${fid}`);
				const placeholder = str(fo.placeholder);
				out = field(name, label, type, { ...(required ? { required } : {}), ...(placeholder ? { placeholder } : {}), ...(opts.length && (type !== "checkbox" || opts.length > 1) ? { options: opts } : {}) });
			}
			if (step) out.step = step;
			fields.push(out);
			byId.set(fid, out.name);
			const ids = arr(fo.hide_field).map((v) => str(v) ?? "");
			if (ids.some(Boolean)) {
				const conds = arr(fo.hide_field_cond).map((v) => str(v) ?? "==");
				const vals = arr(fo.hide_opt).map((v) => str(v) ?? "");
				pending.push({ field: out, rules: ids.map((x, i) => ({ id: x, op: conds[i] ?? "==", value: vals[i] ?? "" })), match: str(fo.any_all) === "all" ? "all" : "any", action: str(fo.show_hide) === "hide" ? "hide" : "show" });
			}
		}
		applyRules(pending, byId, notes);
		if (str(options.success_action) && str(options.success_action) !== "message") warnings.push(`on success the form ${str(options.success_action) === "redirect" ? "redirects" : "shows a page"}: rebuilt as a message`);
		const status = (xmlTag(head, "status") ?? "published") === "published" ? "publish" : "draft";
		return [{ provider: "formidable", id, title, status, definition: def(`formidable-${id}`, title, fields, str(options.submit_value), str(options.success_msg), warnings, { notes, stepTitles }), recipients: actionRecipients.get(id) ?? [] } satisfies ImportedForm];
	});
}

/**
 * WS Form JSON export (Forms → Export): `{ id, label, groups: [{ label, sections: [{ fields: [{ id, label, type, meta }] }] }],
 * meta, identifier? }`. Each group is a tab: a form with several groups is a multi-step form. Field meta carries
 * `required` ("on"), `placeholder`, choices (`data_grid_select` / `data_grid_radio` / `data_grid_checkbox`: groups →
 * rows → data[0]) and upload limits (`file_types`, `file_max_size` in MB, `multiple_file`). Conditional logic is a
 * form-level rule engine (`meta.conditional`): reported, not carried.
 */
export function parseWsForm(json: unknown, fileName = ""): ImportedForm[] {
	const top = o(json);
	const id = str(top.id) ?? idFromFile(fileName) ?? "1";
	const TYPE: Record<string, FormFieldOut["type"]> = { text: "text", email: "email", tel: "tel", url: "url", number: "number", range: "number", textarea: "textarea", texteditor: "textarea", select: "select", radio: "radio", checkbox: "checkbox", datetime: "date", signature: "signature" };
	const warnings: string[] = [];
	const notes: string[] = [];
	const fields: FormFieldOut[] = [];
	const groups = arr(top.groups).map(o);
	let submit: string | undefined;
	groups.forEach((g, gi) => {
		for (const sec of arr(g.sections).map(o)) {
			for (const x of arr(sec.fields).map(o)) {
				const t = str(x.type) ?? "";
				const meta = o(x.meta);
				const label = stripHtml(str(x.label) ?? "");
				const required = meta.required === "on" || truthy(meta.required);
				if (t === "submit") {
					submit = label || submit;
					continue;
				}
				if (["html", "divider", "spacer", "message", "hidden", "recaptcha", "hcaptcha", "turnstile", "tab_previous", "tab_next", "save", "reset", "clear", "progress", "section_icons"].includes(t)) continue;
				if (/^(price|cart|ecommerce|stripe|paypal|authorize|square)/.test(t)) {
					warnings.push(paymentWarning(t, label));
					continue;
				}
				let out: FormFieldOut | undefined;
				if (t === "file") out = fileField(slugName(label || `file_${str(x.id)}`), label, { required, accept: extensionsFrom(meta.file_types ?? meta.accept), maxMb: megabytes(meta.file_max_size), maxFiles: meta.multiple_file === "on" ? Number(meta.file_max) || 5 : 1 });
				else {
					const type = TYPE[t];
					if (!type) {
						warnings.push(`field "${t}" (${label || "no label"}) not supported; rebuild by hand`);
						continue;
					}
					const grid = o(meta[`data_grid_${t}`]);
					const opts = arr(grid.groups).flatMap((gr) => arr(o(gr).rows).map((r) => str(arr(o(r).data)[0]) ?? "")).filter(Boolean);
					const name = t === "email" ? "email" : t === "tel" ? "phone" : slugName(label || `${t}_${str(x.id)}`);
					const placeholder = str(meta.placeholder);
					out = field(name, label, type, { ...(required ? { required } : {}), ...(placeholder ? { placeholder } : {}), ...(opts.length && (type !== "checkbox" || opts.length > 1) ? { options: opts } : {}) });
				}
				if (groups.length > 1 && gi) out.step = gi;
				fields.push(out);
			}
		}
	});
	if (arr(o(top.meta).conditional).length || o(o(top.meta).conditional).groups) notes.push("WS Form conditional logic (form-level rules) not carried: every field is always shown");
	const title = str(top.label) ?? `Form ${id}`;
	const status = str(top.status) === "draft" ? "draft" : "publish";
	return [{ provider: "ws-form", id, title, status, definition: def(`ws-form-${id}`, title, fields, submit, str(o(top.meta).form_message) ?? undefined, warnings, { notes, stepTitles: groups.map((g) => str(g.label) ?? "") }), recipients: [] }];
}

/**
 * Forminator export (Forms → Export): `{ type: "form", data: { fields: [{ element_id, type, field_label, required,
 * options, conditions, condition_action, condition_rule, … }], settings: { formName, … }, notifications, behaviors },
 * status }`. Upload fields carry `filetypes` and `upload-limit` (+ `filesize` unit); `page-break` fields split steps;
 * conditions name other fields by element_id (`rule`: is / is_not …). Payment fields (stripe, paypal, calculation,
 * currency) are out of scope.
 */
export function parseForminator(json: unknown, fileName = ""): ImportedForm[] {
	const top = o(json);
	const data = o(top.data);
	const st = o(data.settings);
	const id = str(top.id) ?? str(data.id) ?? str(st.form_id) ?? idFromFile(fileName) ?? slugName(str(st.formName) ?? "form");
	const TYPE: Record<string, FormFieldOut["type"]> = { name: "text", text: "text", address: "text", email: "email", phone: "tel", url: "url", website: "url", number: "number", textarea: "textarea", select: "select", radio: "radio", checkbox: "checkbox", date: "date", gdprcheckbox: "checkbox", consent: "checkbox", signature: "signature" };
	const warnings: string[] = [];
	const notes: string[] = [];
	const fields: FormFieldOut[] = [];
	const byId = new Map<string, string>();
	const pending: Parameters<typeof applyRules>[0] = [];
	const stepTitles: string[] = [];
	let step = 0;
	for (const x of arr(data.fields).map(o)) {
		const t = str(x.type) ?? "";
		const eid = str(x.element_id) ?? str(x.id) ?? "";
		const label = stripHtml(str(x.field_label) ?? str(x.gdpr_description) ?? "");
		const required = truthy(x.required);
		if (t === "page-break") {
			stepTitles[++step] = str(x.field_label) ?? "";
			continue;
		}
		if (["html", "section", "hidden", "captcha", "postdata", "group"].includes(t)) continue;
		if (["stripe", "stripe-ocs", "paypal", "calculation", "currency", "product"].includes(t)) {
			warnings.push(paymentWarning(t, label));
			continue;
		}
		let out: FormFieldOut | undefined;
		if (t === "upload") {
			const limit = Number(x["upload-limit"]);
			const unit = str(x.filesize) ?? "MB";
			out = fileField(slugName(eid || label), label, { required, accept: extensionsFrom(x.filetypes), maxMb: limit > 0 ? megabytes(`${limit}${unit}`) : undefined, maxFiles: str(x["file-type"]) === "multiple" ? Number(x["file-limit"]) || 5 : 1 });
		} else {
			const type = TYPE[t];
			if (!type) {
				warnings.push(`field "${t}" (${label || "no label"}) not supported; rebuild by hand`);
				continue;
			}
			const opts = arr(x.options).map((c) => str(o(c).label) ?? "").filter(Boolean);
			const name = t === "email" ? "email" : t === "phone" ? "phone" : slugName(eid || label);
			const placeholder = str(x.placeholder);
			out = field(name, label || eid, type, { ...(required ? { required } : {}), ...(placeholder ? { placeholder } : {}), ...(opts.length && (type !== "checkbox" || opts.length > 1) ? { options: opts } : {}) });
		}
		if (step) out.step = step;
		fields.push(out);
		byId.set(eid, out.name);
		const conds = arr(x.conditions).map(o);
		if (conds.length) pending.push({ field: out, rules: conds.map((c) => ({ id: str(c.element_id) ?? "", op: (str(c.rule) ?? "is").replace(/_/g, " "), value: str(c.value) ?? "" })), match: str(x.condition_rule) === "any" ? "any" : "all", action: str(x.condition_action) === "hide" ? "hide" : "show" });
	}
	applyRules(pending, byId, notes);
	const recipients = arr(data.notifications).map(o).flatMap((n) => emails(str(n.recipients) ?? str(n["email-recipients"])));
	const behavior = arr(data.behaviors).map(o)[0] ?? st;
	if (str(behavior["submission-behaviour"]) && str(behavior["submission-behaviour"]) !== "behaviour-thankyou") warnings.push("after sending the form redirects to a page: rebuilt as a message");
	const title = str(st.formName) ?? `Form ${id}`;
	return [{ provider: "forminator", id, title, status: str(top.status) === "draft" ? "draft" : "publish", definition: def(`forminator-${id}`, title, fields, str(o(st.submitData)["custom-submit-text"]), str(behavior["thankyou-message"]), warnings, { notes, stepTitles }), recipients }];
}

/**
 * Rendered-HTML fallback: a live form the audit saw (snapshot/integrations.json) whose plugin export is missing. The
 * labels, types, options and required marks come from the page's HTML; the success message, recipients, conditional
 * logic and steps cannot be read from it, so the definition carries a warning (the scaffold `forms` gate stays red
 * until someone checks the rebuilt form against the live one and accepts it).
 */
export function formFromSnapshot(form: { provider: string; providerFormId?: string; fields: { name: string; type: string; label?: string; required?: boolean; options?: string[]; placeholder?: string }[]; submitLabel?: string }): ImportedForm | undefined {
	const TYPE: Record<string, FormFieldOut["type"]> = { text: "text", email: "email", tel: "tel", number: "number", url: "url", date: "date", textarea: "textarea", select: "select", radio: "radio", checkbox: "checkbox", file: "file" };
	const id = form.providerFormId ?? "";
	if (!id) return undefined;
	const fields: FormFieldOut[] = [];
	const seen = new Set<string>();
	for (const f of form.fields) {
		const type = TYPE[f.type];
		if (!type) continue;
		const name = slugName(f.name.replace(/\[\]$/, "").replace(/^(?:form_fields|item_meta|wpforms\[fields\]|input|nf-field)[[_-]?/, "").replace(/\]$/, ""));
		if (seen.has(name)) continue;
		seen.add(name);
		const label = f.label ?? f.placeholder ?? name.replace(/_/g, " ");
		if (type === "checkbox" && f.options?.length === 1) {
			fields.push(field(name, f.options[0] as string, "checkbox", { ...(f.required ? { required: true } : {}) }));
			continue;
		}
		fields.push(type === "file" ? fileField(name, label, { ...(f.required ? { required: true } : {}) }) : field(name, label, type, { ...(f.required ? { required: true } : {}), ...(f.placeholder ? { placeholder: f.placeholder } : {}), ...(f.options?.length ? { options: f.options } : {}) }));
	}
	if (!fields.length) return undefined;
	const title = `${form.provider} form ${id}`;
	return { provider: form.provider, id, title, status: "publish", definition: def(`${form.provider}-${id}`, title, fields, form.submitLabel, undefined, ["rebuilt from the live page's HTML (no plugin export): check labels, options, the success message, conditional fields and steps against the live form, then accept"]), recipients: [] };
}

// ── Redirects ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RedirectRule {
	source: string;
	destination: string;
	type: 301 | 302 | 307 | 308 | 410 | 451;
	from: string;
}
export interface Unconverted {
	rule: string;
	reason: string;
	from: string;
}

/** Hosts that count as this site (old and new): their absolute URLs become paths. */
export function toPath(url: string, siteHosts: string[]): string | undefined {
	const u = url.trim();
	if (!u) return undefined;
	if (u.startsWith("/") && !u.startsWith("//")) return u;
	if (!/^https?:\/\//i.test(u)) return `/${u.replace(/^\.?\//, "")}`;
	try {
		const p = new URL(u);
		if (!siteHosts.map((h) => h.replace(/^www\./, "")).includes(p.host.replace(/^www\./, ""))) return undefined;
		return `${p.pathname}${p.search}`;
	} catch {
		return undefined;
	}
}

const STATUS = new Set([301, 302, 307, 308, 410, 451]);
const status = (v: unknown): RedirectRule["type"] => {
	const n = Number(v);
	return (STATUS.has(n) ? n : 301) as RedirectRule["type"];
};

/** `^/?old/(.*)$` → `/old/[...path]` with `$1` → `[...path]`: the only regex shape EmDash's route patterns can hold. */
export function regexToPattern(source: string, destination: string): { source: string; destination: string } | undefined {
	const m = /^\^?\/?((?:[\w-]+\/)*[\w-]+)\/?\(\.\*\)\/?\$?$/.exec(source.trim());
	if (!m) {
		const exact = /^\^?(\/?[\w\-/.]*?)\/?\??\$$/.exec(source.trim());
		if (exact && !/[()[\]*+?{}|\\]/.test(exact[1]?.replace(/\./g, "") ?? "")) return { source: `/${(exact[1] ?? "").replace(/^\//, "")}`.replace(/\\\./g, "."), destination };
		return undefined;
	}
	const base = `/${m[1]}`;
	if ((destination.match(/\$1/g) ?? []).length > 1 || /\$[2-9]/.test(destination)) return undefined;
	return { source: `${base}/[...path]`, destination: destination.replace("$1", "[...path]") };
}

function rule(source: string, destination: string, code: unknown, from: string, hosts: string[], isRegex: boolean, out: RedirectRule[], bad: Unconverted[]): void {
	const type = status(code);
	const terminal = type === 410 || type === 451;
	let src = source;
	let dest = destination;
	if (isRegex) {
		const p = regexToPattern(source, destination);
		if (!p) return void bad.push({ rule: `${source} → ${destination}`, reason: "regular expression EmDash cannot express (route patterns only: [param], [...rest])", from });
		src = p.source;
		dest = p.destination;
	}
	const s = toPath(src, hosts);
	if (!s) return void bad.push({ rule: `${source} → ${destination}`, reason: "source is not on this site", from });
	const d = terminal ? "" : toPath(dest, hosts);
	if (d === undefined) return void bad.push({ rule: `${source} → ${destination}`, reason: "destination is another site (EmDash redirects only to paths on this site): keep it as a link or an edge rule", from });
	if (!terminal && s === d) return;
	out.push({ source: s, destination: d, type, from });
}

/** Redirection plugin JSON export. */
export function parseRedirection(json: unknown, hosts: string[]): { rules: RedirectRule[]; unconverted: Unconverted[] } {
	const rules: RedirectRule[] = [];
	const unconverted: Unconverted[] = [];
	for (const r of arr(o(json).redirects).map(o)) {
		const url = str(r.url) ?? "";
		if (r.enabled === false || r.status === "disabled") continue;
		if ((str(r.match_type) ?? "url") !== "url" || (str(r.action_type) ?? "url") !== "url") {
			if (str(r.action_type) === "error" && str(r.match_type) === "url") rule(url, "", 410, "redirection", hosts, truthy(r.regex), rules, unconverted);
			else unconverted.push({ rule: url, reason: `match "${str(r.match_type)}" / action "${str(r.action_type)}" (conditional or non-URL rule)`, from: "redirection" });
			continue;
		}
		const data = r.action_data;
		const target = typeof data === "string" ? data : (str(o(data).url) ?? "");
		rule(url, target, r.action_code, "redirection", hosts, truthy(r.regex), rules, unconverted);
	}
	return { rules, unconverted };
}

/** Apache (.htaccess) or Nginx rules, as Rank Math exports them (and hand-written ones of the same shapes). */
export function parseServerRules(text: string, hosts: string[], from = "rank-math"): { rules: RedirectRule[]; unconverted: Unconverted[] } {
	const rules: RedirectRule[] = [];
	const unconverted: Unconverted[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || /^(RewriteEngine|RewriteBase|<\/?IfModule|RewriteCond|server\s*\{|\}|location\s*\/\s*\{)/i.test(line)) {
			if (/^RewriteCond/i.test(line)) unconverted.push({ rule: line, reason: "conditional rule (RewriteCond)", from });
			continue;
		}
		let m = /^Redirect(?:Permanent)?\s+(?:(\d{3}|permanent|temp|gone)\s+)?"?([^"\s]+)"?(?:\s+"?([^"\s]+)"?)?/i.exec(line);
		if (m) {
			const code = m[1] === "gone" ? 410 : m[1] === "temp" ? 302 : m[1] && /^\d+$/.test(m[1]) ? m[1] : 301;
			rule(m[2] ?? "", m[3] ?? "", code, from, hosts, false, rules, unconverted);
			continue;
		}
		m = /^RedirectMatch\s+(?:(\d{3})\s+)?"?([^"\s]+)"?\s+"?([^"\s]+)"?/i.exec(line);
		if (m) {
			rule(m[2] ?? "", m[3] ?? "", m[1] ?? 301, from, hosts, true, rules, unconverted);
			continue;
		}
		m = /^RewriteRule\s+"?([^"\s]+)"?\s+"?([^"\s]+)"?\s+\[([^\]]*)\]/i.exec(line);
		if (m) {
			const flags = m[3] ?? "";
			const code = /R=(\d{3})/i.exec(flags)?.[1] ?? (/\bG\b/.test(flags) ? 410 : /\bR\b/.test(flags) ? 302 : undefined);
			if (!code) unconverted.push({ rule: line, reason: "internal rewrite, not a redirect", from });
			else rule(m[1] ?? "", m[2] ?? "", code, from, hosts, true, rules, unconverted);
			continue;
		}
		m = /^location\s+(=|~\*?)?\s*"?([^"\s{]+)"?\s*\{\s*return\s+(\d{3})\s*([^;\s]*)\s*;\s*\}?/i.exec(line);
		if (m) {
			rule(m[2] ?? "", m[4] ?? "", m[3], from, hosts, (m[1] ?? "").startsWith("~"), rules, unconverted);
			continue;
		}
		m = /^rewrite\s+"?([^"\s]+)"?\s+"?([^"\s]+)"?\s+(permanent|redirect)\s*;/i.exec(line);
		if (m) {
			rule(m[1] ?? "", m[2] ?? "", m[3] === "permanent" ? 301 : 302, from, hosts, true, rules, unconverted);
			continue;
		}
		unconverted.push({ rule: line.slice(0, 200), reason: "line not understood", from });
	}
	return { rules, unconverted };
}

/** CSV: Yoast (Origin, Target, Type, Format) or any `from,to[,code]` file; regex rows (Yoast format "regex") are converted when they can be. */
export function parseRedirectCsv(text: string, hosts: string[], from = "csv"): { rules: RedirectRule[]; unconverted: Unconverted[] } {
	const rules: RedirectRule[] = [];
	const unconverted: Unconverted[] = [];
	const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => [...l.matchAll(/("([^"]|"")*"|[^,;\t]*)(?:[,;\t]|$)/g)].map((m) => (m[1] ?? "").replace(/^"|"$/g, "").replace(/""/g, '"').trim()).filter((_, i, a) => i < a.length - 1 || a[i] !== ""));
	const header = rows[0]?.map((h) => h.toLowerCase()) ?? [];
	const hasHeader = header.some((h) => /origin|source|from|old|url/.test(h)) && !header.some((h) => h.startsWith("/") || /^https?:/.test(h));
	const col = (re: RegExp, fallback: number) => (hasHeader ? Math.max(header.findIndex((h) => re.test(h)), -1) : fallback);
	const [ci, ct, cc, cf] = [col(/origin|source|from|old/, 0), col(/target|destination|to|new/, 1), col(/type|code|status/, 2), col(/format|regex/, 3)];
	for (const r of rows.slice(hasHeader ? 1 : 0)) {
		const src = r[ci < 0 ? 0 : ci] ?? "";
		if (!src) continue;
		rule(src, r[ct < 0 ? 1 : ct] ?? "", r[cc] ?? 301, from, hosts, /regex/i.test(r[cf] ?? ""), rules, unconverted);
	}
	return { rules, unconverted };
}

// ── Recognise a dropped file ─────────────────────────────────────────────────────────────────────────────────────

export type Recognised =
	| { kind: "forms"; provider: string; forms: ImportedForm[] }
	| { kind: "redirects"; provider: string; rules: RedirectRule[]; unconverted: Unconverted[] }
	/** Custom field definitions (ACF field groups, Meta Box, Pods): copied to raw/field-definitions/ for the CPT mapper. */
	| { kind: "fields"; provider: "acf" | "metabox" | "pods"; data: unknown }
	| { kind: "unknown"; reason: string };

export function recognise(fileName: string, content: string, hosts: string[]): Recognised {
	const text = content.replace(/^\uFEFF/, "");
	if (text.trimStart().startsWith("<")) {
		if (/wpcf7_contact_form/.test(text)) return { kind: "forms", provider: "contact-form-7", forms: parseContactForm7(text) };
		if (/<form>[\s\S]*?<field>/.test(text) && /<field_key>|<form_key>|frm_/.test(text)) {
			const forms = parseFormidable(text);
			return forms.length ? { kind: "forms", provider: "formidable", forms } : { kind: "unknown", reason: "Formidable export without forms (templates only?)" };
		}
		return { kind: "unknown", reason: "XML without Contact Form 7 or Formidable forms" };
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	if (json !== undefined) {
		const top = o(json);
		if (Array.isArray(top.redirects)) {
			const r = parseRedirection(json, hosts);
			return { kind: "redirects", provider: "redirection", ...r };
		}
		if (isAcfExport(json)) return { kind: "fields", provider: "acf", data: json };
		if (isPodsExport(json)) return { kind: "fields", provider: "pods", data: json };
		if (isMetaBoxExport(json)) return { kind: "fields", provider: "metabox", data: json };
		if (/\.nff$/i.test(fileName) && !Array.isArray(top.fields)) return { kind: "unknown", reason: "Ninja Forms export without fields (export the form again from Ninja Forms → Import/Export)" };
		// Ninja Forms (.nff): settings + fields with Ninja's own types and `key`s.
		if (Array.isArray(top.fields) && top.settings && (/\.nff$/i.test(fileName) || arr(top.fields).some((f) => /^(textbox|listselect|listradio|listcheckbox|firstname|lastname|submit)$/.test(str(o(f).type) ?? "")))) return { kind: "forms", provider: "ninja-forms", forms: parseNinjaForms(json, fileName) };
		// WS Form: groups → sections → fields.
		if (Array.isArray(top.groups) && arr(top.groups).some((g) => Array.isArray(o(g).sections))) return { kind: "forms", provider: "ws-form", forms: parseWsForm(json, fileName) };
		// Forminator: { type: "form", data: { fields, settings } }.
		if (str(top.type) === "form" && Array.isArray(o(top.data).fields)) return { kind: "forms", provider: "forminator", forms: parseForminator(json, fileName) };
		const list = arr(json).map(o);
		if (list.some((f) => f.form_fields !== undefined)) return { kind: "forms", provider: "fluent-forms", forms: parseFluentFormsExport(json) };
		if (list.some((f) => f.fields && f.settings && (o(f.settings).form_title !== undefined || o(f.settings).submit_text !== undefined))) return { kind: "forms", provider: "wpforms", forms: parseWpForms(json) };
		if (top.version !== undefined || list.some((f) => Array.isArray(f.fields) && (f.button || f.confirmations || f.notifications))) {
			const forms = parseGravityForms(json);
			if (forms.length) return { kind: "forms", provider: "gravity-forms", forms };
		}
		return { kind: "unknown", reason: "JSON in a shape the kit does not know" };
	}
	if (/^\s*(Redirect|RewriteRule|RewriteEngine|<IfModule|location\s|rewrite\s|server\s*\{)/im.test(text)) return { kind: "redirects", provider: /\blocation\s|rewrite\s.*(permanent|redirect);/i.test(text) ? "nginx" : "htaccess", ...parseServerRules(text, hosts, /\.conf$|nginx/i.test(fileName) ? "nginx" : "htaccess") };
	if (/[,;\t]/.test(text.split(/\r?\n/)[0] ?? "")) return { kind: "redirects", provider: "csv", ...parseRedirectCsv(text, hosts, /yoast/i.test(fileName) || /^"?origin"?[,;]/i.test(text) ? "yoast" : "csv") };
	return { kind: "unknown", reason: "format not recognised" };
}
