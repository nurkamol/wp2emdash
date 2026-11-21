/**
 * Self-host Google Fonts (OFL/Apache, which allow it): fetch the css2 stylesheet as a modern browser would (woff2),
 * keep the latin and latin-ext subsets, download those files into the project's public/fonts, and return the
 * @font-face CSS pointing at them plus the files worth preloading. No request to Google at visit time: faster first
 * render (no extra connection), no font-swap layout shift from late fonts, no visitor IPs sent to Google.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const KEEP = /^(latin|latin-ext)$/;

export interface SelfHostedFonts {
	css: string;
	/** Public paths of the files to preload (body regular, display at its heading weight), latin subset. */
	preload: string[];
	files: number;
	/** The CSS Google answered with (kept for the report when a family is missing). */
	source: string;
}

/**
 * A css2 address Google answers. css2 refuses the whole request (400) when one family lacks a requested style or weight
 * (a script font with only regular 400, asked for 300–700 and italics), so each family is tried on its own: as asked,
 * then upright only, then the bare family (its default style). Families Google does not have are left out.
 */
export async function resolveGoogleHref(href: string, fetcher: typeof fetch = fetch): Promise<{ href?: string; dropped: string[]; reduced: string[] }> {
	// Google answers 400 for a family or style it does not have; only that counts as "not on Google Fonts". A network
	// error or a 5xx is retried, then thrown: the caller keeps the whole href rather than dropping a font that exists
	// (a dropped body font once reached production after one failed request).
	const ok = async (u: string): Promise<boolean> => {
		let last = "";
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const r = await fetcher(u, { headers: { "user-agent": UA } });
				await r.body?.cancel();
				if (r.ok) return true;
				if (r.status >= 400 && r.status < 500 && r.status !== 429) return false;
				last = `HTTP ${r.status}`;
			} catch (e) {
				last = (e as Error).message;
			}
		}
		throw new Error(`Google Fonts did not answer (${last}): ${u}`);
	};
	if (await ok(href)) return { href, dropped: [], reduced: [] };
	const u = new URL(href);
	const specs = u.searchParams.getAll("family");
	const display = u.searchParams.get("display");
	const kept: string[] = [];
	const dropped: string[] = [];
	const reduced: string[] = [];
	const enc = (spec: string) => `family=${encodeURIComponent(spec).replace(/%20/g, "+").replace(/%3A/gi, ":").replace(/%2C/gi, ",").replace(/%40/g, "@").replace(/%3B/gi, ";")}`;
	const base = `${u.origin}${u.pathname}?`;
	for (const spec of specs) {
		const [name = "", axes = ""] = spec.split(":");
		const upright = /^ital,wght@/.test(axes) ? `${name}:wght@${axes.replace(/^ital,wght@/, "").split(";").filter((x) => x.startsWith("0,")).map((x) => x.slice(2)).join(";")}` : undefined;
		const tries = [spec, ...(upright ? [upright] : []), name];
		let found: string | undefined;
		for (const t of tries) if (await ok(`${base}${enc(t)}`)) {
			found = t;
			break;
		}
		if (!found) dropped.push(name);
		else {
			kept.push(found);
			if (found !== spec) reduced.push(`${name} (${found === name ? "default style only" : "upright only"})`);
		}
	}
	return { ...(kept.length ? { href: `${base}${kept.map(enc).join("&")}${display ? `&display=${display}` : ""}` } : {}), dropped, reduced };
}

