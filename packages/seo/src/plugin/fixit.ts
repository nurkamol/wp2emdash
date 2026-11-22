/**
 * SEO fix-it admin page (Block Kit, `/seo-fixit`, under the SEO plugin's `admin` route: editors and admins). Drafts
 * meta descriptions, focus keywords and (optionally) SEO titles with Workers AI for the pages the analysis flags, and
 * lists them for review: edit, Approve or Discard per page, or Approve all shown. Pure logic lives in ../fixit.ts.
 */
import type { SeoPanelOptions } from "../index.js";
import { purgePages, type PurgeApi, type PurgeResult } from "../analytics/store.js";
import {
	type AiBinding,
	AiLicenseError,
	addUsage,
	approve,
	buildPrompt,
	type Candidate,
	candidates,
	type ContentApi,
	DEFAULT_DAILY_LIMIT,
	DEFAULT_FIXIT_MODEL,
	draftOne,
	edited,
	FIXIT_BATCH,
	KEYS,
	leftToday,
	nextBatch,
	pruneDiscarded,
	prunePending,
	type ReportPage,
	stillUseful,
	type Suggestion,
	toSuggestion,
	type Usage,
	validate,
} from "../fixit.js";
import { keywordKey, type SeoCtx } from "./collect.js";

type Block = Record<string, unknown>;
type Toast = { message: string; type: "success" | "error" | "info" };

export const FIXIT_PAGE = "/seo-fixit";
/** Who may use it: editors and admins — the roles that can edit any page's SEO fields today (`content:edit_any`). */
export const EDITOR_ROLE = 40;
/** Suggestions shown for review at once (and what "Approve all shown" approves). */
export const REVIEW_SHOW = 10;
/** Pages drafted at the same time inside one action. */
const PARALLEL = 3;

export interface FixitOptions {
	/** Workers AI text model (default DEFAULT_FIXIT_MODEL). */
	model?: string;
	/** Drafts per UTC day (default 100 ≈ 5,500 neurons, about half the free daily allocation). */
	dailyLimit?: number;
	/** Offer SEO titles that are too long or short by default. */
	titles?: boolean;
}

export interface FixitDeps {
	ai?: AiBinding;
	cache?: PurgeApi;
	now?: number;
}

