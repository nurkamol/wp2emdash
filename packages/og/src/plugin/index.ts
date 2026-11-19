/**
 * Sharing images — EmDash native plugin (loaded in the Worker from `@wp2emdash/og/plugin`).
 *
 * - `page:metadata` hook: sets og:image, its size/type/alt and the Twitter image. Pages with their own sharing image
 *   keep it (mode "missing", the default) unless the admin chose "always"; either way the size and type of a page's
 *   own image come from EmDash's media table. Plugin contributions win over EmDash's base tags (first wins).
 * - `card` route (public GET, raw PNG): renders a 1200×630 card only for links this site signed (HMAC, secret kept in
 *   the plugin's KV), stores it in R2 under `og-cards/`, and serves it from there afterwards (immutable: the link
 *   changes whenever the card's settings do).
 * - `admin` route: Block Kit settings page with a live preview (admins only, EmDash's default `plugins:manage`).
 */
import { definePlugin, pluginResponse } from "emdash";
import { card, cardTitle } from "../card.js";
import { OG_PLUGIN, type OgCardOptions } from "../index.js";
import { b64url, fromB64url, sign, verify } from "../sign.js";

interface Settings {
	enabled: boolean;
	mode: "missing" | "always";
	eyebrow: string;
	showDomain: boolean;
	previewTitle: string;
	version: number;
}
interface Env {
	ASSETS?: { fetch(req: Request | string): Promise<Response> };
	MEDIA?: { get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>; put(key: string, value: Uint8Array, opts?: unknown): Promise<unknown> };
	DB?: { prepare(q: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } } };
}
interface Kv {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
}

const ROUTE = `/_emdash/api/plugins/${OG_PLUGIN.id}/card`;
const workerEnv = async () => ((await import("cloudflare:workers")) as unknown as { env: Env }).env;

async function settingsOf(kv: Kv, o: OgCardOptions): Promise<Settings> {
	const s = (await kv.get<Partial<Settings>>("settings")) ?? {};
	return { enabled: s.enabled ?? true, mode: s.mode === "always" ? "always" : "missing", eyebrow: s.eyebrow ?? (o.logo ? "" : o.siteName), showDomain: s.showDomain ?? true, previewTitle: s.previewTitle ?? o.siteName, version: s.version ?? 1 };
}

async function secretOf(kv: Kv): Promise<string> {
	const have = await kv.get<string>("secret");
	if (have) return have;
	const s = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
	await kv.set("secret", s);
	return s;
}

/** A signed card link for a title (root-relative). */
async function cardPath(kv: Kv, title: string, version: number): Promise<string> {
	const t = b64url(title);
	return `${ROUTE}?t=${t}&v=${version}&s=${await sign(await secretOf(kv), `${t}.${version}`)}`;
}

/** Static files of the site (fonts, logo), through the Worker's assets binding, cached per isolate. */
const assetCache = new Map<string, Promise<ArrayBuffer>>();
function asset(env: Env, origin: string, path: string): Promise<ArrayBuffer> {
	if (!assetCache.has(path)) {
		const url = new URL(path, origin).toString();
		const p = (env.ASSETS ? env.ASSETS.fetch(url) : fetch(url)).then((r) => {
			if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
			return r.arrayBuffer();
		});
		p.catch(() => assetCache.delete(path));
		assetCache.set(path, p);
	}
	return assetCache.get(path) as Promise<ArrayBuffer>;
}

const dataUri = (bytes: ArrayBuffer, path: string) => {
	const type = /\.svg$/i.test(path) ? "image/svg+xml" : /\.png$/i.test(path) ? "image/png" : "image/jpeg";
	let bin = "";
	const u = new Uint8Array(bytes);
	for (let i = 0; i < u.length; i += 0x8000) bin += String.fromCharCode(...u.subarray(i, i + 0x8000));
	return `data:${type};base64,${btoa(bin)}`;
};

async function renderCard(o: OgCardOptions, s: Settings, title: string, origin: string): Promise<Uint8Array> {
	const env = await workerEnv();
	const { renderPng } = await import("../render.js");
	const [display, body, logo] = await Promise.all([asset(env, origin, o.fonts.display), asset(env, origin, o.fonts.body), o.logo ? asset(env, origin, o.logo).catch(() => undefined) : undefined]);
	const tree = card({ title, ...(s.eyebrow ? { eyebrow: s.eyebrow } : {}), ...(s.showDomain ? { domain: o.domain } : {}), ...(logo && o.logo ? { logo: dataUri(logo, o.logo) } : {}), colors: o.colors });
	return renderPng(tree, { display, body, ...(o.displayWeight ? { displayWeight: o.displayWeight } : {}) });
}

const prop = (property: string, content: string) => ({ kind: "property" as const, property, content });
const meta = (name: string, content: string) => ({ kind: "meta" as const, name, content });

