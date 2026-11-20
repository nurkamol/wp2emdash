/**
 * What every form-plugin parser shares beyond the field list: conditional logic, steps (page breaks), file upload limits
 * and payment fields. The rebuilt form (@wp2emdash/forms) understands one kind of condition — show this field when one
 * other field equals (or does not equal) one of some values — and steps; anything richer is reported, never guessed.
 */
import type { FormFieldOut } from "../scaffold/forms.js";

export interface SourceRule {
	/** The controlling field's name in the rebuilt form (the parser maps the plugin's field id to it). */
	field: string | undefined;
	/** Normalised operator: "is" | "is not" | anything else (unsupported). */
	op: string;
	value: string;
}

const IS = /^(=|==|===|is|equal|equals|equal_to|eq|is_equal_to|==?)$/i;
const IS_NOT = /^(!=|!==|not|is not|isnot|is_not|not_equal|not_equal_to|neq|is_not_equal_to|<>)$/i;

/**
 * A plugin's rule set → `showIf`, or a note saying why it is not carried. `action` is the plugin's verb for the rule:
 * "show" (the field appears when the rules match) or "hide" (the field disappears when they match).
 */
export function showIfFrom(label: string, rules: SourceRule[], match: "any" | "all", action: "show" | "hide" = "show"): { showIf?: FormFieldOut["showIf"]; note?: string } {
	if (!rules.length) return {};
	const describe = () => rules.map((r) => `${r.field ?? "?"} ${r.op} "${r.value}"`).join(match === "all" ? " and " : " or ");
	const notCarried = (why: string) => ({ note: `“${label}”: conditional logic not carried (${why}: ${action} when ${describe()}); the field is always shown` });
	if (rules.some((r) => !r.field)) return notCarried("it depends on a field that is not in the rebuilt form");
	const fields = new Set(rules.map((r) => r.field));
	const ops = new Set(rules.map((r) => (IS.test(r.op.trim()) ? "is" : IS_NOT.test(r.op.trim()) ? "not" : "other")));
	if (fields.size !== 1 || ops.has("other") || ops.size !== 1) return notCarried(fields.size !== 1 ? "more than one field" : "an operator other than is / is not");
	const field = [...fields][0] as string;
	const values = [...new Set(rules.map((r) => r.value))];
	const negative = ops.has("not");
	// "is A or is B" → one of [A, B]; "is not A and is not B" → none of [A, B]. One value: either reading works.
	if (values.length > 1 && ((negative && match === "any") || (!negative && match === "all"))) return notCarried("a combination the rebuilt form cannot express");
	let not = negative;
	if (action === "hide") not = !not;
	return { showIf: { field, equals: values, ...(not ? { not: true } : {}) } };
}

/** Payment, product and calculation fields: never rebuilt (out of scope); the form needs the owner's decision. */
export const PAYMENT_FIELD = /pay(ment)?|stripe|paypal|square|product|price|total|subtotal|quantity|credit[-_ ]?card|cc[-_]|coupon|donation|subscription|calculation|calc/i;
export const paymentWarning = (kind: string, label: string) => `payment field "${label || kind}" (${kind}) is out of scope: the rebuilt form takes no payments — keep the plugin's checkout elsewhere, or drop the form (overrides.ts integrations "form:<provider>:<id>")`;

/** Extensions from a plugin's allowed-types setting ("pdf, jpg", "pdf|doc", [".pdf"], "image/*"). */
export function extensionsFrom(v: unknown): string[] | undefined {
	const raw = Array.isArray(v) ? v.join(",") : typeof v === "string" ? v : "";
	const out = new Set<string>();
	for (const t of raw.split(/[\s,;|]+/).map((x) => x.trim().toLowerCase().replace(/^\*?\./, ""))) {
		if (!t) continue;
		if (t === "image/*" || t === "images") ["jpg", "jpeg", "png", "gif", "webp", "heic"].forEach((x) => out.add(x));
		else if (/^[a-z0-9]{2,5}$/.test(t)) out.add(t);
		else if (t === "application/pdf") out.add("pdf");
	}
	return out.size ? [...out] : undefined;
}

/** A size in MB from a plugin setting ("5", "5MB", "5120" KB when `kb`). */
export function megabytes(v: unknown, kb = false): number | undefined {
	const n = Number.parseFloat(String(v ?? ""));
	if (!Number.isFinite(n) || n <= 0) return undefined;
	const mb = /kb/i.test(String(v)) || kb ? n / 1024 : /gb/i.test(String(v)) ? n * 1024 : n;
	return Math.max(1, Math.min(25, Math.round(mb)));
}

/** A file field with its limits. */
export function fileField(name: string, label: string, opts: { required?: boolean; accept?: string[]; maxMb?: number; maxFiles?: number }): FormFieldOut {
	return { name, label: label || name, type: "file", ...(opts.required ? { required: true } : {}), ...(opts.accept?.length ? { accept: opts.accept } : {}), ...(opts.maxMb ? { maxMb: opts.maxMb } : {}), ...(opts.maxFiles && opts.maxFiles > 1 ? { maxFiles: Math.min(5, opts.maxFiles) } : {}) };
}

/** Steps: fields carry `step` only when there are at least two (titles default to "Step n"). */
export function withSteps(fields: FormFieldOut[], titles: string[]): { fields: FormFieldOut[]; steps?: { title: string }[] } {
	const count = Math.max(0, ...fields.map((f) => (f.step ?? 0) + 1));
	if (count < 2) return { fields: fields.map(({ step: _s, ...f }) => f) };
	return { fields, steps: Array.from({ length: count }, (_, i) => ({ title: titles[i]?.trim() || `Step ${i + 1}` })) };
}
