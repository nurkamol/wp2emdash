/**
 * Prefill a form from the page address (`/contact/?product=Blue%20Mug`): a WooCommerce catalogue-mode product's Buy
 * button links to the contact form this way (kit.config `shop.checkout: "contact"`). Runs in the browser after the page
 * loaded, so route-cached pages stay the same for everyone; the visitor still reads and sends the form themselves.
 *
 * Rules: a query parameter fills the empty text field of the same name (text, email, tel, number, url, textarea,
 * select with that option); `product` fills a field named product/subject/service, else starts the first empty message
 * box with "I'm interested in: <product>". Never hidden, file, password, checkbox or radio inputs (a link must not
 * tick a consent box or fill the spam trap). Values are trimmed, control characters removed, at most 200 characters.
 */

export interface PrefillField {
	name: string;
	/** input type, "textarea" or "select". */
	type: string;
	value: string;
	/** select: the values it offers. */
	options?: string[];
}

const FILLABLE = new Set(["text", "email", "tel", "number", "url", "search", "textarea", "select"]);
const clean = (v: string) =>
	v
		// biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
		.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "")
		.trim()
		.slice(0, 200);

/** Which fields get which value (field name → value), from the address's query. */
export function prefillPlan(params: URLSearchParams, fields: PrefillField[]): Record<string, string> {
	const out: Record<string, string> = {};
	const fillable = fields.filter((f) => FILLABLE.has(f.type) && !f.value.trim());
	const fits = (f: PrefillField, v: string) => f.type !== "select" || (f.options ?? []).includes(v);
	for (const [key, raw] of params) {
		const v = clean(raw);
		if (!v || key === "product") continue;
		const f = fillable.find((x) => x.name === key);
		if (f && fits(f, v) && !(f.name in out)) out[f.name] = v;
	}
	const product = clean(params.get("product") ?? "");
	if (product) {
		const named = fillable.find((f) => /^(product|subject|service|item)s?$/i.test(f.name) && !(f.name in out) && fits(f, product));
		const message = fillable.find((f) => f.type === "textarea" && !(f.name in out));
		if (named) out[named.name] = product;
		else if (message) out[message.name] = `I'm interested in: ${product}\n\n`;
	}
	return out;
}

type FieldEl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Fill every `form[data-form]` on the page from `location.search` (starter/src/scripts/site.ts calls it once). */
export function mountPrefill(doc: Document = document, search: string = location.search): void {
	const params = new URLSearchParams(search);
	if (!Array.from(params.keys()).length) return;
	const forms = doc.querySelectorAll("form[data-form]");
	for (let f = 0; f < forms.length; f++) {
		const form = forms.item(f);
		if (!(form instanceof HTMLFormElement)) continue;
		// Narrowed with instanceof, not a querySelectorAll<…> generic: the generated project's astro check rejects the
		// generic form for this union (found when scaffolding, 2026-11-22).
		const els: FieldEl[] = [];
		const found = form.querySelectorAll("input[name], textarea[name], select[name]");
		for (let i = 0; i < found.length; i++) {
			const el = found.item(i);
			if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) els.push(el);
		}
		const fields = els.map((el) => ({ name: el.name, type: el instanceof HTMLTextAreaElement ? "textarea" : el instanceof HTMLSelectElement ? "select" : (el.type || "text").toLowerCase(), value: el.value, ...(el instanceof HTMLSelectElement ? { options: Array.from(el.options).map((o) => o.value) } : {}) }));
		const plan = prefillPlan(params, fields);
		for (const el of els) if (el.name in plan && !el.value.trim()) el.value = plan[el.name] as string;
	}
}
