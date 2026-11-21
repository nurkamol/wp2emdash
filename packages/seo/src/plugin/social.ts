/**
 * Editing sharing text (page editor SEO panel) and archive SEO (dashboard tab "Archives"). Stored in the plugin's KV
 * (social.ts); every save purges the cached pages (the analytics/settings tags every page carries), so the head tags
 * change within seconds. A value saved here is marked "editor": the kit's load never overwrites it.
 */
import { purgePages, type PurgeApi, type PurgeResult } from "../analytics/store.js";
import { type ArchiveBase, cleanSocial, cleanTermSeo, hasSocial, hasTermSeo, parseSocial, parseTermSeo, type SocialText, socialKey, type StoredSocial, type StoredTermSeo, termKey } from "../social.js";
import type { SeoCtx } from "./collect.js";

type Block = Record<string, unknown>;
export type Toast = { message: string; type: "success" | "error" | "info" };
interface Interaction {
	type?: string;
	action_id?: string;
	block_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}
type Who = { user?: { name?: string | null; email?: string } };
const who = (ctx: Who) => (ctx.user?.name || ctx.user?.email || "an editor").slice(0, 80);

function purgeNote(r: PurgeResult): string {
	if (r === "purged") return " Live pages update within a few seconds.";
	if (r === "no-cache") return "";
	return " Cached pages could not be refreshed right now: they show the change within the hour.";
}

const socialFields = (s: SocialText, fallback: { title?: string; description?: string }) => [
	{ type: "text_input", action_id: "ogTitle", label: "Sharing title (Facebook, LinkedIn, messengers)", placeholder: fallback.title || "The SEO title", ...(s.ogTitle ? { initial_value: s.ogTitle } : {}) },
	{ type: "text_input", action_id: "ogDescription", label: "Sharing description", multiline: true, placeholder: fallback.description || "The meta description", ...(s.ogDescription ? { initial_value: s.ogDescription } : {}) },
	{ type: "text_input", action_id: "ogImage", label: "Sharing image address (optional)", placeholder: "The SEO image, or the sharing card", ...(s.ogImage ? { initial_value: s.ogImage } : {}) },
	{ type: "text_input", action_id: "twitterTitle", label: "X (Twitter) title", placeholder: "Same as the sharing title", ...(s.twitterTitle ? { initial_value: s.twitterTitle } : {}) },
	{ type: "text_input", action_id: "twitterDescription", label: "X (Twitter) description", multiline: true, placeholder: "Same as the sharing description", ...(s.twitterDescription ? { initial_value: s.twitterDescription } : {}) },
	{ type: "text_input", action_id: "twitterImage", label: "X (Twitter) image address (optional)", placeholder: "Same as the sharing image", ...(s.twitterImage ? { initial_value: s.twitterImage } : {}) },
];

const IMAGE_HELP = "Image addresses: a full https:// address, or a media library file address (/_emdash/api/media/file/…: open the image in Media and copy its address).";

// ── Page editor panel ─────────────────────────────────────────────────────────────────────────────────────────────

/** The "Social sharing" part of the SEO panel. `fallback`: the entry's SEO title and description (what shows when empty). */
export function socialPanel(stored: StoredSocial | undefined, fallback: { title?: string; description?: string }): Block[] {
	const s = stored ?? {};
	const from = stored ? (stored.source === "editor" ? `Last saved by ${stored.updatedBy ?? "an editor"}.` : "Carried over from the old site.") : "";
	return [
		{ type: "divider" },
		{
			type: "accordion",
			label: `Social sharing${stored ? " (custom)" : ""}`,
			default_open: false,
			blocks: [
				{ type: "context", text: `What a link to this page shows on social networks and in messengers. Empty fields use the SEO title, description and image. ${from}`.trim() },
				{ type: "form", block_id: "social", fields: socialFields(s, fallback), submit: { label: "Save sharing text", action_id: "social" } },
				{ type: "context", text: IMAGE_HELP },
			],
		},
	];
}

