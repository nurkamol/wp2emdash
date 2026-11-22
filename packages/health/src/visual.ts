/**
 * The visual check run (checks/visual.ts): weekly from 10:00 UTC, at once the first time (that run is the baseline),
 * or soon after an admin's "Check now". It runs from the cron tick after the checks — and only in a tick where the
 * PageSpeed test did not run, so the cron hook stays inside its 150 s timeout — and spends at most VISUAL_BUDGET (8)
 * requests a tick, 4 at a time with an 8 s limit each (≤ ~24 s): a 10-page run takes a few ticks. The job lives in
 * KV `visual:job` between ticks; its own lock (`visual:lock`) keeps it single-flight.
 *
 * When it finishes: pages saved in the editor since their baseline (EmDash content `updatedAt`, one sorted list call
 * per collection) take their new look as the baseline unless something is broken; everything else is compared, the
 * last 8 runs are kept, and pages that are broken or changed go out as ONE alert email through the normal alert path
 * (one per issue per day, held before go-live and on staging). Nothing on the public site is changed or purged.
 *
 * Not on staging (the production Worker watches the production site) and paused while coming-soon mode shows the
 * holding page.
 *
 * Page review (review.ts): while each page's HTML is in hand, the accessibility rules (checks/a11y.ts) and the
 * freshness scan (checks/freshness.ts) read it too — no extra request — and the job keeps their short findings. When
 * the run finishes, one `content.list` pass over the pages adds dates in the pages' text and "not updated" pages, and
 * the grouped result is stored in KV `review` for the Accessibility and Content freshness tabs and "What to improve".
 * No email for these (weekly noise).
 */
import { visualAlertEvents } from "./alerts.js";
import { inspectA11y } from "./checks/a11y.js";
import { inspectFreshness, STALE_MONTHS } from "./checks/freshness.js";
import { finishRun, needsLook, pickVisualPages, readJob, readVisual, startVisual, stepVisual, VISUAL_LOCK_MS, VISUAL_PAGES, visualDue, type VisualJob, type VisualRun, type VisualStore } from "./checks/visual.js";
import type { HealthOptions } from "./index.js";
import { buildReview, FRESHNESS_COLLECTIONS, listEntries, type PageNotes, type ReviewStore } from "./review.js";
import { maintenanceActive, type MaintenanceSetting } from "./maintenance.js";
import type { Fetcher } from "./probe.js";
import { acquireLock, type ContentLister, deliverAlerts, releaseLock, type RunDeps } from "./run.js";
import { KEYS, readState } from "./store.js";

export interface VisualDeps extends RunDeps {
	/** The Worker's static assets (Astro's ASSETS binding), for stylesheets the site itself answers 404 for. */
	assets?: Fetcher;
}

export interface VisualResult {
	ran: boolean;
	why?: "off" | "staging" | "not-due" | "paused" | "locked";
	/** Pages read this tick, and in the whole run so far. */
	progress?: { done: number; pages: number; requests: number };
	run?: VisualRun;
	alerts?: { sent: number; held: number; notEmailed?: string };
}

const norm = (p: string) => p.replace(/\/+$/, "") || "/";
/** An entry's address: the kit keeps the WordPress path as the slug; the front page is "home" (starter entryHref). */
const slugPath = (slug: string | null | undefined) => {
	const s = String(slug ?? "").replace(/^\/+|\/+$/g, "");
	return !s || s === "home" ? "/" : `/${s}`;
};

/**
 * When each checked page was last saved in the editor, if after `since`: one `content.list` per collection, newest
 * first (`orderBy: { updatedAt: "desc" }`, EmDash 1.5 ContentListOptions), at most 3 pages of 100, stopping at the
 * first entry older than `since`. Never throws (no content access → no auto-update).
 */
export async function editedSince(content: ContentLister | undefined, collections: string[], paths: string[], since: string | undefined): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	if (!content || !since) return out;
	const wanted = new Set(paths.map(norm));
	for (const collection of collections) {
		try {
			let cursor: string | undefined;
			for (let page = 0; page < 3; page++) {
				const r = await content.list(collection, { limit: 100, orderBy: { updatedAt: "desc" }, ...(cursor ? { cursor } : {}) });
				let older = false;
				for (const item of r.items) {
					if (!item.updatedAt || item.updatedAt <= since) {
						older = true;
						break;
					}
					const p = slugPath(item.slug);
					if (wanted.has(p) && (!out.get(p) || (out.get(p) as string) < item.updatedAt)) out.set(p, item.updatedAt);
				}
				if (older || !r.hasMore || !r.cursor) break;
				cursor = r.cursor;
			}
		} catch {
			// A collection that does not exist on this site, or an older EmDash without orderBy: skip.
		}
	}
	return out;
}

