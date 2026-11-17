/** Fill dynamic tokens inside Portable Text spans ({year} from WordPress footers). */
type Block = { _type: string; children?: { text?: string }[] };
export function fillTokens<T extends Block>(blocks: T[] | null | undefined): T[] {
	const year = String(new Date().getFullYear());
	return (blocks ?? []).map((b) => (b.children ? { ...b, children: b.children.map((c) => (typeof c.text === "string" && c.text.includes("{year}") ? { ...c, text: c.text.replaceAll("{year}", year) } : c)) } : b));
}

export const hasContent = (blocks: unknown[] | null | undefined) => Array.isArray(blocks) && blocks.length > 0;
