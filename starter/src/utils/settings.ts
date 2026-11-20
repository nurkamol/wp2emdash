/**
 * EmDash's built-in Settings in the page: logo and favicon (Settings → General), social links (Settings → Social
 * Links), verification tags and the default sharing image (Settings → SEO). Read through the page's chrome loader
 * (utils/chrome.ts: getSiteSettingsWithCacheHint), so a save purges every cached page (tag emdash:settings).
 *
 * src/site.config.json stays the fallback for any setting that is empty. The migrated logo and favicon keep their
 * optimized brand files (content-hashed, WebP, sized favicons) while the setting still points at the file load
 * uploaded: recognised by the media row's content hash or load's `wp2emdash-<name>-<sha1:10>` file name against
 * site.config `brandSha1`. Once an editor picks another image, that image is served from the media library.
 *
 * EmDash's own head (EmDashHead) already prints `<link rel="icon">` for the favicon setting, the
 * google-site-verification / msvalidate.01 tags and the default og:image; this module adds what it does not
 * (apple-touch icon, the site's other verification tags, og:image size) and never prints those twice.
 */

export type Network = "twitter" | "github" | "facebook" | "instagram" | "linkedin" | "youtube";
export const NETWORKS: Network[] = ["twitter", "github", "facebook", "instagram", "linkedin", "youtube"];

export interface MediaSetting {
	mediaId: string;
	alt?: string;
	url?: string;
	contentType?: string;
	width?: number;
	height?: number;
}
export interface SettingsData {
	title?: string;
	tagline?: string;
	logo?: MediaSetting;
	favicon?: MediaSetting;
	social?: Partial<Record<Network, string>>;
	seo?: { titleSeparator?: string; defaultOgImage?: MediaSetting; googleVerification?: string; bingVerification?: string; robotsTxt?: string };
}
/** A row of EmDash's media table (D1). */
export interface MediaRow {
	id: string;
	content_hash: string | null;
	filename: string | null;
}
export interface Img {
	src: string;
	width?: number;
	height?: number;
}
export interface IconLink {
	rel: string;
	href: string;
	type: string;
	sizes?: string;
}
export interface BrandConfig {
	/** Header logo files from the performance package (hashed, sized), else the plain brand paths. */
	logo?: Img;
	logoOnTop?: Img;
	/** Sized favicon links (performance package). */
	icons?: IconLink[];
	/** The captured favicon file (when there are no sized icons). */
	favicon?: string;
	/** Header logo height (px), for the replaced logo's width/height attributes. */
	logoHeight?: number;
	brandSha1?: { logo?: string; favicon?: string };
}

/** True when the setting's media is the brand file load uploaded (same bytes, or load's converted copy). */
export function isBrandMedia(row: MediaRow | undefined, name: "logo" | "favicon", sha1: string | undefined): boolean {
	if (!row || !sha1) return false;
	return row.content_hash === `sha1:${sha1}` || (row.filename ?? "").startsWith(`wp2emdash-${name}-${sha1.slice(0, 10)}`);
}

/** An image from the media library at the header's logo height (intrinsic size when the height is unknown). */
export function mediaImg(m: MediaSetting, height?: number): Img | undefined {
	if (!m.url) return undefined;
	if (m.width && m.height && height) return { src: m.url, width: Math.max(1, Math.round((m.width * height) / m.height)), height };
	return { src: m.url, ...(m.width ? { width: m.width } : {}), ...(m.height ? { height: m.height } : {}) };
}

/** The media ids whose rows decide brand-file use (logo and favicon settings that resolved to a file). */
export const brandMediaIds = (s: SettingsData | undefined) => [s?.logo, s?.favicon].filter((m): m is MediaSetting => !!m?.url && !!m.mediaId).map((m) => m.mediaId);

type D1Like = { prepare(q: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results?: T[] }> } } };
/** Their media rows (one query; none when no logo/favicon setting is set). Errors read as "no rows": the fallback stays. */
export async function brandMediaRows(db: D1Like | undefined, ids: string[]): Promise<MediaRow[]> {
	if (!db || !ids.length) return [];
	try {
		const r = await db
			.prepare(`SELECT id, content_hash, filename FROM media WHERE id IN (${ids.map(() => "?").join(", ")})`)
			.bind(...ids)
			.all<MediaRow>();
		return r.results ?? [];
	} catch {
		return [];
	}
}

