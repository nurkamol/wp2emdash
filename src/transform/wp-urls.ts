/**
 * The WordPress-URL rule set for one site (feeds, search, archives, attachment pages, query forms), decided at
 * transform time from what the audit and extract found plus overrides.ts `wpUrls`. Written to ir/wp-urls.json:
 * scaffold puts it into site.config.json (`wpUrls`, applied by the starter middleware) and verify judges every
 * audited URL with the same rules (urls-accounted). Reasoning for the defaults: docs/spikes/wp-urls-findings.md.
 */
import type { Overrides } from "../config/overrides.js";
import type { WpAttachment, WpUrlRules } from "../../starter/src/utils/wp-urls.js";

export * from "../../starter/src/utils/wp-urls.js";

export type RuleKey = "feed" | "commentsFeed" | "search" | "category" | "tag" | "author" | "date" | "attachment";

export interface WpUrlPlan {
	rules: WpUrlRules;
	/** One line per rule for the coverage report: what it does and why. */
	explain: { rule: RuleKey; target: string; source: "default" | "override"; why: string }[];
	/** The site has published posts but no real feed yet: `/feed/` redirects until the blog milestone builds one. */
	feedPending: boolean;
}

export interface WpUrlInput {
	/** Published page paths on the new site (IR routes). */
	pages: string[];
	/** WordPress id → path on the new site (published, migrated). */
	routeById: Map<number, string>;
	/** Published posts (any builder) the extract found. */
	publishedPosts: number;
	/** options.page_for_posts (the blog page), when set. */
	blogPageId?: number;
	/** Audit discovery (snapshot/discovery.json). */
	discovery?: { terms?: { taxonomy: string; slug: string; link: string }[]; authors?: { slug: string; link: string }[]; media?: { id: number; link: string; sourceUrl: string; parent?: number }[] };
	overrides: Pick<Overrides, "wpUrls">;
	trailingSlash: "always" | "never";
}

const pathOf = (u: string): string | undefined => {
	try {
		return new URL(u).pathname;
	} catch {
		return undefined;
	}
};

