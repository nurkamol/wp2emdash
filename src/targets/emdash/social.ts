/**
 * Load's sharing-text step: IR `seo.social` (per entry) and `ir/term-seo.json` (per term archive) → the SEO plugin's
 * stores through its `seo-import` route (@wp2emdash/seo, plugin/index.ts), 200 items per request.
 *
 * - Entries: Open Graph / Twitter title and description, and the Twitter image when it differs from the Open Graph one.
 *   The Open Graph image is the entry's EmDash SEO image (written with the entry), so it is not stored twice.
 * - Terms: SEO title, description, noindex and all sharing fields (EmDash terms have no SEO fields of their own).
 * - Images are sent as media library file addresses (uploaded by the media step); one not uploaded is left out.
 * - A value an editor saved in the admin is kept by the route ("kept" in the detail), so reruns never undo edits.
 */
import type { IrPage } from "../../ir/schema.js";
import type { TermSeoPlan } from "../../transform/term-meta.js";
import type { EmDashApi } from "./api.js";

export interface SocialPayload {
	entries: { collection: string; id: string; social: Record<string, string> }[];
	terms: ({ taxonomy: string; slug: string; label: string; noindex?: boolean } & Record<string, unknown>)[];
}

const TEXT = ["ogTitle", "ogDescription", "twitterTitle", "twitterDescription"] as const;

/** Every image URL the stores will hold (to upload with the other media). */
export function socialImageUrls(docs: IrPage[], terms: TermSeoPlan | undefined): string[] {
	const out = new Set<string>();
	for (const d of docs) {
		const s = d.seo.social;
		if (s?.twitterImage && s.twitterImage !== (s.ogImage ?? d.seo.ogImage)) out.add(s.twitterImage);
	}
	for (const t of terms?.terms ?? []) for (const u of [t.ogImage, t.twitterImage]) if (u) out.add(u);
	return [...out];
}

/**
 * What to send: entries already on the target (`entryOf`) with sharing text, and every carried term. `mediaUrl` maps a
 * WordPress image URL to its media library file address (undefined = not uploaded: left out).
 */
export function socialPayload(docs: IrPage[], terms: TermSeoPlan | undefined, entryOf: (d: IrPage) => { collection: string; id: string } | undefined, mediaUrl: (u: string) => string | undefined): SocialPayload {
	const payload: SocialPayload = { entries: [], terms: [] };
	for (const d of docs) {
		const s = d.seo.social;
		const e = s ? entryOf(d) : undefined;
		if (!s || !e) continue;
		const social: Record<string, string> = {};
		for (const k of TEXT) if (s[k]) social[k] = s[k] as string;
		const tw = s.twitterImage && s.twitterImage !== (s.ogImage ?? d.seo.ogImage) ? mediaUrl(s.twitterImage) : undefined;
		if (tw) social.twitterImage = tw;
		if (Object.keys(social).length) payload.entries.push({ collection: e.collection, id: e.id, social });
	}
	for (const t of terms?.terms ?? []) {
		const og = t.ogImage ? mediaUrl(t.ogImage) : undefined;
		const tw = t.twitterImage ? mediaUrl(t.twitterImage) : undefined;
		payload.terms.push({ taxonomy: t.taxonomy, slug: t.slug, label: t.label, ...(t.title ? { title: t.title } : {}), ...(t.description ? { description: t.description } : {}), ...(t.noindex ? { noindex: true } : {}), ...Object.fromEntries(TEXT.filter((k) => t[k]).map((k) => [k, t[k]])), ...(og ? { ogImage: og } : {}), ...(tw ? { twitterImage: tw } : {}) });
	}
	return payload;
}

type Counts = { written: number; kept: number; rejected: number };
export type SocialApi = Pick<EmDashApi, "seoImport">;

export async function loadSocial(api: SocialApi, payload: SocialPayload): Promise<{ ok: boolean; detail: string }> {
	const total = { entries: { written: 0, kept: 0, rejected: 0 } as Counts, terms: { written: 0, kept: 0, rejected: 0 } as Counts };
	const add = (a: Counts, b: Counts | undefined) => {
		a.written += b?.written ?? 0;
		a.kept += b?.kept ?? 0;
		a.rejected += b?.rejected ?? 0;
	};
	try {
		for (let i = 0; i < Math.max(payload.entries.length, payload.terms.length); i += 200) {
			const r = await api.seoImport({ entries: payload.entries.slice(i, i + 200), terms: payload.terms.slice(i, i + 200) });
			if (r.error) return { ok: false, detail: r.error };
			add(total.entries, r.entries);
			add(total.terms, r.terms);
		}
	} catch (e) {
		const code = (e as { code?: string }).code;
		return { ok: false, detail: code === "NOT_FOUND" ? "the SEO plugin's import route (@wp2emdash/seo 0.3) is not on the target: rerun scaffold, then restart the dev server or deploy" : code === "INSUFFICIENT_SCOPE" ? "the API token needs the admin scope (plugin routes)" : (e as Error).message };
	}
	const part = (name: string, c: Counts) => `${name}: ${c.written} written${c.kept ? `, ${c.kept} kept (edited in the admin)` : ""}${c.rejected ? `, ${c.rejected} rejected` : ""}`;
	return { ok: total.entries.rejected + total.terms.rejected === 0, detail: `${part("pages", total.entries)}; ${part("archives", total.terms)}` };
}
