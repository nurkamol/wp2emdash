/**
 * Conditional fields (`showIf`) and steps, shared by the endpoint (which decides what counts) and the page script
 * (which shows and hides). A field is visible when its own condition holds and the field it depends on is visible too;
 * a hidden field is neither required nor sent on. Loops (a field depending on itself through others) count as hidden.
 */
import type { FormField } from "./types.js";

/** The value(s) of a field as the condition sees them: ticked options, "yes" for a ticked single checkbox, else the text. */
export type ValueOf = (field: FormField) => string[];

export function visibility(fields: FormField[], valueOf: ValueOf): Map<string, boolean> {
	const byName = new Map(fields.map((f) => [f.name, f]));
	const memo = new Map<string, boolean>();
	const visiting = new Set<string>();
	const visible = (f: FormField): boolean => {
		const known = memo.get(f.name);
		if (known !== undefined) return known;
		if (!f.showIf) return memo.set(f.name, true), true;
		if (visiting.has(f.name)) return false;
		visiting.add(f.name);
		const ctl = byName.get(f.showIf.field);
		const values = ctl && visible(ctl) ? valueOf(ctl).map((v) => v.trim().toLowerCase()) : [];
		const wanted = f.showIf.equals.map((v) => v.trim().toLowerCase());
		const hit = values.some((v) => wanted.includes(v));
		const out = f.showIf.not ? !hit : hit;
		visiting.delete(f.name);
		memo.set(f.name, out);
		return out;
	};
	for (const f of fields) visible(f);
	return memo;
}

/** Fields grouped by step, in order (forms without steps: one group). */
export function stepsOf(fields: FormField[], count: number): FormField[][] {
	if (count < 2) return [fields];
	const groups: FormField[][] = Array.from({ length: count }, () => []);
	let last = 0;
	for (const f of fields) {
		const s = typeof f.step === "number" && f.step >= 0 && f.step < count ? f.step : last;
		last = s;
		groups[s]?.push(f);
	}
	return groups;
}
