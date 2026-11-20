/**
 * EmDash's built-in Settings (General, Social Links, SEO) prefilled from the WordPress site: ir/settings.json.
 *
 * Every value names its source, so the coverage report shows where it came from and what could not be carried
 * (EmDash 1.5's settings schema: docs/spikes/settings-findings.md). Pure: the transform phase reads the files and
 * passes their contents in.
 *
 * Sources, first match wins:
 * - logo / favicon: options `custom_logo` / `site_logo` / `site_icon` (attachment ids). Load prefers the brand files
 *   scaffold captured from the live header (the logo the site shows), these are the fallback.
 * - posts per page, date format, timezone: options `posts_per_page`, `date_format` (PHP → date-fns tokens),
 *   `timezone_string` (else `gmt_offset` as Etc/GMT±N).
 * - social profiles: Rank Math (`rank-math-options-titles` or its settings export), Yoast (`wpseo_social`), the home
 *   page's JSON-LD `sameAs`, then links to the networks in the live header/footer.
 * - default social image: Rank Math `open_graph_image`, Yoast `og_default_image`, else the og:image most pages share.
 * - verification: the audited pages' head (google-site-verification, msvalidate.01), else the SEO plugin's options.
 * - robots.txt: the live file without WordPress-only rules, the sitemap line pointing at the new domain; unset when
 *   nothing custom is left (EmDash then generates its default).
 */
import { z } from "zod";
import { IR_VERSION, mediaRef } from "../ir/schema.js";

export const SOCIAL_NETWORKS = ["twitter", "github", "facebook", "instagram", "linkedin", "youtube"] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

export const irSettings = z.object({
	version: z.literal(IR_VERSION),
	/** WordPress attachments; load uses the scaffolded brand files first (public/brand, what the header shows). */
	logo: mediaRef.optional(),
	favicon: mediaRef.optional(),
	postsPerPage: z.number().int().min(1).max(100).optional(),
	/** date-fns pattern (EmDash's admin formats with date-fns). */
	dateFormat: z.string().optional(),
	timezone: z.string().optional(),
	/** Full profile URLs (EmDash stores free text; the starter also accepts handles an editor types). */
	social: z.partialRecord(z.enum(SOCIAL_NETWORKS), z.string()).default({}),
	seo: z
		.object({
			titleSeparator: z.string().max(10).optional(),
			defaultOgImage: mediaRef.optional(),
			googleVerification: z.string().max(100).optional(),
			bingVerification: z.string().max(100).optional(),
			robotsTxt: z.string().max(5000).optional(),
		})
		.default({}),
	/** Setting path → where the value came from (coverage report). */
	sources: z.record(z.string(), z.string()).default({}),
	/** Found on the WordPress site but not carried into Settings, with the reason (coverage report). */
	notCarried: z.array(z.string()).default([]),
});
export type IrSettings = z.infer<typeof irSettings>;