/** Saves (or clears) an entry's sharing text from the panel form. */
export async function saveSocial(ctx: Pick<SeoCtx, "kv"> & Who, entry: { collection: string; id: string }, values: Record<string, unknown> | undefined, cache: PurgeApi | undefined): Promise<{ stored?: StoredSocial; toast: Toast }> {
	const raw = values ?? {};
	const bad = (["ogImage", "twitterImage"] as const).filter((k) => typeof raw[k] === "string" && (raw[k] as string).trim() && !cleanSocial({ [k]: raw[k] })[k]);
	if (bad.length) return { stored: parseSocial(await ctx.kv.get(socialKey(entry.collection, entry.id))), toast: { message: `Not saved: the image address is not a full https:// address or a media library file address.`, type: "error" } };
	const s = cleanSocial(raw);
	const key = socialKey(entry.collection, entry.id);
	let stored: StoredSocial | undefined;
	if (hasSocial(s)) {
		stored = { ...s, source: "editor", updatedAt: new Date().toISOString(), updatedBy: who(ctx) };
		await ctx.kv.set(key, stored);
	} else await (ctx.kv as { delete?(k: string): Promise<boolean> }).delete?.(key);
	const purged = await purgePages(cache);
	return { ...(stored ? { stored } : {}), toast: { message: `${stored ? "Sharing text saved." : "Sharing text removed: the SEO title and description are used."}${purgeNote(purged)}`, type: purged === "failed" ? "info" : "success" } };
}

// ── Dashboard tab "Archives" ─────────────────────────────────────────────────────────────────────────────────────

export interface ArchiveTerm {
	taxonomy: string;
	slug: string;
	label: string;
	/** Archive address (base + slug). */
	path: string;
}
export interface ArchivesState {
	archives: readonly ArchiveBase[];
	/** Every term of the archived taxonomies (taxonomies:read), when EmDash gave them. */
	terms: ArchiveTerm[];
	stored: StoredTermSeo[];
}

const pathOf = (archives: readonly ArchiveBase[], taxonomy: string, slug: string) => {
	const base = archives.find((a) => a.taxonomy === taxonomy)?.base ?? `/${taxonomy}/`;
	return `${base.replace(/\/?$/, "/")}${slug}/`;
};

/** Stored archive SEO and the terms of the archived taxonomies. */
export async function archivesState(ctx: SeoCtx & { taxonomies?: { getTerms(t: string): Promise<{ slug: string; label: string }[]> } }, archives: readonly ArchiveBase[]): Promise<ArchivesState> {
	const listed = (await ctx.kv.list?.("term:").catch(() => [])) ?? [];
	const stored = listed.map((r) => parseTermSeo(r.value)).filter((x): x is StoredTermSeo => !!x);
	const terms: ArchiveTerm[] = [];
	for (const a of archives) {
		const list = (await ctx.taxonomies?.getTerms(a.taxonomy).catch(() => [])) ?? [];
		for (const t of list.slice(0, 500)) terms.push({ taxonomy: a.taxonomy, slug: t.slug, label: t.label, path: pathOf(archives, a.taxonomy, t.slug) });
	}
	return { archives, terms, stored };
}

export function archivesTab(s: ArchivesState): Block[] {
	if (!s.archives.length) return [{ type: "context", text: "This site has no category, tag or collection archives." }];
	const known = new Set(s.stored.map((t) => `${t.taxonomy}:${t.slug}`));
	const options = [...s.terms.map((t) => ({ label: `${t.label} (${t.path})`, value: `${t.taxonomy}:${t.slug}` })), ...s.stored.filter((t) => !s.terms.some((x) => x.taxonomy === t.taxonomy && x.slug === t.slug)).map((t) => ({ label: `${t.label ?? t.slug} (${pathOf(s.archives, t.taxonomy, t.slug)})`, value: `${t.taxonomy}:${t.slug}` }))].slice(0, 500);
	return [
		{ type: "context", text: "Search title, description and sharing text of category, tag and other archive pages. Archives without their own use the term's name and description." },
		{
			type: "table",
			block_id: "term-seo",
			page_action_id: "noop",
			empty_text: "No archive has its own SEO text yet.",
			columns: [
				{ key: "path", label: "Archive" },
				{ key: "title", label: "SEO title" },
				{ key: "description", label: "Meta description" },
				{ key: "index", label: "Search engines", format: "badge" },
				{ key: "from", label: "From" },
			],
			rows: s.stored.map((t) => ({ path: pathOf(s.archives, t.taxonomy, t.slug), title: t.title ?? "—", description: t.description ?? "—", index: t.noindex ? "Hidden" : "Shown", from: t.source === "editor" ? (t.updatedBy ?? "editor") : "old site" })),
		},
		...(options.length
			? [
					{
						type: "form",
						block_id: "term-pick",
						fields: [{ type: "select", action_id: "term", label: `Archive to edit (${known.size} with their own text)`, options, initial_value: options[0]?.value }],
						submit: { label: "Edit", action_id: "term-pick" },
					},
				]
			: [{ type: "context", text: "No terms found." }]),
	];
}

