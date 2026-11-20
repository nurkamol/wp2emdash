/**
 * Broken links. Daily: every page in the sitemap is read (through the Worker itself) and every link (<a href>) to the
 * site is checked once — pages by their own answer, other addresses with HEAD (GET when HEAD is not allowed). The
 * check is resumable: each tick does at most LINK_BUDGET requests, three at a time, and stores where it is.
 *
 * Weekly, on top: up to EXTERNAL_SAMPLE links to other sites, a different sample each week, HEAD only (GET when HEAD
 * is refused), no cookies, no referrer — the one kind of request that leaves the site's own host and Cloudflare/Google
 * (kit.config health.externalLinks: false turns it off). A 404/410 or no answer counts as broken; 401/403/429 (bot
 * protection) is reported as "could not check", never as broken.
 */
import { type Fetcher, pool, probe } from "../probe.js";
import type { BrokenLink, CheckState, LinkLedger, LinksResult } from "../store.js";
import { hash32, plural, shortUrl } from "../util.js";

export const MAX_PAGES = 300;
export const MAX_LINKS = 1000;
const MAX_EXTERNAL = 200;
const SKIP_PATHS = /^\/(?:_emdash|cdn-cgi|api)\//;

export interface LinkJob {
	startedAt: string;
	pages: string[];
	/** Next page to read. */
	pi: number;
	/** Internal URLs found, still to check. */
	queue: string[];
	/** Checked internal URLs → HTTP status (0 = no answer). */
	status: Record<string, number>;
	/** URL → pages linking to it (paths, at most 3). */
	on: Record<string, string[]>;
	/** Links to other sites found on the pages. */
	external: string[];
	/** This run also checks a sample of external links (weekly). */
	withExternal: boolean;
	/** The sample, once chosen, and its results. */
	sample?: string[];
	ext?: Record<string, number>;
}

const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** Every <a href> of a page, split into the site's own URLs (absolute, no fragment) and other sites' http(s) URLs. */
export function extractLinks(html: string, pageUrl: string, productionUrl: string): { internal: string[]; external: string[] } {
	const host = bare(new URL(productionUrl).host);
	const origin = new URL(productionUrl).origin;
	const internal = new Set<string>();
	const external = new Set<string>();
	// Comments and scripts are not links.
	const text = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script\b[\s\S]*?<\/script>/gi, "");
	for (const m of text.matchAll(/<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
		const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim().replace(/&amp;/g, "&");
		if (!raw || raw.startsWith("#") || /^(?:mailto|tel|sms|javascript|data|whatsapp|fax):/i.test(raw)) continue;
		let u: URL;
		try {
			u = new URL(raw, pageUrl);
		} catch {
			continue;
		}
		if (u.protocol !== "http:" && u.protocol !== "https:") continue;
		u.hash = "";
		if (bare(u.host) === host) {
			if (SKIP_PATHS.test(u.pathname)) continue;
			internal.add(`${origin}${u.pathname}${u.search}`);
		} else external.add(u.toString());
	}
	return { internal: [...internal], external: [...external] };
}

export function startJob(paths: string[], productionUrl: string, withExternal: boolean, now: number): LinkJob {
	const origin = new URL(productionUrl).origin;
	return { startedAt: new Date(now).toISOString(), pages: paths.slice(0, MAX_PAGES).map((p) => `${origin}${p}`), pi: 0, queue: [], status: {}, on: {}, external: [], withExternal };
}

const addOn = (job: LinkJob, url: string, page: string) => {
	const list = job.on[url] ?? [];
	if (list.length < 3 && !list.includes(page)) job.on[url] = [...list, page];
};

const isBroken = (status: number) => status === 0 || status >= 400;
const externalBroken = (status: number) => status === 0 || status === 404 || status === 410;
const externalUnknown = (status: number) => !externalBroken(status) && status >= 400;

/** Picks this week's sample of external links: a different, stable subset each week. Pure. */
export function externalSample(urls: string[], now: number, n: number): string[] {
	const week = Math.floor(now / (7 * 86_400_000));
	return [...new Set(urls)].sort((a, b) => hash32(`${week}:${a}`) - hash32(`${week}:${b}`)).slice(0, n);
}

/**
 * One step: at most `budget` requests. Returns the job (mutated copy) and whether it is finished. `self` reaches the
 * site through the Worker; `external` is the plain fetch (other hosts).
 */
