/**
 * Inline-script lint for the generated project (scaffold gate `csp-inline`). The public Content-Security-Policy
 * (starter/src/middleware.ts) allows script files from the site and inline scripts only by their SHA-256 hash, so a
 * script that ends up inline in the HTML without a hash is blocked on the live site — and only verify's runtime check
 * would notice, after a deploy. The lint catches the ways it happens before the build:
 *
 * - `vite.build.assetsInlineLimit` not 0: Astro inlines a component `<script>` under 4 KB into the page.
 * - `<script define:vars>` (always inline) or `<script is:inline>` with code in its body.
 * - `<script is:inline set:html={x}>` where `x` is not imported from `scripts/inline/` (the files the middleware hashes).
 * - Inline event handler attributes (`onclick="…"`): blocked without 'unsafe-hashes'.
 *
 * Non-executable types (JSON-LD, JSON, import maps, templates) are fine: the CSP does not apply to them.
 */

export interface SourceFile {
	path: string;
	text: string;
}

const DATA_TYPE = /\stype=["'{]?\s*["']?(?:application\/(?:ld\+)?json|importmap|text\/(?:template|plain|html))/i;
const HANDLER = /<[a-zA-Z][\w:-]*\b[^>]*?\son[a-z]+\s*=\s*["'{]/g;

/** Problems found, one line each ("path: …"); empty when every inline script is allowed. */
export function lintInlineScripts(files: SourceFile[], astroConfig: string): string[] {
	const problems: string[] = [];
	if (!/assetsInlineLimit\s*:\s*0\b/.test(astroConfig)) problems.push("astro.config.mjs: vite.build.assetsInlineLimit is not 0 (Astro inlines component scripts under 4 KB, which the CSP blocks)");
	for (const f of files) {
		if (!f.path.endsWith(".astro")) continue;
		// The template part only (after the frontmatter), without comments.
		const fm = /^---\n[\s\S]*?\n---\n/.exec(f.text);
		const frontmatter = fm?.[0] ?? "";
		const body = f.text.slice(frontmatter.length).replace(/<!--[\s\S]*?-->/g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
		const inlineImports = new Set([...frontmatter.matchAll(/import\s+(\w+)\s+from\s+["'][^"']*scripts\/inline\/[^"']+\?raw["']/g)].map((m) => m[1] as string));
		const line = (i: number) => body.slice(0, i).split("\n").length + (frontmatter ? frontmatter.split("\n").length - 1 : 0);
		for (const m of body.matchAll(/<script\b([^>]*?)(\/>|>([\s\S]*?)<\/script>)/g)) {
			const attrs = m[1] ?? "";
			const code = (m[3] ?? "").trim();
			const at = `${f.path}:${line(m.index ?? 0)}`;
			if (DATA_TYPE.test(attrs)) continue;
			if (/\bdefine:vars\b/.test(attrs)) {
				problems.push(`${at}: <script define:vars> is always inline (pass values through data- attributes instead)`);
				continue;
			}
			const setHtml = /set:html=\{\s*(\w+)\s*\}/.exec(attrs);
			if (setHtml) {
				if (!inlineImports.has(setHtml[1] as string)) problems.push(`${at}: inline script from {${setHtml[1]}}, not a scripts/inline/ file the middleware hashes`);
				continue;
			}
			if (/\bis:inline\b/.test(attrs) && !/\ssrc=/.test(attrs) && code) problems.push(`${at}: <script is:inline> with code (move it to a file, or to scripts/inline/ and hash it in the middleware)`);
		}
		for (const m of body.matchAll(HANDLER)) problems.push(`${f.path}:${line(m.index ?? 0)}: inline event handler (${/\s(on[a-z]+)\s*=/.exec(m[0])?.[1]}) is blocked by the CSP; add a listener in a script file`);
	}
	return problems;
}
