/**
 * WordPress reusable blocks / synced patterns (`wp_block` posts) → EmDash sections (`_emdash_sections`, source
 * "import"): a library of Portable Text an editor inserts with the rich-text editor's /section command (verified in
 * EmDash 1.5.0, docs/spikes/p2-batch-findings.md). Pages keep the block inlined where WordPress used it (the Gutenberg
 * adapter), as before; the section is the reusable copy for new content. EmDash inserts a copy, so a section is not
 * synced like a WordPress synced pattern: editing the section later does not change pages that already use it.
 */
import type { Diagnostic } from "../ir/schema.js";
import { type BodyOptions, convertPostBody } from "./blog.js";

export interface WpBlockPost {
	id: number;
	slug: string;
	title: string;
	status: string;
	content: string;
}

export interface IrReusableSection {
	/** EmDash section slug (`/^[a-z0-9-]+$/`): `wp-` + the WordPress slug. */
	slug: string;
	title: string;
	wpId: number;
	/** Portable Text (media marked `_media`, resolved by load like post bodies). */
	content: { _type: string; _key: string; [k: string]: unknown }[];
	diagnostics: Diagnostic[];
}

export interface SectionsPlan {
	sections: IrReusableSection[];
	/** wp_block posts not written as sections, and why (drafts, empty). */
	skipped: { wpId: number; title: string; why: string }[];
}

const sectionSlug = (slug: string, id: number) => `wp-${(slug || `block-${id}`).toLowerCase().normalize("NFKD").replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || `block-${id}`}`;

/** Published reusable blocks with content, converted through EmDash's Gutenberg converter after the kit's shortcode pass. */
export function planSections(blocks: WpBlockPost[], opts: Omit<BodyOptions, "keyPrefix">): SectionsPlan {
	const out: SectionsPlan = { sections: [], skipped: [] };
	const used = new Set<string>();
	for (const b of [...blocks].sort((x, y) => x.id - y.id)) {
		const title = b.title?.trim() || `Reusable block ${b.id}`;
		if (b.status !== "publish") {
			out.skipped.push({ wpId: b.id, title, why: `status ${b.status}` });
			continue;
		}
		if (!b.content?.trim()) {
			out.skipped.push({ wpId: b.id, title, why: "empty" });
			continue;
		}
		const { body, diagnostics } = convertPostBody(b.content, /<!--\s+wp:/.test(b.content) ? "gutenberg" : "classic", { ...opts, keyPrefix: `s${b.id.toString(36)}_` });
		if (!body.length) {
			out.skipped.push({ wpId: b.id, title, why: "nothing the converter keeps" });
			continue;
		}
		let slug = sectionSlug(b.slug, b.id);
		if (used.has(slug)) slug = `${slug}-${b.id}`;
		used.add(slug);
		out.sections.push({ slug, title, wpId: b.id, content: body as IrReusableSection["content"], diagnostics });
	}
	return out;
}

/** Coverage report lines (titles of the blocks: editor-facing labels, no personal data). */
export function sectionsReport(plan: SectionsPlan): string[] {
	if (!plan.sections.length && !plan.skipped.length) return [];
	const L = ["", "## Reusable blocks → EmDash sections", "", `${plan.sections.length} reusable block(s) become EmDash sections (admin → Sections; inserted with the rich-text editor's /section command). Pages keep each block inlined where it was used. EmDash inserts a copy: a section is not synced like a WordPress synced pattern.`];
	if (plan.sections.length) {
		L.push("", "| Section | From reusable block | Notes |", "|---|---|---|");
		for (const s of plan.sections) L.push(`| \`${s.slug}\` | ${s.title.replace(/\|/g, "\\|")} (#${s.wpId}) | ${s.diagnostics.filter((d) => d.level !== "info").map((d) => d.message.replace(/\|/g, "\\|")).slice(0, 3).join("; ") || "—"} |`);
	}
	if (plan.skipped.length) L.push("", `Not written as sections: ${plan.skipped.map((s) => `${s.title} (#${s.wpId}, ${s.why})`).join(", ")}.`);
	return L;
}