export async function stepJob(input: LinkJob, deps: { self: Fetcher; external: Fetcher; productionUrl: string; budget: number; concurrency: number; sample: number; now: number }): Promise<{ job: LinkJob; done: boolean; requests: number }> {
	const job: LinkJob = structuredClone(input);
	let left = deps.budget;
	const host = new URL(deps.productionUrl).host;
	// 1. Read pages (their own status, and their links).
	while (left > 0 && job.pi < job.pages.length) {
		const batch = job.pages.slice(job.pi, job.pi + Math.min(left, deps.concurrency));
		job.pi += batch.length;
		left -= batch.length;
		const results = await pool(batch, deps.concurrency, (u) => probe(deps.self, u, { body: true }));
		for (const r of results) {
			job.status[r.url] = r.status;
			if (!r.html) continue;
			const page = shortUrl(r.url, host);
			const { internal, external } = extractLinks(r.html, r.url, deps.productionUrl);
			for (const u of internal) {
				addOn(job, u, page);
				if (!(u in job.status) && !job.queue.includes(u) && !job.pages.includes(u) && Object.keys(job.status).length + job.queue.length < MAX_LINKS) job.queue.push(u);
			}
			for (const u of external) {
				addOn(job, u, page);
				if (job.external.length < MAX_EXTERNAL && !job.external.includes(u)) job.external.push(u);
			}
		}
	}
	// 2. Check the other internal addresses found.
	while (left > 0 && job.pi >= job.pages.length && job.queue.length) {
		const batch = job.queue.splice(0, Math.min(left, deps.concurrency));
		left -= batch.length;
		const results = await pool(batch, deps.concurrency, async (u) => {
			let r = await probe(deps.self, u, { method: "HEAD" });
			if (r.status === 405 || r.status === 501) r = await probe(deps.self, u);
			return r;
		});
		for (const r of results) job.status[r.url] = r.status;
	}
	// 3. Weekly: a sample of links to other sites.
	if (left > 0 && job.pi >= job.pages.length && !job.queue.length && job.withExternal) {
		job.sample ??= externalSample(job.external, deps.now, deps.sample);
		job.ext ??= {};
		const todo = job.sample.filter((u) => !(u in (job.ext as Record<string, number>))).slice(0, left);
		left -= todo.length;
		const results = await pool(todo, deps.concurrency, async (u) => {
			let r = await probe(deps.external, u, { method: "HEAD", redirect: "follow" });
			if ([403, 405, 501].includes(r.status)) r = await probe(deps.external, u, { redirect: "follow" });
			return r;
		});
		for (const r of results) (job.ext as Record<string, number>)[r.url] = r.status;
	}
	const internalDone = job.pi >= job.pages.length && !job.queue.length;
	const externalDone = !job.withExternal || (!!job.sample && job.sample.every((u) => u in (job.ext ?? {})));
	return { job, done: internalDone && externalDone, requests: deps.budget - left };
}

/** The finished job as a result: broken links with the pages that link to them. Pure. */
export function resultOf(job: LinkJob, productionUrl: string, now: number): LinksResult {
	const host = new URL(productionUrl).host;
	const broken: BrokenLink[] = Object.entries(job.status)
		.filter(([, s]) => isBroken(s))
		.map(([url, status]) => ({ url: shortUrl(url, host), status, on: job.on[url] ?? [] }));
	const ext = job.ext ?? {};
	const extBroken = Object.entries(ext)
		.filter(([, s]) => externalBroken(s))
		.map(([url, status]) => ({ url, status, on: job.on[url] ?? [], external: true }));
	return {
		at: new Date(now).toISOString(),
		pages: job.pages.length,
		checked: Object.keys(job.status).length,
		broken: [...broken, ...extBroken].slice(0, 200),
		...(job.withExternal ? { external: { at: new Date(now).toISOString(), checked: Object.keys(ext).length, broken: extBroken.length, unchecked: Object.values(ext).filter(externalUnknown).length } } : {}),
	};
}

/**
 * Updates the ledger with a finished check: new broken links get their first-seen time, links no longer broken their
 * fixed time. External links are only judged in weeks they were sampled. Returns the links that are new. Pure.
 */
export function updateLedger(ledger: LinkLedger, r: LinksResult, now: number, sampledExternal: boolean): { ledger: LinkLedger; fresh: BrokenLink[] } {
	const at = new Date(now).toISOString();
	const out: LinkLedger = {};
	const cutoff = now - 400 * 86_400_000;
	for (const [k, v] of Object.entries(ledger)) if (!v.fixed || Date.parse(v.fixed) >= cutoff) out[k] = v;
	const fresh: BrokenLink[] = [];
	const now_ = new Set(r.broken.map((b) => b.url));
	for (const b of r.broken) {
		const e = out[b.url];
		if (!e || e.fixed) {
			out[b.url] = { first: at, ...(b.external ? { external: true } : {}) };
			fresh.push(b);
		}
	}
	for (const [url, e] of Object.entries(out)) {
		if (e.fixed || now_.has(url)) continue;
		if (e.external && !sampledExternal) continue;
		out[url] = { ...e, fixed: at };
	}
	return { ledger: out, fresh };
}

export function linksCheck(r: LinksResult | null, running: { pages: number; done: number } | undefined, at: string): CheckState {
	if (!r) return { status: "unknown", summary: running ? `First check running: ${running.done} of ${plural(running.pages, "page")} read.` : "Not checked yet: the first check runs tonight.", at };
	const internal = r.broken.filter((b) => !b.external);
	const external = r.broken.filter((b) => b.external);
	const detail = [`${plural(r.pages, "page")} read, ${plural(r.checked, "address", "addresses")} on the site checked ${r.at.slice(0, 10)}.`, ...(r.external ? [`Links to other sites (${r.external.at.slice(0, 10)}): ${r.external.checked} checked, ${r.external.broken} broken${r.external.unchecked ? `, ${r.external.unchecked} could not be checked (the other site refused automated checks)` : ""}.`] : []), ...(running ? [`A new check is running: ${running.done} of ${running.pages} pages read.`] : [])];
	if (internal.length) return { status: "fail", summary: `${plural(internal.length, "broken link")} on the site${external.length ? ` and ${external.length} to other sites` : ""}.`, at, detail };
	if (external.length) return { status: "warn", summary: `${plural(external.length, "link")} to other sites no longer work${external.length === 1 ? "s" : ""}.`, at, detail };
	return { status: "ok", summary: "No broken links.", at, detail };
}