/**
 * Logo, light logo and favicon links for this page. The setting wins when it names another image than the migrated
 * one; site.config is the fallback when the setting is empty or its media is gone.
 */
export function siteBrand(s: SettingsData | undefined, cfg: BrandConfig, rows: MediaRow[]): { logo?: Img; logoOnTop?: Img; icons: IconLink[]; logoReplaced: boolean; faviconReplaced: boolean } {
	const row = (m?: MediaSetting) => (m ? rows.find((r) => r.id === m.mediaId) : undefined);
	const fallbackIcons = cfg.icons?.length ? cfg.icons : cfg.favicon ? [{ rel: "icon", href: cfg.favicon, type: "" }] : [];
	const logoSet = s?.logo?.url ? s.logo : undefined;
	const logoReplaced = !!logoSet && !isBrandMedia(row(logoSet), "logo", cfg.brandSha1?.logo) && !!mediaImg(logoSet);
	const fav = s?.favicon?.url ? s.favicon : undefined;
	const faviconReplaced = !!fav && !isBrandMedia(row(fav), "favicon", cfg.brandSha1?.favicon);
	// EmDash's head links the favicon setting itself; a raster one big enough also serves as the home-screen icon.
	const touch = fav && faviconReplaced && /^image\/(png|jpeg|webp)$/.test(fav.contentType ?? "") && Math.min(fav.width ?? 0, fav.height ?? 0) >= 120 ? [{ rel: "apple-touch-icon", href: fav.url as string, type: fav.contentType as string }] : [];
	return {
		...(logoReplaced ? { logo: mediaImg(logoSet as MediaSetting, cfg.logoHeight) } : cfg.logo ? { logo: cfg.logo } : {}),
		// A light variant belongs to the migrated logo: a replaced logo is shown over the hero too.
		...(!logoReplaced && cfg.logoOnTop ? { logoOnTop: cfg.logoOnTop } : {}),
		icons: faviconReplaced ? touch : fallbackIcons.map((i) => ({ ...i })),
		logoReplaced,
		faviconReplaced,
	};
}

/** Verification tags the starter prints: site.config's, minus those EmDash's head prints from Settings → SEO. */
export function verificationTags(s: SettingsData | undefined, carried: Record<string, string> | undefined): [string, string][] {
	return Object.entries(carried ?? {}).filter(([name]) => !(name === "google-site-verification" && s?.seo?.googleVerification?.trim()) && !(name === "msvalidate.01" && s?.seo?.bingVerification?.trim()));
}

/** The network of a profile link (share and intent links are not profiles). */
export function networkOf(href: string | undefined): Network | undefined {
	if (!href) return undefined;
	let u: URL;
	try {
		u = new URL(href);
	} catch {
		return undefined;
	}
	if (!/^https?:$/.test(u.protocol) || /\/(sharer|share|intent|dialog|shareArticle)(\.php)?(\/|$)/i.test(u.pathname)) return undefined;
	const host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, "");
	if (host === "twitter.com" || host === "x.com") return "twitter";
	if (host === "github.com") return "github";
	if (host === "facebook.com" || host === "fb.com") return "facebook";
	if (host === "instagram.com") return "instagram";
	if (host === "linkedin.com" || host.endsWith(".linkedin.com")) return "linkedin";
	if (host === "youtube.com" || host === "youtu.be") return "youtube";
	return undefined;
}

/**
 * A Social Links value as a profile URL. EmDash's admin asks for handles ("@username", "username", "channel ID or
 * handle"); load stores full URLs (LinkedIn company pages and YouTube channels are ambiguous as handles). Both work.
 */