interface Interaction {
	type?: string;
	action_id?: string;
	block_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pathOf = (slug: string | null) => (slug && slug !== "home" && slug !== "index" ? `/${slug}/` : "/");
const purgeNote = (r: PurgeResult) => (r === "purged" ? " Live pages update within a few seconds." : r === "failed" ? " Cached pages could not be refreshed right now: they show the change within the hour." : "");

export interface FixitState {
	ai: "ok" | "missing" | "licence";
	model: string;
	pending: Suggestion[];
	queue: Candidate[];
	tooShort: { title: string; words: number }[];
	left: number;
	limit: number;
	titles: boolean;
	counts: { description: number; keyword: number; title: number };
}

/** Handles a fix-it interaction and returns the page. `pages`: the SEO report's pages (published ones are used). */
export async function fixitRoute(ctx: SeoCtx & { content?: SeoCtx["content"] & { update?: ContentApi["update"] } }, o: SeoPanelOptions, pages: ReportPage[], i: Interaction, deps: FixitDeps): Promise<{ blocks: Block[]; toast?: Toast }> {
	if ((ctx.user?.role ?? 0) < EDITOR_ROLE) return { blocks: [{ type: "banner", title: "Editors and administrators only", description: "SEO fix-it changes pages' search descriptions. Ask an editor or an administrator.", variant: "alert" }] };
	const f: FixitOptions = (o.fixit === false ? undefined : o.fixit) ?? {};
	const now = deps.now ?? Date.now();
	const model = f.model?.trim() || DEFAULT_FIXIT_MODEL;
	const limit = Math.max(0, Math.min(1000, f.dailyLimit ?? DEFAULT_DAILY_LIMIT));
	const act = i.action_id ?? "";
	let toast: Toast | undefined;

	// Stored state, within bounds (expired and no-longer-needed suggestions drop out on every visit).
	const storedPending = await ctx.kv.get<unknown>(KEYS.pending);
	let pending = prunePending(storedPending, now).filter((s) => stillUseful(s, pages));
	let discarded = pruneDiscarded(await ctx.kv.get<unknown>(KEYS.discarded), now);
	if (JSON.stringify(pending) !== JSON.stringify(storedPending ?? [])) await ctx.kv.set(KEYS.pending, pending);
	let titles = (await ctx.kv.get<{ titles?: boolean }>(KEYS.prefs))?.titles ?? !!f.titles;
	let licence = !!(await ctx.kv.get<{ needsAgreement?: boolean }>(KEYS.ai))?.needsAgreement;
	let usage = await ctx.kv.get<Usage>(KEYS.usage);

	const content = ctx.content as ContentApi | undefined;
	const approveRows = async (rows: { s: Suggestion; values: Suggestion["suggested"] }[]) => {
		if (!content) return { message: "Pages cannot be read here.", type: "error" as const };
		const r = await approve(content, ctx.kv, rows, keywordKey);
		const done = new Set(r.written.map((w) => w.sid));
		pending = pending.filter((s) => !done.has(s.sid));
		await ctx.kv.set(KEYS.pending, pending);
		const purged = r.written.some((w) => w.fields.some((x) => x !== "keyword")) ? await purgePages(deps.cache) : "no-cache";
		ctx.log?.info("seo fix-it approved", { written: r.written.length, skipped: r.skipped.length, purge: purged });
		const parts = [r.written.length ? `Saved for ${plural(r.written.length, "page")}.${purgeNote(purged)}` : "", ...r.skipped.map((s) => `${s.page}: ${s.reason}`)].filter(Boolean);
		return { message: parts.join(" ") || "Nothing to save.", type: (r.skipped.length ? (r.written.length ? "info" : "error") : "success") as Toast["type"] };
	};

	if (act === "fx-approve" && i.type === "form_submit") {
		const sid = /^fx:(.+)$/.exec(i.block_id ?? "")?.[1];
		const s = pending.find((x) => x.sid === sid);
		toast = s ? await approveRows([{ s, values: edited(s, i.values) }]) : { message: "That suggestion is no longer waiting.", type: "info" };
	} else if (act === "fx-approve-all") {
		const shown = pending.slice(0, REVIEW_SHOW);
		toast = shown.length ? await approveRows(shown.map((s) => ({ s, values: edited(s, undefined) }))) : { message: "No suggestions to approve.", type: "info" };
	} else if (act === "fx-discard" && typeof i.value === "string") {
		const s = pending.find((x) => x.sid === i.value);
		if (s) {
			pending = pending.filter((x) => x.sid !== s.sid);
			discarded = pruneDiscarded([{ sid: s.sid, at: new Date(now).toISOString() }, ...discarded], now);
			await ctx.kv.set(KEYS.pending, pending);
			await ctx.kv.set(KEYS.discarded, discarded);
			toast = { message: `Discarded the suggestion for ${s.page}. It is not drafted again for 30 days.`, type: "success" };
		}
	} else if (act === "fx-draft") {
		if (i.type === "form_submit") {
			titles = i.values?.titles === true;
			await ctx.kv.set(KEYS.prefs, { titles });
		}
		const ai = deps.ai;
		if (!ai) toast = { message: "Workers AI is not connected to this site (see the note on the page).", type: "error" };
		else if (licence) toast = { message: "The AI model needs its licence accepted first (see the note on the page).", type: "error" };
		else {
			const { ready } = candidates(pages, titles);
			const batch = nextBatch(ready, pending, discarded, FIXIT_BATCH, leftToday(usage, limit, now));
			if (!batch.length) toast = { message: leftToday(usage, limit, now) ? "No page needs a draft right now." : `Today's limit of ${limit} drafts is reached (it keeps Workers AI within its free daily allocation). Try again tomorrow.`, type: "info" };
			else {
				const r = await draftBatch(ai, model, o, ctx.site.name, batch, now);
				usage = addUsage(usage, r.calls, now);
				await ctx.kv.set(KEYS.usage, usage);
				if (r.licence) {
					licence = true;
					await ctx.kv.set(KEYS.ai, { needsAgreement: true, at: new Date(now).toISOString() });
				}
				if (r.added.length) {
					pending = prunePending([...r.added, ...pending], now);
					await ctx.kv.set(KEYS.pending, pending);
				}
				ctx.log?.info("seo fix-it drafted", { pages: batch.length, added: r.added.length, failed: r.failed, model });
				toast = r.licence
					? { message: "The AI model refused: its licence must be accepted once for this Cloudflare account.", type: "error" }
					: { message: `${plural(r.added.length, "suggestion")} drafted${r.failed ? `; ${plural(r.failed, "page")} could not be drafted` : ""}. Review them below: nothing is saved until you approve.`, type: r.added.length ? "success" : "error" };
			}
		}
	} else if (act === "fx-licence-reset") {
		licence = false;
		await ctx.kv.set(KEYS.ai, { needsAgreement: false });
		toast = { message: "Will try the model again on the next draft.", type: "info" };
	}

	const { ready, tooShort } = candidates(pages, titles);
	const waiting = new Set([...pending.map((s) => s.sid), ...discarded.map((d) => d.sid)]);
	const state: FixitState = {
		ai: !deps.ai ? "missing" : licence ? "licence" : "ok",
		model,
		pending,
		queue: ready.filter((c) => !waiting.has(`${c.collection}:${c.id}`)),
		tooShort,
		left: leftToday(usage, limit, now),
		limit,
		titles,
		counts: { description: ready.filter((c) => c.needs.description).length, keyword: ready.filter((c) => c.needs.keyword).length, title: ready.filter((c) => c.needs.title).length },
	};
	return { blocks: fixitView(state), ...(toast ? { toast } : {}) };
}

/** Drafts a batch (a few pages at a time). AI errors other than a licence refusal only skip that page. */
export async function draftBatch(ai: AiBinding, model: string, o: Pick<SeoPanelOptions, "lang">, site: string, batch: Candidate[], now: number): Promise<{ added: Suggestion[]; failed: number; calls: number; licence: boolean }> {
	const added: Suggestion[] = [];
	let failed = 0;
	let calls = 0;
	let licence = false;
	for (let k = 0; k < batch.length && !licence; k += PARALLEL) {
		await Promise.all(
			batch.slice(k, k + PARALLEL).map(async (c) => {
				calls++;
				try {
					const messages = buildPrompt({ site, lang: o.lang ?? c.locale, title: c.title, path: pathOf(c.slug), text: c.text, wantTitle: c.needs.title });
					const s = toSuggestion(c, validate(await draftOne(ai, model, messages), c), model, now);
					if (s) added.push(s);
					else failed++;
				} catch (e) {
					if (e instanceof AiLicenseError) licence = true;
					failed++;
				}
			}),
		);
	}
	return { added, failed, calls, licence };
}

// ── View ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const what = (n: { description: boolean; keyword: boolean; title: boolean }) => [n.description ? "description" : "", n.keyword ? "focus keyword" : "", n.title ? "SEO title" : ""].filter(Boolean).join(", ");

export function fixitView(s: FixitState): Block[] {
	const shown = s.pending.slice(0, REVIEW_SHOW);
	const aiBlocks: Block[] =
		s.ai === "missing"
			? [
					{ type: "banner", title: "Workers AI is not connected", description: "Drafting needs the Worker's Workers AI binding. Suggestions already drafted can still be reviewed below.", variant: "alert" },
					{ type: "section", text: 'To switch it on: add "ai": { "binding": "AI" } to wrangler.jsonc (at the top level, and in env.staging if the site has staging), then deploy again. Sites built with the kit get it on the next scaffold unless they handle sensitive data (kit.config sensitiveData), where your developer adds it by hand after checking that published pages hold nothing private.' },
				]
			: s.ai === "licence"
				? [
						{ type: "banner", title: "The AI model needs its licence accepted", description: `Cloudflare refused ${s.model} until its licence is accepted once for this account (Workers AI → Models in the Cloudflare dashboard). Then press Try again.`, variant: "alert" },
						{ type: "actions", elements: [{ type: "button", action_id: "fx-licence-reset", label: "Try again", style: "secondary" }] },
					]
				: [];
	return [
		{ type: "header", text: "SEO fix-it" },
		{ type: "context", text: "Drafts the missing search descriptions and focus keywords (and, if you like, better SEO titles) from each published page's own title and text, with Cloudflare Workers AI. Only public text of published pages is sent; it is not stored. Nothing changes on the site until you approve a suggestion." },
		...aiBlocks,
		{
			type: "stats",
			items: [
				{ label: "Pages without a description", value: s.counts.description },
				{ label: "Pages without a focus keyword", value: s.counts.keyword },
				...(s.titles ? [{ label: "SEO titles to improve", value: s.counts.title }] : []),
				{ label: "Waiting for review", value: s.pending.length },
				{ label: "Drafts left today", value: `${s.left}/${s.limit}` },
			],
		},
		...(s.ai === "ok"
			? [
					{
						type: "form",
						block_id: "fx-draft",
						fields: [{ type: "toggle", action_id: "titles", label: "Also suggest SEO titles that are too long or too short", initial_value: s.titles }],
						submit: { label: `Draft suggestions (up to ${Math.min(FIXIT_BATCH, s.left)} pages)`, action_id: "fx-draft" },
					},
				]
			: []),
		...(s.queue.length || s.tooShort.length
			? [
					{ type: "header", text: `Pages to draft (${s.queue.length})` },
					{
						type: "table",
						block_id: "fx-queue",
						page_action_id: "noop",
						empty_text: "Every page that needs something has a suggestion waiting.",
						columns: [
							{ key: "page", label: "Page" },
							{ key: "missing", label: "Missing" },
						],
						rows: s.queue.slice(0, 25).map((c) => ({ page: c.title, missing: what(c.needs) })),
					},
					...(s.queue.length > 25 ? [{ type: "context", text: `And ${s.queue.length - 25} more. Each press drafts ${FIXIT_BATCH}.` }] : []),
					...(s.tooShort.length ? [{ type: "context", text: `Not drafted, too little text to describe honestly (under 40 words): ${s.tooShort.slice(0, 5).map((t) => t.title).join(", ")}${s.tooShort.length > 5 ? ` and ${s.tooShort.length - 5} more` : ""}. Add text to these pages first.` }] : []),
				]
			: []),
		{ type: "header", text: `Review suggestions (${s.pending.length})` },
		...(shown.length
			? [
					{ type: "context", text: "Edit any box, then Approve or Discard each page. Approving saves the page's SEO fields: they are not part of page drafts or revisions, so on a published page the new description and title are live right away (the page content is not touched). Empty a box to leave that field out. Suggestions expire after 30 days." },
					{ type: "actions", elements: [{ type: "button", action_id: "fx-approve-all", label: `Approve all shown (${shown.length})`, style: "primary", confirm: { title: `Approve ${plural(shown.length, "suggestion")}?`, text: "The suggestions shown are saved as drafted (edits typed into the boxes are not included: use a page's own Approve for those). Descriptions and titles go live on the published pages right away.", confirm: "Approve all", deny: "Cancel" } }] },
					...shown.flatMap((x) => reviewRow(x)),
					...(s.pending.length > shown.length ? [{ type: "context", text: `${s.pending.length - shown.length} more waiting: they appear here as you approve or discard these.` }] : []),
				]
			: [{ type: "empty", title: "Nothing to review", description: s.ai === "ok" && s.queue.length ? "Press Draft suggestions to get the first ones." : "No suggestions are waiting.", size: "sm" }]),
	];
}

function reviewRow(x: Suggestion): Block[] {
	const fields: Block[] = [];
	if (x.suggested.description !== undefined) fields.push({ type: "text_input", action_id: "description", label: `Meta description (${x.suggested.description.length} characters; aim for 120–160)`, initial_value: x.suggested.description, multiline: true });
	if (x.suggested.keyword !== undefined) fields.push({ type: "text_input", action_id: "keyword", label: "Focus keyword (words from the page)", initial_value: x.suggested.keyword });
	if (x.suggested.title !== undefined) fields.push({ type: "text_input", action_id: "title", label: `SEO title (${x.suggested.title.length} characters; at most 60)`, initial_value: x.suggested.title });
	return [
		{ type: "divider" },
		{ type: "section", text: `${x.page} — ${pathOf(x.slug)}` },
		{
			type: "fields",
			fields: [
				...(x.suggested.description !== undefined ? [{ label: "Current description", value: x.current.description || "None" }] : []),
				...(x.suggested.keyword !== undefined ? [{ label: "Current focus keyword", value: x.current.keyword || "None" }] : []),
				...(x.suggested.title !== undefined ? [{ label: "Current SEO title", value: x.current.title || "None (the page title is used)" }] : []),
			],
		},
		...(x.notes.length ? [{ type: "context", text: x.notes.join(" ") }] : []),
		{ type: "form", block_id: `fx:${x.sid}`, fields, submit: { label: "Approve", action_id: "fx-approve" } },
		{ type: "actions", elements: [{ type: "button", action_id: "fx-discard", label: "Discard", style: "secondary", value: x.sid }] },
	];
}

/** Overview line on the SEO dashboard. */
export function fixitLink(counts: { description: number; keyword: number }): Block[] {
	if (!counts.description && !counts.keyword) return [];
	return [
		{ type: "section", text: `${[counts.description ? plural(counts.description, "page") + " without a search description" : "", counts.keyword ? plural(counts.keyword, "page") + " without a focus keyword" : ""].filter(Boolean).join(", ")}. SEO fix-it drafts them for you to review.` },
		{ type: "actions", elements: [{ type: "link", label: "Open SEO fix-it", target: { kind: "plugin-page", path: FIXIT_PAGE }, appearance: "secondary" }] },
	];
}

