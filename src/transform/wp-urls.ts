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
	/**
	 * The site has a blog (src/transform/blog.ts): the posts page, archives and feeds are real routes. `posts` are the
	 * migrated posts' addresses (never matched by a rule, like pages); `ids` the query forms → archive addresses.
	 */
	blog?: { index: string; archives: string[]; posts: string[]; ids: Record<string, string> };
	/** Comments are migrated (src/transform/comments.ts): the comment feeds still answer 410 (no comment feed is built). */
	comments?: boolean;
	/** Language directories of a multilingual site (`fr`, `de`): left out of term and author links when the bases are read. */
	langDirs?: string[];
	/** Language home pages that are not the bare directory (`fr` → `/fr/accueil/`), for the rules' `languages`. */
	langHomes?: Record<string, string>;
}

const pathOf = (u: string): string | undefined => {
	try {
		return new URL(u).pathname;
	} catch {
		return undefined;
	}
};

/**
 * The archive base the live permalinks use (`/category/`, `/topics/`…): the most common prefix before the slug.
 * `langDirs` are a multilingual site's language directories (Polylang / WPML directory mode, without slashes): a
 * translated term's link has its language in front (`/fr/category/actualites/`), which is not part of the base. Read
 * as is, a site with as many French terms as English ones got the base `/fr/`, and the starter then answered every
 * French address as a category archive (404) — docs/spikes/multilingual-findings.md.
 */
export function baseOf(items: { slug: string; link: string }[], langDirs: string[] = []): string | undefined {
	const counts = new Map<string, number>();
	for (const i of items) {
		let p = pathOf(i.link);
		if (!p) continue;
		const dir = langDirs.find((d) => d && (p as string).startsWith(`/${d}/`));
		if (dir) p = p.slice(dir.length + 1);
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
	const realBlog = input.blog;
	const defaults: Record<RuleKey, { target: string; why: string }> = {
		feed: realBlog
			? { target: "/feed/", why: "the blog's RSS feed (starter): /feed/ answers RSS 2.0; ?feed=rss2 and /wp-rss2.php → /feed/" }
			: blog
			? { target: blog, why: "the site's feed → the blog page (no feed is generated yet)" }
			: { target: "/", why: hasPosts ? "no feed is generated yet: → home until the blog milestone adds one (flagged)" : "no posts: the feed had nothing of its own, → home (linked from every old page's <head>)" },
		commentsFeed: { target: "gone", why: input.comments ? "comments are migrated but no comment feed is built: the resource is gone (410 tells feed readers to unsubscribe)" : "comments are not migrated: the resource is gone (410 tells feed readers to unsubscribe)" },
		search: { target: "/search/", why: search ? "the starter's search page (EmDash full-text search; the migrated /search/ page shows above it): the query goes along as ?q=" : "the starter's search page (EmDash full-text search): the query goes along as ?q=" },
		category: realBlog ? { target: realBlog.index, why: "category archives are rebuilt (blog); only the bare base and unknown query forms → the posts page" } : blog ? { target: blog, why: "category archives are not rebuilt: → the blog page" } : { target: "gone", why: "no blog page to send them to: 410" },
		tag: realBlog ? { target: realBlog.index, why: "tag archives are rebuilt (blog); only the bare base and unknown query forms → the posts page" } : blog ? { target: blog, why: "tag archives are not rebuilt: → the blog page" } : { target: "gone", why: "no blog page to send them to: 410" },
		author: realBlog ? { target: realBlog.index, why: "author archives are rebuilt from the bylines (blog); only the bare base and unknown query forms → the posts page" } : blog ? { target: blog, why: "author archives are not rebuilt: → the blog page" } : { target: "/", why: "no author pages: → home (what WordPress SEO plugins do for single-author sites)" },
		date: realBlog ? { target: realBlog.index, why: "date archives are not rebuilt: → the posts page" } : blog ? { target: blog, why: "date archives are not rebuilt: → the blog page" } : { target: "gone", why: "no blog page to send them to: 410" },
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
	const dirs = input.langDirs ?? [];
	const categoryBase = baseOf(terms.filter((t) => t.taxonomy === "category"), dirs);
	const tagBase = baseOf(terms.filter((t) => t.taxonomy === "post_tag"), dirs);
	const authorBase = baseOf(input.discovery?.authors ?? [], dirs);
	const bases = {
		...(categoryBase ? { category: categoryBase } : {}),
		...(tagBase ? { tag: tagBase } : {}),
		...(authorBase ? { author: authorBase } : {}),
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
	const allPages = realBlog ? [...new Set([...pages, ...realBlog.posts])] : pages;
	const languages = dirs.filter(Boolean).map((dir) => ({ dir, ...(input.langHomes?.[dir] ? { home: input.langHomes[dir] } : {}) }));
	return {
		rules: { ...(rules as Record<RuleKey, string>), ...(Object.keys(bases).length ? { bases } : {}), pages: allPages, ...(Object.keys(attachments).length ? { attachments } : {}), trailingSlash: input.trailingSlash, ...(realBlog ? { blog: { index: realBlog.index, archives: realBlog.archives, ...(Object.keys(realBlog.ids).length ? { ids: realBlog.ids } : {}) } } : {}), ...(languages.length ? { languages } : {}) } as WpUrlRules,
		explain,
		feedPending: hasPosts && !realBlog && rules.feed !== "gone",
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