export function termEditView(archives: readonly ArchiveBase[], taxonomy: string, slug: string, label: string, s: Partial<StoredTermSeo> = {}, errors: string[] = []): Block[] {
	const path = pathOf(archives, taxonomy, slug);
	return [
		{ type: "header", text: `Archive SEO: ${label}` },
		{ type: "context", text: path },
		...(errors.length ? [{ type: "banner", title: "Not saved", description: errors.join(" "), variant: "error" }] : []),
		{
			type: "form",
			block_id: `term-edit:${taxonomy}:${slug}`,
			fields: [
				{ type: "text_input", action_id: "title", label: "SEO title (the whole browser-tab title)", placeholder: label, ...(s.title ? { initial_value: s.title } : {}) },
				{ type: "text_input", action_id: "description", label: "Meta description", multiline: true, placeholder: "The term's description", ...(s.description ? { initial_value: s.description } : {}) },
				{ type: "toggle", action_id: "noindex", label: "Hide from search engines (noindex)", initial_value: !!s.noindex },
				...socialFields(s, { ...(s.title ? { title: s.title } : {}), ...(s.description ? { description: s.description } : {}) }),
			],
			submit: { label: "Save", action_id: "term-save" },
		},
		{ type: "context", text: IMAGE_HELP },
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "term-cancel", label: "Back", style: "secondary" },
				...(s.source ? [{ type: "button", action_id: "term-clear", label: "Remove", style: "danger", value: `${taxonomy}:${slug}`, confirm: { title: `Remove the SEO text of ${label}?`, text: "The archive then uses the term's name and description.", confirm: "Remove", deny: "Keep it", style: "danger" } }] : []),
			],
		},
	];
}

const splitKey = (v: unknown) => {
	const m = typeof v === "string" ? /^([a-z][a-z0-9_]{0,62}):([^\s:]{1,200})$/.exec(v) : null;
	return m ? { taxonomy: m[1] as string, slug: m[2] as string } : undefined;
};

/**
 * A `term-*` action from the Archives tab. Returns a view to show instead of the dashboard (the edit form), or the
 * toast to show with the dashboard (Archives tab).
 */
export async function termAction(ctx: SeoCtx & Who, state: ArchivesState, i: Interaction, cache: PurgeApi | undefined): Promise<{ view: Block[]; toast?: Toast } | { toast?: Toast }> {
	const act = i.action_id ?? "";
	const labelOf = (taxonomy: string, slug: string) => state.terms.find((t) => t.taxonomy === taxonomy && t.slug === slug)?.label ?? state.stored.find((t) => t.taxonomy === taxonomy && t.slug === slug)?.label ?? slug;
	if (act === "term-cancel") return {};
	if (act === "term-pick") {
		const k = splitKey(i.values?.term);
		if (!k) return { toast: { message: "Choose an archive first.", type: "info" } };
		const s = parseTermSeo(await ctx.kv.get(termKey(k.taxonomy, k.slug)));
		return { view: termEditView(state.archives, k.taxonomy, k.slug, labelOf(k.taxonomy, k.slug), s) };
	}
	if (act === "term-clear") {
		const k = splitKey(i.value);
		if (!k) return {};
		await (ctx.kv as { delete?(k: string): Promise<boolean> }).delete?.(termKey(k.taxonomy, k.slug));
		const purged = await purgePages(cache);
		return { toast: { message: `Archive SEO text removed.${purgeNote(purged)}`, type: purged === "failed" ? "info" : "success" } };
	}
	if (act === "term-save") {
		const k = splitKey((i.block_id ?? "").replace(/^term-edit:/, ""));
		if (!k || !(i.block_id ?? "").startsWith("term-edit:")) return { toast: { message: "That archive is no longer in the list.", type: "info" } };
		const v = i.values ?? {};
		const label = labelOf(k.taxonomy, k.slug);
		const s = cleanTermSeo({ ...v, noindex: v.noindex === true });
		const badImage = (["ogImage", "twitterImage"] as const).some((f) => typeof v[f] === "string" && (v[f] as string).trim() && !s[f]);
		if (badImage) return { view: termEditView(state.archives, k.taxonomy, k.slug, label, { ...s }, ["An image address must be a full https:// address or a media library file address."]), toast: { message: "Not saved. See the message on the page.", type: "error" } };
		const key = termKey(k.taxonomy, k.slug);
		if (hasTermSeo(s)) await ctx.kv.set(key, { taxonomy: k.taxonomy, slug: k.slug, label, ...s, source: "editor", updatedAt: new Date().toISOString(), updatedBy: who(ctx) } satisfies StoredTermSeo);
		else await (ctx.kv as { delete?(k: string): Promise<boolean> }).delete?.(key);
		const purged = await purgePages(cache);
		return { toast: { message: `${hasTermSeo(s) ? `SEO text of ${label} saved.` : `${label} uses its name and description again.`}${purgeNote(purged)}`, type: purged === "failed" ? "info" : "success" } };
	}
	return {};
}