/** What the visual check also reads from each page's HTML (accessibility, freshness); undefined when both are off. */
export function pageInspector(o: Pick<HealthOptions, "accessibility" | "freshness">, now: number): ((path: string, html: string) => PageNotes) | undefined {
	const a11y = o.accessibility !== false;
	const fresh = o.freshness !== false;
	if (!a11y && !fresh) return undefined;
	return (_path, html) => ({ ...(a11y ? { a11y: inspectA11y(html) } : {}), ...(fresh ? { stale: inspectFreshness(html, now) } : {}) });
}

/** The page review of a finished run (review.ts): the job's notes plus one pass over the pages' content. Never throws. */
export async function reviewOf(d: Pick<RunDeps, "options" | "content" | "log">, job: VisualJob, now: number): Promise<ReviewStore | undefined> {
	const o = d.options;
	if (o.accessibility === false && o.freshness === false) return undefined;
	try {
		const fresh = o.freshness !== false;
		const { entries, read } = fresh ? await listEntries(d.content, FRESHNESS_COLLECTIONS, now) : { entries: [], read: false };
		const notes = Object.fromEntries(Object.entries(job.notes ?? {}).map(([p, n]) => [p, fresh ? n : { ...(n.a11y ? { a11y: n.a11y } : {}) }]));
		return buildReview({ notes, order: job.paths, entries, contentRead: read, now, staleMonths: fresh ? (o.staleMonths ?? STALE_MONTHS) : 0, accessibility: o.accessibility !== false });
	} catch (e) {
		d.log?.warn?.("health page review failed", { error: e instanceof Error ? e.name : "error" });
		return undefined;
	}
}

export async function runVisual(d: VisualDeps): Promise<VisualResult> {
	const { kv, env, options: o, now } = d;
	const cap = o.visualPages ?? VISUAL_PAGES;
	if (cap <= 0) return { ran: false, why: "off" };
	if (env.STAGING === "1") return { ran: false, why: "staging" };
	const [stored, rawJob, request, maintenance] = await Promise.all([kv.get<unknown>(KEYS.visual), kv.get<unknown>(KEYS.visualJob), kv.get<{ at: string; done?: string }>(KEYS.visualRequest), kv.get<MaintenanceSetting>(KEYS.maintenance)]);
	const store = readVisual(stored);
	let job = readJob(rawJob);
	if (maintenanceActive(maintenance, now)) return { ran: false, why: "paused" };
	if (!job) {
		const due = visualDue(store, request, now);
		if (!due) return { ran: false, why: "not-due" };
		const state = await readState(kv);
		job = startVisual(pickVisualPages(state.sitemap?.paths ?? [], Object.keys(store.baseline), cap), due, now);
	}
	if (!(await acquireLock(kv, now, KEYS.visualLock, VISUAL_LOCK_MS))) return { ran: false, why: "locked" };
	try {
		const origin = new URL(o.productionUrl).origin;
		const inspect = pageInspector(o, Date.parse(job.startedAt));
		const step = await stepVisual(job, { self: d.self, external: d.fetch, ...(d.assets ? { assets: d.assets } : {}), origin, ...(inspect ? { inspect } : {}) });
		const progress = { done: step.job.pi, pages: step.job.paths.length, requests: step.requests };
		if (!step.done) {
			await kv.set(KEYS.visualJob, step.job);
			return { ran: true, progress };
		}
		// Page review first (its own content pass), then the visual comparison.
		const review = await reviewOf(d, step.job, now);
		if (review) {
			await d.kv.set(KEYS.review, review satisfies ReviewStore);
			// Counts only: no page text.
			d.log?.info("health page review", { pages: review.pages, a11y: review.a11y.length, stale: review.stale.length, content: review.content });
		}
		const since = Object.values(store.baseline)
			.map((b) => b.at)
			.sort()[0];
		const edited = await editedSince(d.content, o.collections ?? ["pages"], step.job.paths, since);
		const { store: next, run } = finishRun(store, step.job, { now, pre: !o.live, edited });
		await kv.set(KEYS.visual, next satisfies VisualStore);
		await kv.delete(KEYS.visualJob);
		const latest = await kv.get<{ at: string; done?: string }>(KEYS.visualRequest);
		if (latest && !latest.done) await kv.set(KEYS.visualRequest, { ...latest, done: run.at });
		const alerts = await deliverAlerts(d, visualAlertEvents(o.siteName, needsLook(run)));
		// Counts only: no page text.
		const look = needsLook(run);
		d.log?.info("health visual check", { trigger: run.trigger, pages: run.pages.length, problems: look.problems.length, changes: look.changes.length, updated: run.pages.filter((p) => p.state === "updated").length, baseline: run.pages.filter((p) => p.state === "baseline").length });
		return { ran: true, progress, run, alerts };
	} finally {
		await releaseLock(kv, KEYS.visualLock);
	}
}
