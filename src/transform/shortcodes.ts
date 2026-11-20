/**
 * Shortcodes in content (coverage report → "Shortcodes", ir/shortcodes.json): every plugin/theme shortcode the adapters
 * met that is not a page-builder element, with what migration did (src/adapters/shortcodes.ts registry), how often,
 * and a sample page. Built from the documents' diagnostics, so the table and the transform gate agree (form shortcodes
 * the builder adapters map directly become form sections and are not listed).
 */
import { shortcodeAction } from "../adapters/shortcodes.js";
import type { IrPage } from "../ir/schema.js";

export interface ShortcodeUse {
	name: string;
	/** form | breadcrumbs | strip | widget | media | unknown */
	action: string;
	count: number;
	pages: string[];
	/** Blocks the transform gate (unknown, content widgets, forms in posts, broken media). */
	blocking: boolean;
}

export interface ShortcodeSummary {
	/** A breadcrumb shortcode was on a page: the theme's breadcrumbs should replace it. */
	breadcrumbs: boolean;
	used: ShortcodeUse[];
}

const NAME = /^shortcode \[([^\]\s]+)\]|^shortcode kept as text: \[\/?([a-zA-Z][\w-]*)/;

export function shortcodeSummary(docs: { doc: Pick<IrPage, "diagnostics" | "source" | "route">; published: boolean }[]): ShortcodeSummary {
	const by = new Map<string, ShortcodeUse>();
	const add = (name: string, page: string, blocking: boolean) => {
		const a = shortcodeAction(name);
		const e = by.get(name) ?? { name, action: a?.do ?? "unknown", count: 0, pages: [], blocking: false };
		e.count++;
		if (!e.pages.includes(page)) e.pages.push(page);
		e.blocking ||= blocking;
		by.set(name, e);
	};
	for (const { doc } of docs) {
		const page = doc.route?.path ?? doc.source.slug;
		for (const d of doc.diagnostics) {
			const m = NAME.exec(d.message);
			if (m) add(m[1] ?? m[2] ?? "", page, d.level === "error" && !!d.carriesContent);
		}
	}
	const used = [...by.values()].sort((a, b) => Number(b.blocking) - Number(a.blocking) || b.count - a.count || a.name.localeCompare(b.name));
	return { breadcrumbs: used.some((u) => u.action === "breadcrumbs"), used };
}

export function shortcodesReport(s: ShortcodeSummary): string[] {
	if (!s.used.length) return [];
	const what: Record<string, string> = { form: "form section", breadcrumbs: "left out; theme breadcrumbs (flagged)", strip: "wrapper removed, content kept", widget: "not rebuilt (reported)", media: "rebuilt (core media)", unknown: "❌ unknown: output not rebuilt" };
	return [
		"",
		"## Shortcodes",
		"",
		"Plugin and theme shortcodes found in content (page-builder elements are in the sections above). Registry: `src/adapters/shortcodes.ts`.",
		"",
		"| Shortcode | Done | Count | Sample page | Blocks the gate |",
		"|---|---|---|---|---|",
		...s.used.map((u) => `| \`[${u.name}]\` | ${what[u.action] ?? u.action} | ${u.count} | ${u.pages[0] ?? ""}${u.pages.length > 1 ? ` (+${u.pages.length - 1})` : ""} | ${u.blocking ? "yes" : "no"} |`),
		...(s.breadcrumbs ? ["", "A breadcrumb shortcode was used: `ir/shortcodes.json` has `breadcrumbs: true` for the theme's breadcrumbs."] : []),
	];
}