export interface SettingsInputs {
	/** The exporter's options.json (blogname, date_format, timezone_string, site_icon, custom_logo…). */
	options: Record<string, unknown>;
	/** WordPress options by name from other raw files (bricks-options.json, seo-options.json): rank-math-options-*, wpseo*. */
	wpOptions?: Record<string, unknown>;
	/** raw/rankmath-settings.json (Rank Math → Status & Tools → Import/Export): { general, titles, … }. */
	rankMathExport?: Record<string, unknown>;
	/** JSON-LD blocks of the audited home page. */
	homeJsonLd?: unknown[];
	/** Links on the audited home page (header and footer included). */
	homeLinks?: string[];
	/** og:image of each audited page. */
	pageOgImages?: (string | undefined)[];
	/** Verification meta tags of the audited pages, merged. */
	verification?: Record<string, string>;
	/** The live robots.txt (audit discovery). */
	robotsTxt?: string;
	/** The new site's address (sitemap line). */
	productionUrl: string;
	/** Separator the live home page title uses ("-", "|"…). */
	titleSeparator?: string;
	/** Media library entries (extract manifest): maps upload URLs to attachment ids. */
	manifest?: { id?: number; url?: string; file?: string }[];
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const posInt = (v: unknown) => {
	const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : Number.NaN;
	return Number.isInteger(n) && n > 0 ? n : undefined;
};

/** Which EmDash social field a profile URL belongs to (share/intent links and other networks are not profiles). */
export function socialNetworkOf(url: string): SocialNetwork | undefined {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return undefined;
	}
	if (!/^https?:$/.test(u.protocol)) return undefined;
	const host = u.hostname.toLowerCase().replace(/^(www|m|mobile|web)\./, "");
	const path = u.pathname.replace(/\/+$/, "");
	if (!path || path === "/") return undefined;
	if (/\/(sharer|share|intent|dialog|plugins|shareArticle|home)(\.php)?(\/|$)/i.test(path) || /^\/(tr|watch|embed|hashtag|search|p|reel|events|groups\/?$)(\/|$)/i.test(path)) return undefined;
	if (host === "twitter.com" || host === "x.com") return "twitter";
	if (host === "github.com") return "github";
	if (host === "facebook.com" || host === "fb.com") return "facebook";
	if (host === "instagram.com") return "instagram";
	if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return /^\/(in|company|school|showcase)\//i.test(path) ? "linkedin" : undefined;
	if (host === "youtube.com") return /^\/(@[\w.-]+|c\/|channel\/|user\/)/i.test(path) ? "youtube" : undefined;
	return undefined;
}

/** A profile on a network EmDash's Settings has no field for (kept in the migrated footer, reported). */
function otherNetwork(url: string): string | undefined {
	try {
		const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
		return /^(tiktok\.com|pinterest\.[a-z.]+|threads\.(net|com)|yelp\.com|vimeo\.com|snapchat\.com|bsky\.app|tumblr\.com|soundcloud\.com|spotify\.com|whatsapp\.com|wa\.me|t\.me|telegram\.me|houzz\.com|tripadvisor\.[a-z.]+)$/.test(host) ? host : undefined;
	} catch {
		return undefined;
	}
}

/** WordPress (PHP date()) format → date-fns pattern; undefined when it uses a token date-fns has no match for. */
export function phpDateToDateFns(php: string): string | undefined {
	const MAP: Record<string, string> = { d: "dd", j: "d", D: "EEE", l: "EEEE", N: "i", F: "MMMM", M: "MMM", m: "MM", n: "M", Y: "yyyy", y: "yy", a: "aaa", A: "a", g: "h", G: "H", h: "hh", H: "HH", i: "mm", s: "ss", T: "zzz", e: "zzzz", z: "D", W: "I", o: "RRRR", U: "t" };
	let out = "";
	let literal = "";
	const flush = () => {
		if (literal) out += `'${literal.replace(/'/g, "''")}'`;
		literal = "";
	};
	for (let i = 0; i < php.length; i++) {
		const c = php[i] as string;
		if (c === "\\") {
			literal += php[i + 1] ?? "";
			i++;
			continue;
		}
		// jS → "do" (1st, 2nd): the ordinal suffix belongs to the day before it.
		if (c === "S") {
			if (out.endsWith("d") && !out.endsWith("dd")) {
				out = `${out.slice(0, -1)}do`;
				continue;
			}
			return undefined;
		}
		if (/[a-zA-Z]/.test(c)) {
			const t = MAP[c];
			if (!t) return undefined;
			flush();
			out += t;
			continue;
		}
		if (c === "'") {
			literal += "'";
			continue;
		}
		flush();
		out += c;
	}
	flush();
	return out || undefined;
}

