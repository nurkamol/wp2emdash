/**
 * /llms.txt (llmstxt.org): a short Markdown map of the site for AI assistants — the site's name and tagline, then its
 * public pages (and newest posts) with their meta descriptions. Only indexable, published, unprotected entries.
 * No imports: this file loads in Node (kit tests) and in the Worker.
 */
export interface LlmsEntry {
	title: string;
	url: string;
	description?: string;
}

const line = (s: string) => s.replace(/\s+/g, " ").trim();

export function llmsTxt(site: { name: string; tagline?: string; description?: string }, pages: LlmsEntry[], posts: LlmsEntry[] = []): string {
	const out = [`# ${line(site.name)}`, ""];
	const summary = line(site.description || site.tagline || "");
	if (summary) out.push(`> ${summary}`, "");
	const list = (heading: string, items: LlmsEntry[]) => {
		if (!items.length) return;
		out.push(`## ${heading}`, "");
		for (const e of items) out.push(`- [${line(e.title).replace(/[[\]]/g, "")}](${e.url})${e.description ? `: ${line(e.description)}` : ""}`);
		out.push("");
	};
	list("Pages", pages);
	list("Posts", posts);
	return `${out.join("\n").trimEnd()}\n`;
}

/** Entries that belong in llms.txt: indexable and not behind a password. */
export function llmsListed(robots: string | null | undefined, data: { access_password?: unknown }): boolean {
	return !/noindex/i.test(robots ?? "") && !(typeof data.access_password === "string" && data.access_password.trim());
}