export async function selfHostGoogleFonts(href: string, publicDir: string, want: { body: string; display: string; displayWeight: number }, fetcher: typeof fetch = fetch): Promise<SelfHostedFonts | undefined> {
	const res = await fetcher(href, { headers: { "user-agent": UA } });
	if (!res.ok) return undefined;
	const css = await res.text();
	// Google prefixes each @font-face with a /* subset */ comment.
	const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)].filter((m) => KEEP.test(m[1] as string));
	if (!blocks.length) return undefined;
	const dir = join(publicDir, "fonts");
	mkdirSync(dir, { recursive: true });
	const out: string[] = [];
	const preload: string[] = [];
	let files = 0;
	for (const [, subset, face] of blocks) {
		// The woff2 file: usually ".../s/<font>/<v>/<hash>.woff2", but Google also answers (about one request in ten,
		// measured 2026-11-22) with a dynamic ".../l/font?kit=…&skey=…" address without the extension — still woff2
		// (format('woff2')). Missing those once dropped a site's body font.
		const url = (/url\((https:\/\/[^)\s]+)\)\s*format\(\s*['"]woff2['"]\s*\)/.exec(face as string)?.[1] ?? /url\((https:[^)]+\.woff2)\)/.exec(face as string)?.[1])?.replace(/&amp;/g, "&");
		// Never skip a face silently (a build once shipped without its body font): an answer the kit cannot read fails
		// self-hosting, and the caller keeps the Google Fonts link.
		if (!url) throw new Error(`unexpected @font-face from Google Fonts (no woff2 file): ${(face as string).replace(/\s+/g, " ").slice(0, 160)}`);
		const font = await fetcher(url, { headers: { "user-agent": UA } });
		// A font file that cannot be fetched fails the whole step (the caller keeps the Google Fonts link): a site
		// silently missing one of its fonts is worse than one loading them from Google.
		if (!font.ok) throw new Error(`font file ${url} answered HTTP ${font.status}`);
		const bytes = Buffer.from(await font.arrayBuffer());
		if (bytes.length < 4 || bytes.toString("latin1", 0, 4) !== "wOF2") throw new Error(`font file ${url} is not a woff2 font`);
		const name = `${createHash("sha1").update(bytes).digest("hex").slice(0, 12)}.woff2`;
		writeFileSync(join(dir, name), bytes);
		files++;
		const local = `/fonts/${name}`;
		out.push(`/* ${subset} */\n${(face as string).replace(url, local)}`);
		const family = /font-family:\s*'([^']+)'/.exec(face as string)?.[1];
		const style = /font-style:\s*(\w+)/.exec(face as string)?.[1];
		const weight = Number(/font-weight:\s*(\d+)/.exec(face as string)?.[1]);
		if (subset === "latin" && style === "normal" && ((family === want.body && weight === 400) || (family === want.display && weight === want.displayWeight))) preload.push(local);
	}
	return { css: `/* Self-hosted from Google Fonts by wp2emdash scaffold (latin, latin-ext). */\n${out.join("\n")}\n`, preload: [...new Set(preload)], files, source: css };
}

/**
 * The Adobe Fonts (Typekit) web project the live site loads, as its CSS embed (`https://use.typekit.net/<id>.css`, a
 * <link> or an @import). Adobe's licence ties the fonts to the project, so the kit keeps the embed instead of
 * self-hosting (audit: "keep"). The older JavaScript embed (`<id>.js` + `Typekit.load()`) is reported, not converted.
 */
export function typekitKit(htmls: string[]): { href?: string; jsKit?: string } {
	let jsKit: string | undefined;
	for (const html of htmls) {
		const css = /https:\/\/use\.typekit\.net\/([a-z0-9]{5,12})\.css\b/i.exec(html);
		if (css) return { href: `https://use.typekit.net/${(css[1] as string).toLowerCase()}.css` };
		jsKit ??= /(?:https:)?\/\/use\.typekit\.net\/([a-z0-9]{5,12})\.js\b/i.exec(html)?.[1];
	}
	return jsKit ? { jsKit } : {};
}

/** Families a css2 href asks for that the self-hosted CSS does not contain (none = every font made it). */
export function missingFamilies(href: string, hosted: string[]): string[] {
	const asked = new URL(href).searchParams.getAll("family").map((f) => (f.split(":")[0] ?? "").trim()).filter(Boolean);
	const have = new Set(hosted.map((f) => f.toLowerCase()));
	return asked.filter((f) => !have.has(f.toLowerCase()));
}
