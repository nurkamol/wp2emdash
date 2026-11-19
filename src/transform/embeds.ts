/**
 * Embed sections whose widget markup does not carry its loader. Mariana Tek web integrations: the page holds only
 * mount points (`<div data-mariana-integrations="/schedule/daily">`); a site-wide snippet loads
 * `https://<tenant>.marianaiframes.com/polyfills` and `/js`, which fill them. The embed keeps the markup and gets the
 * two scripts (the starter's embed allowlist accepts *.marianaiframes.com), so the section works on its own.
 */
import type { Diagnostic, Section } from "../ir/schema.js";

const TENANT = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

/** The Mariana Tek tenant in HTML: a script src on <tenant>.marianaiframes.com, or the loader's TENANT_NAME. */
export function marianaTenant(html: string): string | undefined {
	const src = /https?:\/\/([a-z0-9.-]+)\.marianaiframes\.com\//i.exec(html)?.[1];
	if (src && TENANT.test(src.toLowerCase())) return src.toLowerCase();
	const named = /TENANT_NAME\s*=\s*['"]([a-z0-9.-]+)['"][\s\S]{0,600}marianaiframes\.com/i.exec(html)?.[1];
	return named && TENANT.test(named.toLowerCase()) ? named.toLowerCase() : undefined;
}

/** Mount-point markup + the tenant's loader scripts (kept when the markup already loads them). */
export function withMarianaLoader(html: string, tenant: string): string {
	if (/<script\b[^>]*marianaiframes\.com/i.test(html)) return html;
	return `${html.trim()}\n<script src="https://${tenant}.marianaiframes.com/polyfills"></script>\n<script src="https://${tenant}.marianaiframes.com/js"></script>`;
}

/** Give every Mariana Tek embed its loader; a missing tenant is reported (the widget would stay empty). */
export function completeMarianaEmbeds(sections: Section[], tenant: string | undefined): Diagnostic[] {
	const out: Diagnostic[] = [];
	for (const s of sections) {
		if (s.type !== "embed" || s.fields.provider !== "marianatek") continue;
		const own = marianaTenant(s.fields.html) ?? tenant;
		if (own) s.fields.html = withMarianaLoader(s.fields.html, own);
		else out.push({ level: "warn", code: "lossy", message: "Mariana Tek embed without a tenant: set embeds.marianatekTenant in kit.config.ts (the <tenant>.marianaiframes.com name), else the widget stays empty", path: s.sourceRef.path });
	}
	return out;
}