/** The archive base the live permalinks use (`/category/`, `/topics/`…): the most common prefix before the slug. */
function baseOf(items: { slug: string; link: string }[]): string | undefined {
	const counts = new Map<string, number>();
	for (const i of items) {
		const p = pathOf(i.link);
		if (!p) continue;
		const at = p.indexOf(`/${i.slug}/`);
		if (at < 0) continue;
		// Child terms (`/category/parent/child/`): the base is everything before the first term segment.
		const base = p.slice(0, at + 1);
		const first = /^\/[^/]+\//.exec(base)?.[0] ?? base;
		counts.set(first, (counts.get(first) ?? 0) + 1);
	}
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export function buildWpUrlPlan(input: WpUrlInput): WpUrlPlan {
	const pages = [...new Set(input.pages)];
	const norm = (p: string) => (p === "/" ? "/" : `${p.replace(/\/+$/, "")}/`);
	const has = (p: string) => pages.some((x) => norm(x) === norm(p));
	const blog = input.blogPageId ? input.routeById.get(input.blogPageId) : undefined;
	const search = pages.find((p) => norm(p) === "/search/");
	const hasPosts = input.publishedPosts > 0;
	const defaults: Record<RuleKey, { target: string; why: string }> = {
		feed: blog
			? { target: blog, why: "the site's feed → the blog page (no feed is generated yet)" }
			: { target: "/", why: hasPosts ? "no feed is generated yet: → home until the blog milestone adds one (flagged)" : "no posts: the feed had nothing of its own, → home (linked from every old page's <head>)" },
		commentsFeed: { target: "gone", why: "comments are not migrated: the resource is gone (410 tells feed readers to unsubscribe)" },
		search: search ? { target: search, why: "the site has a /search/ page: the query goes along as ?q=" } : { target: "/", why: "no search page: → home (keeps the SearchAction link from erroring)" },
		category: blog ? { target: blog, why: "category archives are not rebuilt: → the blog page" } : { target: "gone", why: "no blog page to send them to: 410" },
		tag: blog ? { target: blog, why: "tag archives are not rebuilt: → the blog page" } : { target: "gone", why: "no blog page to send them to: 410" },
		author: blog ? { target: blog, why: "author archives are not rebuilt: → the blog page" } : { target: "/", why: "no author pages: → home (what WordPress SEO plugins do for single-author sites)" },
		date: blog ? { target: blog, why: "date archives are not rebuilt: → the blog page" } : { target: "gone", why: "no blog page to send them to: 410" },
		attachment: { target: "/", why: "attachment pages → the parent page when it was migrated, else the file when it is in the media library, else home" },
	};
	const explain: WpUrlPlan["explain"] = [];
	const rules = {} as Record<RuleKey, string>;
	for (const key of Object.keys(defaults) as RuleKey[]) {
		const o = input.overrides.wpUrls?.[key];
		const d = defaults[key];
		if (o) {
			const target = o === "home" ? "/" : o;
			rules[key] = target;
			explain.push({ rule: key, target, source: "override", why: target !== "gone" && !has(target) ? `overrides.ts wpUrls.${key} (WARNING: ${target} is not a migrated page)` : `overrides.ts wpUrls.${key}` });
		} else {
			rules[key] = d.target;
			explain.push({ rule: key, target: d.target, source: "default", why: d.why });
		}
	}
	const terms = input.discovery?.terms ?? [];
	const bases = {
		...(baseOf(terms.filter((t) => t.taxonomy === "category")) ? { category: baseOf(terms.filter((t) => t.taxonomy === "category")) } : {}),
		...(baseOf(terms.filter((t) => t.taxonomy === "post_tag")) ? { tag: baseOf(terms.filter((t) => t.taxonomy === "post_tag")) } : {}),
		...(baseOf(input.discovery?.authors ?? []) ? { author: baseOf(input.discovery?.authors ?? []) } : {}),
	};
	const attachments: Record<string, WpAttachment> = {};
	for (const m of input.discovery?.media ?? []) {
		const link = pathOf(m.link);
		const fileUrl = pathOf(m.sourceUrl);
		const file = fileUrl ? decodeURIComponent(fileUrl.split("/").pop() ?? "") : undefined;
		const parent = m.parent ? input.routeById.get(m.parent) : undefined;
		// A link that is the file itself or the query form (`/?attachment_id=`) has no page of its own.
		const ownPage = link && link !== "/" && link !== fileUrl && !/\.[a-z0-9]{2,5}$/i.test(link) ? link : undefined;
		attachments[String(m.id)] = { ...(ownPage ? { path: ownPage } : {}), ...(parent ? { parent } : {}), ...(file ? { file } : {}) };
	}
	return {
		rules: { ...(rules as Record<RuleKey, string>), ...(Object.keys(bases).length ? { bases } : {}), pages, ...(Object.keys(attachments).length ? { attachments } : {}), trailingSlash: input.trailingSlash } as WpUrlRules,
		explain,
		feedPending: hasPosts && rules.feed !== "gone",
	};
}

/** Coverage report section: the rule set and why. */
export function wpUrlsReport(plan: WpUrlPlan): string[] {
	const L = ["", "## WordPress URLs (feeds, search, archives, attachment pages)", "", "Addresses WordPress answered that have no page on the new site. The starter middleware answers them with one 301 (or a 410); verify's `urls-accounted` check uses the same rules. Change one in `overrides.ts → wpUrls` (a path, \"home\" or \"gone\").", "", "| Rule | Target | Set by | Why |", "|---|---|---|---|"];
	for (const e of plan.explain) L.push(`| ${e.rule} | ${e.target === "gone" ? "410 gone" : `301 → ${e.target}`} | ${e.source} | ${e.why.replace(/\|/g, "\\|")} |`);
	const att = Object.values(plan.rules.attachments ?? {});
	if (att.length) L.push("", `Attachment pages: ${att.length} (${att.filter((a) => a.parent).length} → their parent page, ${att.filter((a) => !a.parent && a.file).length} → the file, else home).`);
	if (plan.feedPending) L.push("", "⚠️ The site has published posts: `/feed/` only redirects until the blog milestone generates a real feed.");
	return L;
}
