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
}

/**
 * A css2 address Google answers. css2 refuses the whole request (400) when one family lacks a requested style or weight
 * (a script font with only regular 400, asked for 300–700 and italics), so each family is tried on its own: as asked,
 * then upright only, then the bare family (its default style). Families Google does not have are left out.
 */
export async function resolveGoogleHref(href: string, fetcher: typeof fetch = fetch): Promise<{ href?: string; dropped: string[]; reduced: string[] }> {
	const ok = async (u: string) => {
		try {
			const r = await fetcher(u, { headers: { "user-agent": UA } });
			await r.body?.cancel();
			return r.ok;
		} catch {
			return false;
		}
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
		const url = /url\((https:[^)]+\.woff2)\)/.exec(face as string)?.[1];
		if (!url) continue;
		const font = await fetcher(url, { headers: { "user-agent": UA } });
		if (!font.ok) continue;
		const bytes = Buffer.from(await font.arrayBuffer());
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
	return { css: `/* Self-hosted from Google Fonts by wp2emdash scaffold (latin, latin-ext). */\n${out.join("\n")}\n`, preload: [...new Set(preload)], files };
}