export function socialHref(n: Network, value: string | undefined): string | undefined {
	const v = value?.trim();
	if (!v) return undefined;
	if (/^https?:\/\//i.test(v)) return networkOf(v) === n ? v : undefined;
	if (/^(www\.)?[a-z0-9.-]+\.[a-z]{2,}\//i.test(v)) return networkOf(`https://${v}`) === n ? `https://${v}` : undefined;
	const h = v.replace(/^@/, "");
	if (!/^[\w.-]{1,100}$/.test(h)) return undefined;
	switch (n) {
		case "twitter":
			return `https://x.com/${h}`;
		case "github":
			return `https://github.com/${h}`;
		case "facebook":
			return `https://www.facebook.com/${h}`;
		case "instagram":
			return `https://www.instagram.com/${h}/`;
		case "linkedin":
			return `https://www.linkedin.com/in/${h}/`;
		case "youtube":
			return /^UC[\w-]{22}$/.test(h) ? `https://www.youtube.com/channel/${h}` : `https://www.youtube.com/@${h}`;
	}
}

/** Every network with a usable value. */
export function socialLinks(s: SettingsData | undefined): Partial<Record<Network, string>> {
	const out: Partial<Record<Network, string>> = {};
	for (const n of NETWORKS) {
		const h = socialHref(n, s?.social?.[n]);
		if (h) out[n] = h;
	}
	return out;
}

/** Networks the footer's round social icons can draw (styles/base.css). */
const ICON_NETWORKS: Network[] = ["instagram", "facebook", "youtube", "linkedin", "twitter"];
const LABEL: Record<Network, string> = { twitter: "X", github: "GitHub", facebook: "Facebook", instagram: "Instagram", linkedin: "LinkedIn", youtube: "YouTube" };

type Def = { _type?: string; _key?: string; href?: string };
type Block = { _type?: string; _key?: string; children?: { _type?: string; _key?: string; text?: string; marks?: string[] }[]; markDefs?: Def[] };

/**
 * The migrated footer (any Portable Text in its sections) with Settings → Social Links applied: a link to a network
 * points at the setting's profile, and the footer's row of social links (a paragraph of nothing but profile links)
 * gains the networks set in Settings that it does not show yet. Empty settings leave the migrated links as they are.
 * Returns copies: the entry may be shared with other requests.
 */
export function withSocial<T>(content: T, s: SettingsData | undefined): T {
	const links = socialLinks(s);
	if (!Object.keys(links).length) return content;
	let rowDone = false;
	const isBlock = (v: unknown): v is Block => !!v && typeof v === "object" && (v as Block)._type === "block" && Array.isArray((v as Block).markDefs);
	const fix = (b: Block): Block => {
		const defs = (b.markDefs ?? []).map((d) => {
			const n = d._type === "link" ? networkOf(d.href) : undefined;
			return n && links[n] ? { ...d, href: links[n] } : { ...d };
		});
		const linkDefs = defs.filter((d) => d._type === "link");
		const used = new Set((b.children ?? []).flatMap((c) => c.marks ?? []));
		const shown = linkDefs.filter((d) => d._key && used.has(d._key));
		const textOnly = (b.children ?? []).every((c) => (c.marks ?? []).some((m) => shown.some((d) => d._key === m)) || !c.text?.trim());
		const isRow = !rowDone && shown.length > 0 && shown.every((d) => networkOf(d.href)) && textOnly;
		if (!isRow) return { ...b, markDefs: defs };
		rowDone = true;
		const have = new Set(shown.map((d) => networkOf(d.href)));
		const add = ICON_NETWORKS.filter((n) => links[n] && !have.has(n));
		return {
			...b,
			markDefs: [...defs, ...add.map((n) => ({ _type: "link", _key: `social-${n}`, href: links[n] }))],
			// A space between links: text links stay apart; in a row of icons (flex) it is dropped.
			children: [...(b.children ?? []).map((c) => ({ ...c })), ...add.flatMap((n) => [{ _type: "span", _key: `social-${n}-gap`, text: " ", marks: [] }, { _type: "span", _key: `social-${n}-text`, text: LABEL[n], marks: [`social-${n}`] }])],
		};
	};
	const walk = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(walk);
		if (isBlock(v)) return fix(v);
		if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
		return v;
	};
	return walk(content) as T;
}

/** Structured data `sameAs`: the business's profiles with Settings → Social Links applied (a network's setting replaces its entry). */
export function sameAsWithSocial(sameAs: string[] | undefined, s: SettingsData | undefined): string[] {
	const links = socialLinks(s);
	const out = (sameAs ?? []).map((u) => {
		const n = networkOf(u);
		return n && links[n] ? links[n] : u;
	});
	for (const n of NETWORKS) if (links[n] && !out.includes(links[n] as string)) out.push(links[n] as string);
	return [...new Set(out)];
}

/** A header/menu link to a social network, pointed at the setting's profile. */
export const socialHrefFor = (href: string, s: SettingsData | undefined) => {
	const n = networkOf(href);
	return (n && socialLinks(s)[n]) || href;
};