/** WordPress timezone: the IANA name, else a whole-hour offset as Etc/GMT∓N (POSIX sign), else undefined. */
export function wpTimezone(tzString: unknown, gmtOffset: unknown): string | undefined {
	const tz = str(tzString);
	if (tz && !/^UTC[+-]/i.test(tz)) {
		try {
			Intl.DateTimeFormat("en", { timeZone: tz });
			return tz;
		} catch {
			return undefined;
		}
	}
	const off = Number(str(gmtOffset) ?? (tz ? tz.replace(/^UTC/i, "") : Number.NaN));
	if (!Number.isFinite(off)) return undefined;
	if (off === 0) return "UTC";
	if (!Number.isInteger(off) || Math.abs(off) > 14) return undefined;
	return `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
}

/** Paths a robots.txt rule names that only exist on WordPress (gone on the new site). */
const WP_ONLY = /^\/(?:wp-admin|wp-includes|wp-content|wp-json|wp-login\.php|wp-signup\.php|wp-register\.php|wp-activate\.php|wp-cron\.php|wp-trackback\.php|wp-comments-post\.php|wp-links-opml\.php|wp-mail\.php|xmlrpc\.php|readme\.html|license\.txt|trackback|feed|comments\/feed|\*\/feed|\*\/trackback|\*?\?s=|\?s=|\*\?s=|search|\?p=|\*\?replytocom|\*\?.*replytocom|\?attachment_id=|cgi-bin)(?:\/|$|\*|\?|=)?/i;

/**
 * The live robots.txt for EmDash's Settings → SEO → robots.txt: WordPress-only rules dropped, every Sitemap line
 * replaced by the new site's /sitemap.xml, EmDash's own admin kept out (its media files stay crawlable). Undefined when
 * no rule of the site's own is left: EmDash's generated default is then the same thing.
 */
export function migrateRobotsTxt(txt: string | undefined, productionUrl: string): { robotsTxt?: string; dropped: string[] } {
	const dropped: string[] = [];
	if (!txt?.trim()) return { dropped };
	const groups: { agents: string[]; rules: string[]; comments: string[] }[] = [];
	const lead: string[] = [];
	let cur: (typeof groups)[number] | undefined;
	let lastWasAgent = false;
	for (const rawLine of txt.replace(/\r\n?/g, "\n").split("\n")) {
		const line = rawLine.trim();
		if (!line) {
			lastWasAgent = false;
			continue;
		}
		if (line.startsWith("#")) {
			// Comments inside the WordPress-generated block ("# START YOAST BLOCK") are noise; others are kept.
			if (/YOAST|RANK MATH|wordpress|wp-|virtual robots/i.test(line)) continue;
			(cur ? cur.comments : lead).push(line);
			continue;
		}
		const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
		if (!m) continue;
		const key = (m[1] as string).toLowerCase();
		const value = (m[2] as string).replace(/\s+#.*$/, "").trim();
		if (key === "sitemap") {
			dropped.push(`Sitemap: ${value}`);
			continue;
		}
		if (key === "user-agent") {
			if (!lastWasAgent || !cur) {
				cur = { agents: [], rules: [], comments: [] };
				groups.push(cur);
			}
			cur.agents.push(value);
			lastWasAgent = true;
			continue;
		}
		lastWasAgent = false;
		if (!cur) continue;
		if ((key === "disallow" || key === "allow") && value && WP_ONLY.test(value)) {
			dropped.push(`${m[1]}: ${value}`);
			continue;
		}
		// An empty Disallow means "everything allowed": the default, kept only if the group has nothing else.
		cur.rules.push(`${key === "disallow" ? "Disallow" : key === "allow" ? "Allow" : key === "crawl-delay" ? "Crawl-delay" : m[1]}: ${value}`.trimEnd());
	}
	const custom = groups.filter((g) => g.rules.some((r) => !/^Disallow:\s*$/.test(r)) || g.agents.some((a) => a !== "*"));
	if (!custom.length) return { dropped };
	const star = groups.find((g) => g.agents.includes("*"));
	const out: string[] = [...lead];
	for (const g of groups) {
		const rules = g.rules.filter((r) => !/^Disallow:\s*$/.test(r) || g.rules.length === 1);
		if (g === star) rules.push("Disallow: /_emdash/", "Allow: /_emdash/api/media/file/");
		if (!rules.length) rules.push("Disallow:");
		if (out.length) out.push("");
		out.push(...g.comments, ...g.agents.map((a) => `User-agent: ${a}`), ...rules);
	}
	if (!star) out.push("", "User-agent: *", "Disallow: /_emdash/", "Allow: /_emdash/api/media/file/");
	out.push("", `Sitemap: ${productionUrl.replace(/\/+$/, "")}/sitemap.xml`, "");
	const robotsTxt = out.join("\n");
	if (robotsTxt.length > 5000) return { dropped: [...dropped, "the whole file: longer than EmDash's 5000-character limit"] };
	return { robotsTxt, dropped };
}

/** Rank Math's option arrays, from the database options or its settings export. */
function rankMath(i: SettingsInputs): { titles: Record<string, unknown>; general: Record<string, unknown>; via: string } | undefined {
	const t = obj(i.wpOptions?.["rank-math-options-titles"]);
	const g = obj(i.wpOptions?.["rank-math-options-general"]);
	if (t || g) return { titles: t ?? {}, general: g ?? {}, via: "Rank Math options" };
	const e = i.rankMathExport;
	if (e && (obj(e.titles) || obj(e.general))) return { titles: obj(e.titles) ?? {}, general: obj(e.general) ?? {}, via: "Rank Math settings export" };
	return undefined;
}

/** A verification value as the meta tag's content (some plugins store the whole tag). */
const verifyContent = (v: unknown) => {
	const s = str(v);
	if (!s) return undefined;
	const m = /content\s*=\s*["']([^"']+)["']/i.exec(s);
	const c = (m ? m[1] : s)?.trim();
	return c && c.length <= 100 && /^[\w.\-=+/]+$/.test(c) ? c : undefined;
};

export function buildSettings(i: SettingsInputs): IrSettings {
	const sources: Record<string, string> = {};
	const notCarried: string[] = [];
	const o = i.options;
	const out: IrSettings = { version: IR_VERSION, social: {}, seo: {}, sources, notCarried };

	// ── Identity: logo and site icon (load uses the scaffolded brand files first) ──
	const logoId = posInt(o.custom_logo) ?? posInt(o.site_logo);
	if (logoId) {
		out.logo = { wpId: logoId, kind: "image" };
		sources.logo = posInt(o.custom_logo) ? "option custom_logo" : "option site_logo";
	} else if (str(o.custom_logo_url)) {
		out.logo = { url: str(o.custom_logo_url) as string, kind: "image" };
		sources.logo = "option custom_logo_url";
	}
	const iconId = posInt(o.site_icon);
	if (iconId) {
		out.favicon = { wpId: iconId, kind: "image" };
		sources.favicon = "option site_icon";
	} else if (str(o.site_icon_url)) {
		out.favicon = { url: str(o.site_icon_url) as string, kind: "image" };
		sources.favicon = "option site_icon_url";
	}

	// ── Reading ──
	const ppp = posInt(o.posts_per_page);
	if (ppp) {
		out.postsPerPage = Math.min(100, ppp);
		sources.postsPerPage = ppp > 100 ? "option posts_per_page (capped at EmDash's 100)" : "option posts_per_page";
	}
	const php = str(o.date_format);
	if (php) {
		const f = phpDateToDateFns(php);
		if (f) {
			out.dateFormat = f;
			sources.dateFormat = `option date_format "${php}"`;
		} else notCarried.push(`Date format "${php}": uses a PHP token with no date-fns equivalent; EmDash keeps its default (Settings → General)`);
	}
	if (str(o.timezone_string) || str(o.gmt_offset)) {
		const tz = wpTimezone(o.timezone_string, o.gmt_offset);
		if (tz) {
			out.timezone = tz;
			sources.timezone = str(o.timezone_string) ? "option timezone_string" : `option gmt_offset (${str(o.gmt_offset)})`;
		} else notCarried.push(`Timezone "${str(o.timezone_string) ?? `UTC${str(o.gmt_offset)}`}": not an IANA zone or a whole-hour offset; set it in Settings → General`);
	}

	// ── Social profiles ──
	const social = out.social as Partial<Record<SocialNetwork, string>>;
	const others = new Map<string, string>();
	const offer = (url: string | undefined, via: string) => {
		if (!url) return;
		const u = /^https?:\/\//i.test(url) ? url : undefined;
		if (!u) return;
		const n = socialNetworkOf(u);
		if (n) {
			if (!social[n]) {
				social[n] = u;
				sources[`social.${n}`] = via;
			}
			return;
		}
		const other = otherNetwork(u);
		if (other && !others.has(other)) others.set(other, `${u} (${via})`);
	};
	const handle = (h: unknown) => str(h)?.replace(/^@/, "").replace(/^https?:\/\/(www\.)?(twitter|x)\.com\//i, "");
	const rm = rankMath(i);
	if (rm) {
		offer(str(rm.titles.social_url_facebook), `${rm.via} (social_url_facebook)`);
		const tw = handle(rm.titles.twitter_author_names);
		if (tw && /^\w{1,15}$/.test(tw)) offer(`https://x.com/${tw}`, `${rm.via} (twitter_author_names)`);
		for (const u of String(str(rm.titles.social_additional_profiles) ?? "").split(/\s+/)) offer(u, `${rm.via} (social_additional_profiles)`);
	}
	const ys = obj(i.wpOptions?.wpseo_social);
	if (ys) {
		offer(str(ys.facebook_site), "Yoast (wpseo_social.facebook_site)");
		const tw = handle(ys.twitter_site);
		if (tw && /^\w{1,15}$/.test(tw)) offer(`https://x.com/${tw}`, "Yoast (wpseo_social.twitter_site)");
		for (const k of ["instagram_url", "linkedin_url", "youtube_url", "pinterest_url"]) offer(str(ys[k]), `Yoast (wpseo_social.${k})`);
		for (const u of Array.isArray(ys.other_social_urls) ? ys.other_social_urls : []) offer(str(u), "Yoast (wpseo_social.other_social_urls)");
	}
	const nodes = (i.homeJsonLd ?? []).flatMap((b) => {
		const o2 = obj(b);
		return o2 ? ((Array.isArray(o2["@graph"]) ? (o2["@graph"] as unknown[]) : [o2]).map(obj).filter((x): x is Record<string, unknown> => !!x)) : [];
	});
	for (const n of nodes) for (const u of ([] as unknown[]).concat(n.sameAs ?? [])) offer(str(u), "home page structured data (sameAs)");
	for (const u of i.homeLinks ?? []) offer(u, "link on the live home page (header/footer)");
	for (const [, v] of others) notCarried.push(`Social profile ${v}: EmDash's Social Links have no field for this network; the link stays where the migrated footer has it`);

	// ── SEO ──
	if (i.titleSeparator) {
		out.seo.titleSeparator = i.titleSeparator;
		sources["seo.titleSeparator"] = "live home page title";
	}
	const manifest = i.manifest ?? [];
	const uploadPath = (u: string) => /\/(?:wp-content\/uploads|storage)\/(.+)$/.exec(u.split(/[?#]/)[0] ?? "")?.[1]?.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "").replace(/-scaled(?=\.[a-z0-9]+$)/i, "").toLowerCase();
	const imageRef = (id: unknown, url: unknown) => {
		const n = posInt(id);
		if (n && (!manifest.length || manifest.some((m) => m.id === n))) return { wpId: n, kind: "image" as const };
		const u = str(url);
		if (!u || !/^https?:\/\//i.test(u)) return undefined;
		const p = uploadPath(u);
		const m = p ? manifest.find((x) => x.id && x.file?.toLowerCase() === p) : undefined;
		return m?.id ? { wpId: m.id, kind: "image" as const } : { url: u, kind: "image" as const };
	};
	let og = rm ? imageRef(rm.titles.open_graph_image_id, rm.titles.open_graph_image) : undefined;
	if (og) sources["seo.defaultOgImage"] = `${rm?.via} (open_graph_image)`;
	if (!og && ys) {
		og = imageRef(ys.og_default_image_id, ys.og_default_image);
		if (og) sources["seo.defaultOgImage"] = "Yoast (wpseo_social.og_default_image)";
	}
	if (!og) {
		const counts = new Map<string, number>();
		for (const u of i.pageOgImages ?? []) if (u) counts.set(u, (counts.get(u) ?? 0) + 1);
		const ranked = [...counts].sort((a, b) => b[1] - a[1]);
		const [top, second] = ranked;
		// A site-wide default shows up as the same picture on several pages, more often than any other.
		if (top && top[1] >= 2 && (!second || top[1] > second[1])) {
			og = imageRef(undefined, top[0]);
			if (og) sources["seo.defaultOgImage"] = `og:image shared by ${top[1]} of ${i.pageOgImages?.filter(Boolean).length} audited pages`;
		}
	}
	if (og) out.seo.defaultOgImage = og;
	const ver = i.verification ?? {};
	const yw = obj(i.wpOptions?.wpseo);
	const google = verifyContent(ver["google-site-verification"]);
	const googleAlt = verifyContent(rm?.general.google_verify) ?? verifyContent(yw?.googleverify);
	if (google ?? googleAlt) {
		out.seo.googleVerification = (google ?? googleAlt) as string;
		sources["seo.googleVerification"] = google ? "audited page head (google-site-verification)" : rm?.general.google_verify ? `${rm.via} (google_verify)` : "Yoast (wpseo.googleverify)";
	}
	const bing = verifyContent(ver["msvalidate.01"]);
	const bingAlt = verifyContent(rm?.general.bing_verify) ?? verifyContent(yw?.msverify);
	if (bing ?? bingAlt) {
		out.seo.bingVerification = (bing ?? bingAlt) as string;
		sources["seo.bingVerification"] = bing ? "audited page head (msvalidate.01)" : rm?.general.bing_verify ? `${rm.via} (bing_verify)` : "Yoast (wpseo.msverify)";
	}
	for (const name of Object.keys(ver).filter((k) => k !== "google-site-verification" && k !== "msvalidate.01")) notCarried.push(`Verification tag ${name}: EmDash's SEO settings have Google and Bing only; the starter keeps printing it (site.config.json → verification)`);
	const robots = migrateRobotsTxt(i.robotsTxt, i.productionUrl);
	if (robots.robotsTxt) {
		out.seo.robotsTxt = robots.robotsTxt;
		sources["seo.robotsTxt"] = `live robots.txt${robots.dropped.length ? ` (${robots.dropped.length} WordPress-only line(s) dropped: ${robots.dropped.join("; ")})` : ""}`;
	} else if (i.robotsTxt?.trim()) sources["seo.robotsTxt"] = `not set: the live robots.txt had no rules of its own beyond WordPress's (${robots.dropped.join("; ") || "empty"}); EmDash generates its default with the sitemap`;
	return out;
}

/** Coverage report section. */
export function settingsReport(s: IrSettings): string[] {
	const L: string[] = ["", "## Site settings (Settings → General, Social Links, SEO)", "", "| Setting | Value | Source |", "|---|---|---|"];
	const val = (v: unknown) => (v && typeof v === "object" ? ((v as { wpId?: number; url?: string }).wpId ? `media #${(v as { wpId: number }).wpId}` : String((v as { url?: string }).url)) : String(v).replace(/\n/g, " ⏎ ").slice(0, 120));
	const rows: [string, unknown][] = [
		["logo", s.logo],
		["favicon", s.favicon],
		["postsPerPage", s.postsPerPage],
		["dateFormat", s.dateFormat],
		["timezone", s.timezone],
		...SOCIAL_NETWORKS.map((n) => [`social.${n}`, s.social[n]] as [string, unknown]),
		["seo.titleSeparator", s.seo.titleSeparator],
		["seo.defaultOgImage", s.seo.defaultOgImage],
		["seo.googleVerification", s.seo.googleVerification],
		["seo.bingVerification", s.seo.bingVerification],
		["seo.robotsTxt", s.seo.robotsTxt],
	];
	for (const [k, v] of rows) if (v !== undefined || s.sources[k]) L.push(`| ${k} | ${v === undefined ? "—" : `\`${val(v).replace(/\|/g, "\\|")}\``} | ${(s.sources[k] ?? "").replace(/\|/g, "\\|")} |`);
	L.push("", "Logo and favicon: load uploads the brand files scaffold captured from the live header (public/brand) and falls back to the attachments above.");
	if (s.notCarried.length) {
		L.push("", "Not carried into Settings:");
		for (const n of s.notCarried) L.push(`- ${n}`);
	}
	return L;
}
