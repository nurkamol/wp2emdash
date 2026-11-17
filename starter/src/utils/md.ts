/**
 * Markdown subset for text fields inside repeaters (EmDash repeaters have no rich text):
 * blank-line paragraphs, "- " / "1. " lists, **bold**, *italic*, [label](href), line breaks.
 * Everything is HTML-escaped first; only these constructs produce markup.
 */
import { safeHref } from "./links";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
	return esc(s)
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label: string, href: string) => {
			const h = safeHref(href.replace(/&amp;/g, "&"));
			return h ? `<a href="${esc(h)}"${/^https?:/i.test(h) ? ' rel="noopener"' : ""}>${label}</a>` : label;
		})
		.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
		.replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
		.replace(/\{year\}/g, String(new Date().getFullYear()))
		.replace(/\n/g, "<br>");
}

export function md(text: string | null | undefined): string {
	if (!text) return "";
	return text
		.replace(/\r\n/g, "\n")
		.split(/\n\s*\n/)
		.map((chunk) => chunk.trim())
		.filter(Boolean)
		.map((chunk) => {
			const lines = chunk.split("\n");
			if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ""))}</li>`).join("")}</ul>`;
			if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`).join("")}</ol>`;
			return `<p>${inline(chunk)}</p>`;
		})
		.join("");
}

/** Plain text (for FAQ structured data). */
export function mdPlain(text: string | null | undefined): string {
	return (text ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\*\*?([^*]+)\*\*?/g, "$1").replace(/^\s*[-*]\s+/gm, "").trim();
}