export function createPlugin(options: OgCardOptions) {
	const o = options;
	return definePlugin({
		...OG_PLUGIN,
		admin: { pages: [{ path: "/sharing-images", label: "Sharing images", icon: "image" }] },
		hooks: {
			"page:metadata": async (event, ctx) => {
				const s = await settingsOf(ctx.kv, o);
				if (!s.enabled) return null;
				const page = event.page;
				const origin = URL.canParse(page.url) ? new URL(page.url).origin : undefined;
				if (!origin) return null;
				const own = page.seo?.ogImage || page.image;
				if (own && s.mode === "missing") {
					// The page's own image: EmDash sets og:image; add what link previews use to lay out the card.
					const key = /\/_emdash\/api\/media\/file\/([^/?#]+)$/.exec(own)?.[1];
					const env = await workerEnv();
					const row = key && env.DB ? await env.DB.prepare("SELECT width, height, mime_type FROM media WHERE storage_key = ? LIMIT 1").bind(decodeURIComponent(key)).first<{ width: number | null; height: number | null; mime_type: string | null }>().catch(() => null) : null;
					const alt = page.pageTitle ?? page.title;
					return [...(alt ? [prop("og:image:alt", alt)] : []), ...(row?.width ? [prop("og:image:width", String(row.width))] : []), ...(row?.height ? [prop("og:image:height", String(row.height))] : []), ...(row?.mime_type?.startsWith("image/") ? [prop("og:image:type", row.mime_type)] : [])];
				}
				const title = cardTitle(page.seo?.ogTitle ?? page.pageTitle ?? page.title ?? o.siteName, o.siteName);
				const url = `${origin}${await cardPath(ctx.kv, title, s.version)}`;
				return [prop("og:image", url), prop("og:image:width", "1200"), prop("og:image:height", "630"), prop("og:image:type", "image/png"), prop("og:image:alt", title), meta("twitter:card", "summary_large_image"), meta("twitter:image", url)];
			},
		},
		routes: {
			card: {
				public: true,
				methods: ["GET"],
				request: { body: "none" },
				response: "raw",
				cacheControl: "public, max-age=31536000, immutable",
				handler: async (ctx) => {
					const q = (ctx.input ?? {}) as Record<string, string | string[]>;
					const one = (k: string) => (Array.isArray(q[k]) ? q[k][0] : q[k]) as string | undefined;
					const t = one("t") ?? "";
					const v = one("v") ?? "";
					const sig = one("s") ?? "";
					const notFound = () => pluginResponse({ status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: { kind: "text", value: "Not found" } });
					if (!/^[\w-]{1,400}$/.test(t) || !/^\d{1,6}$/.test(v) || !(await verify(await secretOf(ctx.kv), `${t}.${v}`, sig))) return notFound();
					const env = await workerEnv();
					const key = `og-cards/${sig}.png`;
					const stored = await env.MEDIA?.get(key).catch(() => null);
					let png: Uint8Array;
					if (stored) png = new Uint8Array(await stored.arrayBuffer());
					else {
						const s = await settingsOf(ctx.kv, o);
						png = await renderCard(o, s, fromB64url(t), new URL(ctx.request.url).origin);
						await env.MEDIA?.put(key, png, { httpMetadata: { contentType: "image/png" } }).catch(() => {});
					}
					return pluginResponse({ status: 200, headers: { "content-type": "image/png" }, body: { kind: "bytes", value: png } });
				},
			},
			admin: {
				permission: "plugins:manage",
				handler: async (ctx) => {
					if ((ctx.user?.role ?? 0) < 50) return { blocks: [{ type: "banner", title: "Admins only", variant: "error" }] };
					const i = (ctx.input ?? {}) as { type?: string; action_id?: string; values?: Record<string, unknown> };
					let s = await settingsOf(ctx.kv, o);
					let toast: { message: string; type: "success" | "info" } | undefined;
					if (i.type === "form_submit" && i.action_id === "save") {
						const v = i.values ?? {};
						s = {
							...s,
							enabled: v.enabled !== false,
							mode: v.mode === "always" ? "always" : "missing",
							eyebrow: typeof v.eyebrow === "string" ? v.eyebrow.slice(0, 60) : s.eyebrow,
							showDomain: v.showDomain !== false,
							previewTitle: typeof v.previewTitle === "string" && v.previewTitle.trim() ? v.previewTitle.slice(0, 120) : s.previewTitle,
							version: s.version + 1,
						};
						await ctx.kv.set("settings", s);
						toast = { message: "Saved. Every page gets a fresh card.", type: "success" };
					}
					if (i.type === "block_action" && i.action_id === "regenerate") {
						s = { ...s, version: s.version + 1 };
						await ctx.kv.set("settings", s);
						toast = { message: "Every card will be drawn again on its next view.", type: "success" };
					}
					const preview = await cardPath(ctx.kv, cardTitle(s.previewTitle, o.siteName), s.version);
					return {
						blocks: [
							{ type: "header", text: "Sharing images" },
							{ type: "context", text: "The picture shown when a page is shared on social networks and in messengers (og:image): a card with the logo, the page title and the site's colours and fonts, made automatically for every page." },
							{ type: "image", url: preview, alt: `Sharing card preview: ${s.previewTitle}`, title: "Preview" },
							{
								type: "form",
								block_id: "settings",
								fields: [
									{ type: "toggle", action_id: "enabled", label: "Make sharing cards", initial_value: s.enabled },
									{ type: "select", action_id: "mode", label: "Use the card on", options: [{ label: "Pages without their own sharing image", value: "missing" }, { label: "Every page (replaces page images)", value: "always" }], initial_value: s.mode },
									{ type: "text_input", action_id: "eyebrow", label: "Line above the title", initial_value: s.eyebrow, placeholder: o.siteName },
									{ type: "toggle", action_id: "showDomain", label: `Show ${o.domain}`, initial_value: s.showDomain },
									{ type: "text_input", action_id: "previewTitle", label: "Preview title", initial_value: s.previewTitle },
								],
								submit: { label: "Save", action_id: "save" },
							},
							{ type: "actions", elements: [{ type: "button", action_id: "regenerate", label: "Redraw all cards", style: "secondary", confirm: { title: "Redraw every card?", text: "Each card is drawn again the next time it is viewed. Networks that already cached a card may keep showing it for a while.", confirm: "Redraw", deny: "Cancel" } }] },
							{ type: "context", text: "Cards are 1200×630 PNG, stored in the site's media storage and served with a long cache. Networks cache shared links: use their debug tools (e.g. Facebook Sharing Debugger) to refresh a preview." },
						],
						...(toast ? { toast } : {}),
					};
				},
			},
		},
	});
}

export default createPlugin;
