/**
 * Phase 2 — extract. Pulls everything needed to rebuild the site from WordPress, read-only:
 * EmDash Exporter API (raw content with shortcodes, all meta, Rank Math, menus, options, media,
 * taxonomies, comments), Salient global sections, form definitions + notification settings
 * (never submissions), and a downloaded copy of every referenced media file.
 * Output lives in sites/<slug>/raw/ (gitignored). Report: reports/extract/extract.md.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchUrl, mapLimit } from "../audit/http.js";
import { externalMediaDecision, loadOverrides } from "../config/overrides.js";
import type { GateCheck } from "../core/state.js";
import { extractReport } from "../extract/report.js";
import { WpClient, WpHttpError, versionAtLeast } from "../extract/client.js";
import { loadSiteEnv, redact, resolveCredentials } from "../extract/credentials.js";
import { bricksMediaRefs, bricksOptionsNote, readBricksOptions, usesBricks } from "../extract/bricks.js";
import { type RedirectRule, recognise, type Unconverted } from "../extract/plugin-exports.js";
import { findMediaRefs, type MediaRef, uploadsKey } from "../extract/refs.js";
import { type CustomCss, customCssFromHtml } from "../transform/custom-css.js";
import type { PhaseContext } from "./index.js";

export const MIN_EXPORTER = "1.2.0";

/** Post types that are WordPress internals or rebuilt from other sources. `custom_css` is read on its own (readCustomCss). */
const SKIP_TYPES = new Set(["attachment", "nav_menu_item", "wp_template", "wp_template_part", "wp_global_styles", "wp_font_family", "wp_font_face", "revision", "customize_changeset", "oembed_cache", "user_request", "custom_css"]);
/** Types worth asking for even when no listing advertises them. */
const EXTRA_TYPES = ["salient_g_sections", "bricks_template", "wp_block", "wp_navigation", "nectar_slider", "home_slider", "portfolio", "popup", "popup_theme", "pum_cta", "rank_math_schema"];

export interface ExporterPost {
	id: number;
	post_type: string;
	status: string;
	slug: string;
	title: string;
	content: string;
	excerpt: string;
	date_gmt: string;
	modified_gmt: string;
	parent: number | null;
	menu_order: number;
	taxonomies: Record<string, { id: number; name: string; slug: string }[]>;
	featured_image?: { id: number; url: string };
	meta: Record<string, unknown>;
	rankmath?: Record<string, string>;
	yoast?: Record<string, string>;
	author?: unknown;
}

export interface ExporterMedia {
	id: number;
	url: string;
	filename: string;
	mime_type: string;
	title: string;
	alt: string;
	caption: string;
	description: string;
	width?: number;
	height?: number;
	filesize?: number;
}

interface Probe {
	emdash_exporter: string;
	wordpress_version: string;
	site: { url: string; home: string; title: string; language: string };
	capabilities: Record<string, boolean>;
	post_types: { name: string; count: number }[];
	media_count: number;
	i18n?: unknown;
}

interface Analyze {
	post_types: { name: string; total: number; by_status: Record<string, number>; custom_fields: { key: string; count: number }[] }[];
	taxonomies: { name: string; term_count: number }[];
	authors: { id: number; login: string; email?: string; display_name: string; post_count: number }[];
	attachments: { count: number; by_type: Record<string, number> };
}

export interface MediaEntry {
	id?: number;
	url: string;
	/** Path under raw/media/. */
	file?: string;
	bytes?: number;
	sha1?: string;
	mime?: string;
	alt?: string;
	title?: string;
	caption?: string;
	width?: number;
	height?: number;
	inLibrary: boolean;
	referencedBy: string[];
	status: "downloaded" | "cached" | "failed";
	error?: string;
}

export interface ExtractSummary {
	extractedAt: string;
	exporter: { version: string; wordpress: string; capabilities: Record<string, boolean> };
	credentialSource: string;
	types: { name: string; fetched: number; expected?: number; byStatus: Record<string, number>; latestModifiedGmt?: string }[];
	media: { library: number; downloaded: number; cached: number; failed: number; unlisted: number; bytes: number };
	refs: { ids: number; unresolvedIds: { id: string; posts: string[] }[]; externalMedia: { url: string; status: number; posts: string[] }[]; brokenUploads: { url: string; status: number; posts: string[] }[] };
	menus: { name: string; locations: string[]; items: number }[];
	forms: { provider: string; id: string; title: string; status: string; fields: number; notifications: number; ok: boolean; error?: string }[];
	auditCrossCheck: { missingFromExtract: string[]; privateNotInAudit: string[] };
	notes: string[];
}

const write = (file: string, data: unknown) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
};
const readJson = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined);

export async function runExtract({ config, paths, reporter }: PhaseContext): Promise<GateCheck[]> {
	const checks: GateCheck[] = [];
	const check = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id, label, ok, ...(detail ? { detail } : {}) });
	const notes: string[] = [];
	const overrides = await loadOverrides(paths.overrides);

	// ── Credentials ────────────────────────────────────────────────────────────
	const env = loadSiteEnv(paths.root);
	let creds: ReturnType<typeof resolveCredentials>;
	try {
		creds = resolveCredentials(env);
	} catch (e) {
		check("credentials", "Exporter credentials in .env", false, (e as Error).message);
		return checks;
	}
	if (!creds) {
		check("credentials", "Exporter credentials in .env", false, "Set EMDASH_WP_MIGRATION_KEY (or WP_APP_USER + WP_APP_PASSWORD) in sites/<slug>/.env");
		return checks;
	}
	const sourceHost = new URL(config.source.url).host.replace(/^www\./, "");
	if (creds.url && new URL(creds.url).host.replace(/^www\./, "") !== sourceHost) {
		check("credentials", "Exporter credentials in .env", false, `Migration key is for ${new URL(creds.url).host}, config source is ${sourceHost}`);
		return checks;
	}
	check("credentials", "Exporter credentials in .env", true, creds.source);

	const client = new WpClient(creds.url ?? config.source.url, creds);
	const raw = paths.raw;
	const exp = join(raw, "exporter");
	rmSync(join(exp, "content"), { recursive: true, force: true });
	mkdirSync(join(exp, "content"), { recursive: true });

	// ── Probe + analyze ────────────────────────────────────────────────────────
	reporter.emit({ type: "step:start", step: "Exporter probe" });
	let probe: Probe;
	try {
		probe = await client.get<Probe>("emdash/v1/probe", {}, false);
	} catch (e) {
		check("exporter", `EmDash Exporter ${MIN_EXPORTER}+ reachable`, false, e instanceof WpHttpError && e.status === 404 ? "Exporter not installed or REST blocked (404)" : redact((e as Error).message, creds));
		return checks;
	}
	write(join(exp, "probe.json"), probe);
	const exporterOk = versionAtLeast(probe.emdash_exporter, MIN_EXPORTER);
	check("exporter", `EmDash Exporter ${MIN_EXPORTER}+ reachable`, exporterOk, `v${probe.emdash_exporter}, WordPress ${probe.wordpress_version}`);
	if (!exporterOk) return checks;

	let analyze: Analyze;
	try {
		analyze = await client.get<Analyze>("emdash/v1/analyze");
	} catch (e) {
		const status = e instanceof WpHttpError ? e.status : 0;
		check("auth", "Authenticated read access", false, status === 401 || status === 403 ? `HTTP ${status}: application password rejected or revoked, or a security plugin strips the Authorization header` : redact((e as Error).message, creds));
		return checks;
	}
	// Author emails are not needed downstream; keep raw free of them.
	analyze.authors = analyze.authors.map(({ email: _e, ...a }) => a);
	write(join(exp, "analyze.json"), analyze);
	check("auth", "Authenticated read access", true, "application password accepted");
	reporter.emit({ type: "step:end", step: "Exporter probe", ok: true, detail: `exporter v${probe.emdash_exporter}, ${probe.media_count} media` });

	// ── Content per post type ─────────────────────────────────────────────────
	const wpTypes = await client.tryGet<Record<string, unknown>>("wp/v2/types", { context: "edit" }).catch(() => undefined);
	const candidateTypes = [...new Set([...probe.post_types.map((t) => t.name), ...analyze.post_types.map((t) => t.name), ...Object.keys(wpTypes ?? {}), ...EXTRA_TYPES])].filter((t) => !SKIP_TYPES.has(t));
	reporter.emit({ type: "step:start", step: "Content", total: candidateTypes.length });
	const byType = new Map<string, ExporterPost[]>();
	const typeSummaries: ExtractSummary["types"] = [];
	let typeErrors = 0;
	for (const [i, type] of candidateTypes.entries()) {
		reporter.emit({ type: "step:progress", step: "Content", done: i, total: candidateTypes.length, item: type });
		try {
			const r = await client.all<ExporterPost>("emdash/v1/content", { post_type: type, status: "any" }, 100);
			if (!r.items.length) continue;
			for (const p of r.items) {
				// Strip author emails (PII not needed for the rebuild).
				if (p.author && typeof p.author === "object") delete (p.author as Record<string, unknown>).email;
			}
			byType.set(type, r.items);
			write(join(exp, "content", `${type}.json`), r.items);
			const byStatus: Record<string, number> = {};
			for (const p of r.items) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
			const latest = r.items.map((p) => p.modified_gmt).sort().at(-1);
			typeSummaries.push({ name: type, fetched: r.items.length, expected: analyze.post_types.find((t) => t.name === type)?.total, byStatus, ...(latest ? { latestModifiedGmt: latest } : {}) });
		} catch (e) {
			if (e instanceof WpHttpError && (e.status === 400 || e.status === 404)) continue; // type not exportable / not registered
			typeErrors++;
			reporter.emit({ type: "log", level: "error", message: `content ${type}: ${redact((e as Error).message, creds)}` });
		}
	}
	const totalPosts = [...byType.values()].reduce((n, l) => n + l.length, 0);
	reporter.emit({ type: "step:end", step: "Content", ok: typeErrors === 0, detail: `${totalPosts} entries in ${byType.size} types` });
	check("content-fetched", "All post types fetched", typeErrors === 0, `${totalPosts} entries: ${typeSummaries.map((t) => `${t.name} ${t.fetched}`).join(", ")}`);

	const mismatched = typeSummaries.filter((t) => t.expected !== undefined && t.expected !== t.fetched);
	check("counts-match", "Fetched counts match the exporter's own totals", mismatched.length === 0, mismatched.map((t) => `${t.name}: ${t.fetched}/${t.expected}`).join(", ") || undefined);

	// ── Customizer Additional CSS (never a content type; reported in transform, carried only by decision) ──────
	const customCss = await readCustomCss(paths.snapshot, async () => {
		try {
			return (await client.all<ExporterPost>("emdash/v1/content", { post_type: "custom_css", status: "any" }, 100)).items;
		} catch {
			return []; // the exporter may refuse non-public types; the live pages still carry the active theme's CSS
		}
	});
	rmSync(join(raw, "custom-css.json"), { force: true });
	if (customCss) {
		write(join(raw, "custom-css.json"), customCss);
		notes.push(`Customizer Additional CSS found (${(Buffer.byteLength(customCss.css) / 1024).toFixed(1)} KB, from the ${customCss.source === "live-html" ? "live pages" : "theme's custom_css post"}): listed in the transform report; carried only by decision (overrides.ts customCss).`);
	}

	// ── Site structure: options, menus, taxonomies, comments ──────────────────
	reporter.emit({ type: "step:start", step: "Options, menus, taxonomies" });
	const options = await client.get<Record<string, unknown>>("emdash/v1/options");
	delete options.admin_email;
	write(join(exp, "options.json"), options);
	const menus = (await client.tryGet<{ id: number; name: string; label?: string; locations: string[]; items: unknown[] }[]>("emdash/v1/menus")) ?? [];
	write(join(exp, "menus.json"), menus);
	const taxonomies = (await client.tryGet<unknown[]>("emdash/v1/taxonomies")) ?? [];
	write(join(exp, "taxonomies.json"), taxonomies);
	let comments: unknown[] = [];
	try {
		comments = (await client.all<unknown>("emdash/v1/comments", {}, 500)).items;
	} catch (e) {
		if (!(e instanceof WpHttpError && e.status === 404)) throw e;
	}
	write(join(exp, "comments.json"), comments);
	reporter.emit({ type: "step:end", step: "Options, menus, taxonomies", ok: true, detail: `${menus.length} menus, ${comments.length} comments` });
	const auditMenu = readJson<{ found?: boolean }[]>(join(paths.snapshot, "interactions.json"));
	const siteHasMenu = Array.isArray(auditMenu) ? auditMenu.some((m) => m?.found) : true;
	check("menus", "Navigation menus extracted", !siteHasMenu || menus.length > 0, menus.map((m) => `${m.name} (${m.items.length} items → ${m.locations.join(", ") || "no location"})`).join("; ") || "none");

	// ── Global sections (Salient footer/header blocks) ────────────────────────
	const fingerprint = readJson<{ uploadsBase?: string; restUploadsBase?: string; hiddenWpPaths?: boolean; builders?: string[]; parentTheme?: string; themes?: string[] }>(join(paths.snapshot, "fingerprint.json"));
	const isSalient = /salient/i.test(JSON.stringify(fingerprint?.themes ?? fingerprint?.parentTheme ?? config.source.theme ?? ""));
	if (isSalient) {
		const g = byType.get("salient_g_sections") ?? [];
		check("global-sections", "Salient global sections extracted", g.length > 0, g.map((s) => `${s.slug} (${s.status})`).join(", ") || "none found — footer/header content would be missing");
	}

	// ── Forms (definitions + notifications; submissions are never read) ───────
	const formsSummary: ExtractSummary["forms"] = [];
	const auditIntegrations = readJson<{ kind: string; form?: { provider: string; providerFormId?: string } }[]>(join(paths.snapshot, "integrations.json")) ?? [];
	const auditForms = auditIntegrations.filter((i) => i.kind === "form" && i.form).map((i) => i.form as { provider: string; providerFormId?: string });
	const ffList = await client.tryGet<{ data: { id: string; title: string; status: string }[] }>("fluentform/v1/forms", { per_page: 100 });
	if (ffList) {
		reporter.emit({ type: "step:start", step: "Forms", total: ffList.data.length });
		for (const f of ffList.data) {
			try {
				const form = await client.get<{ form_fields: string } & Record<string, unknown>>(`fluentform/v1/forms/${f.id}`);
				const fields = JSON.parse(form.form_fields || "{}") as { fields?: unknown[] };
				const settings: Record<string, unknown> = {};
				for (const key of ["notifications", "formSettings", "confirmation", "advancedValidationSettings", "double_optin_settings"]) {
					const v = await client.tryGet<unknown[]>(`fluentform/v1/settings/${f.id}`, { meta_key: key });
					if (v && (!Array.isArray(v) || v.length)) settings[key] = v;
				}
				const integrations = await client.tryGet<unknown>(`fluentform/v1/integrations/${f.id}/form-integrations`);
				write(join(raw, "forms", "fluent-forms", `${f.id}.json`), { provider: "fluent-forms", id: f.id, title: f.title, status: f.status, form: { ...form, form_fields: fields }, settings, integrations });
				const notifs = (settings.notifications as unknown[] | undefined)?.length ?? 0;
				formsSummary.push({ provider: "fluent-forms", id: f.id, title: f.title, status: f.status, fields: fields.fields?.length ?? 0, notifications: notifs, ok: true });
			} catch (e) {
				formsSummary.push({ provider: "fluent-forms", id: f.id, title: f.title, status: f.status, fields: 0, notifications: 0, ok: false, error: redact((e as Error).message, creds) });
			}
		}
		reporter.emit({ type: "step:end", step: "Forms", ok: formsSummary.every((f) => f.ok), detail: `${formsSummary.length} Fluent Forms` });
	}
	// ── Plugin exports the owner sent (raw/plugin-exports/, any file name; recognised by content) ─────────────
	const dropDir = join(raw, "plugin-exports");
	const dropped = existsSync(dropDir) ? readdirSync(dropDir).filter((f) => !f.startsWith(".") && statSync(join(dropDir, f)).isFile()) : [];
	if (dropped.length) {
		reporter.emit({ type: "step:start", step: "Plugin exports", total: dropped.length });
		const exportHosts = [new URL(config.source.url).host, new URL(config.target.productionUrl).host, ...config.source.alternateHosts];
		const rules: RedirectRule[] = [];
		const unconverted: Unconverted[] = [];
		const unread: string[] = [];
		for (const file of dropped) {
			const r = recognise(file, readFileSync(join(dropDir, file), "utf8"), exportHosts);
			if (r.kind === "unknown") {
				unread.push(`${file}: ${r.reason}`);
				continue;
			}
			if (r.kind === "redirects") {
				rules.push(...r.rules);
				unconverted.push(...r.unconverted);
				continue;
			}
			for (const f of r.forms) {
				// The REST read wins for Fluent Forms; the file only fills in forms it could not reach.
				if (formsSummary.some((s) => s.ok && s.provider === f.provider && s.id === f.id)) continue;
				const out = f.raw ? { ...f.raw, recipients: f.recipients ?? [], source: file } : { provider: f.provider, id: f.id, title: f.title, status: f.status, definition: f.definition, recipients: f.recipients ?? [], source: file };
				write(join(raw, "forms", f.provider, `${f.id}.json`), out);
				formsSummary.push({ provider: f.provider, id: f.id, title: f.title, status: f.status, fields: f.definition?.fields.length ?? 0, notifications: f.recipients?.length ?? 0, ok: true });
			}
		}
		// Later files win for the same source (an owner may send an updated export).
		const bySource = new Map(rules.map((r) => [r.source, r]));
		if (rules.length || unconverted.length) write(join(raw, "redirects.json"), { rules: [...bySource.values()], unconverted });
		check("plugin-exports", "Every plugin export file was read", unread.length === 0, unread.length ? `Not read: ${unread.join("; ")} — rebuild by hand and record it in decisions.md, or remove the file` : `${dropped.length} file(s)`);
		if (rules.length || unconverted.length)
			check("redirects-convertible", "Every redirect rule fits EmDash's redirects", unconverted.length === 0, unconverted.length ? `${unconverted.length} kept out (listed in raw/redirects.json → unconverted): ${unconverted.slice(0, 3).map((u) => `${u.rule} (${u.reason})`).join("; ")}${unconverted.length > 3 ? "; …" : ""} — handle at the edge or accept with the owner` : `${bySource.size} rules`);
		reporter.emit({ type: "step:end", step: "Plugin exports", ok: unread.length === 0, detail: `${dropped.length} files, ${formsSummary.length} forms, ${bySource.size} redirects` });
	}

	const missingForms = auditForms.filter((af) => !formsSummary.some((f) => f.ok && f.provider === af.provider && f.id === af.providerFormId));
	check(
		"forms",
		"Every live form has its definition and notification settings",
		missingForms.length === 0,
		missingForms.length ? `Not extracted: ${missingForms.map((f) => `${f.provider}#${f.providerFormId ?? "?"}`).join(", ")} — add an extractor, or record recipients/confirmation in decisions.md and accept` : `${auditForms.length} live form(s) covered`,
	);

	// ── Media library ─────────────────────────────────────────────────────────
	reporter.emit({ type: "step:start", step: "Media library" });
	const library = (await client.all<ExporterMedia>("emdash/v1/media", {}, 500)).items;
	write(join(exp, "media.json"), library);
	check("media-count", "Media library fully listed", library.length === (probe.media_count ?? library.length), `${library.length}/${probe.media_count}`);
	reporter.emit({ type: "step:end", step: "Media library", ok: true, detail: `${library.length} items` });

	// ── References ────────────────────────────────────────────────────────────
	const allPosts = [...byType.values()].flat();
	const refsByPost: Record<string, MediaRef[]> = {};
	for (const p of allPosts) {
		const r = findMediaRefs(p.content ?? "", p.meta ?? {});
		// Bricks keeps its elements in post meta (pages, and header/footer/section templates): their images count too.
		for (const key of ["_bricks_page_content_2", "_bricks_page_header_2", "_bricks_page_footer_2"]) if (p.meta?.[key] !== undefined) r.push(...bricksMediaRefs(p.meta[key]));
		if (p.featured_image?.id) r.push({ kind: "id", value: String(p.featured_image.id), via: "featured_image" });
		if (r.length) refsByPost[`${p.post_type}:${p.id}:${p.slug}`] = r;
	}
	for (const key of ["site_icon", "site_logo", "custom_logo"]) {
		const v = options[key];
		if (typeof v === "number" && v > 0) (refsByPost["options"] ??= []).push({ kind: "id", value: String(v), via: `option:${key}` });
	}
	write(join(raw, "refs.json"), refsByPost);

	const byId = new Map(library.map((m) => [String(m.id), m]));
	const byKey = new Map<string, ExporterMedia>();
	for (const m of library) {
		const k = uploadsKey(m.url);
		if (k) byKey.set(k, m);
	}
	const siteHosts = new Set([new URL(config.source.url).host, ...config.source.alternateHosts].map((h) => h.replace(/^www\./, "")));
	const isSiteUrl = (u: string) => {
		try {
			return u.startsWith("/") || siteHosts.has(new URL(u).host.replace(/^www\./, ""));
		} catch {
			return false;
		}
	};

	const usedIds = new Map<string, Set<string>>();
	const unresolvedIds = new Map<string, Set<string>>();
	const unlisted = new Map<string, Set<string>>(); // site-hosted media URL not in the library
	const external = new Map<string, Set<string>>();
	for (const [post, refs] of Object.entries(refsByPost)) {
		for (const r of refs) {
			if (r.kind === "id") {
				const target = byId.has(r.value) ? usedIds : unresolvedIds;
				(target.get(r.value) ?? target.set(r.value, new Set()).get(r.value))?.add(post);
				continue;
			}
			if (isSiteUrl(r.value)) {
				const k = uploadsKey(r.value);
				const m = k ? byKey.get(k) : undefined;
				if (m) (usedIds.get(String(m.id)) ?? usedIds.set(String(m.id), new Set()).get(String(m.id)))?.add(post);
				else if (k) (unlisted.get(r.value) ?? unlisted.set(r.value, new Set()).get(r.value))?.add(post);
			} else {
				(external.get(r.value) ?? external.set(r.value, new Set()).get(r.value))?.add(post);
			}
		}
	}
	// IDs in shortcode attributes are only treated as unresolved when the attribute is a known image attribute
	// (refs.ts) — report every one so nothing is silently dropped.
	// Published content must resolve; unpublished leftovers (demo pages, private drafts) are reported, not blocking.
	const publishedKeys = new Set(allPosts.filter((p) => p.status === "publish").map((p) => `${p.post_type}:${p.id}:${p.slug}`));
	publishedKeys.add("options");
	const blockingIds = [...unresolvedIds].filter(([, ps]) => [...ps].some((k) => publishedKeys.has(k)));
	const unpublishedOnly = [...unresolvedIds].filter(([, ps]) => ![...ps].some((k) => publishedKeys.has(k)));
	if (unpublishedOnly.length) notes.push(`Unpublished content references missing media (already broken in WordPress): ${unpublishedOnly.map(([id, ps]) => `#${id} in ${[...ps].join(", ")}`).join("; ")}.`);
	check(
		"attachment-ids",
		"Every attachment ID used by published content resolves",
		blockingIds.length === 0,
		blockingIds.length ? blockingIds.map(([id, ps]) => `#${id} in ${[...ps].join(", ")}`).join("; ") : `${usedIds.size} distinct items referenced${unpublishedOnly.length ? `; ${unpublishedOnly.length} missing in unpublished content (see notes)` : ""}`,
	);

	// ── Download media (library + unlisted site uploads) ──────────────────────
	const mediaDir = join(raw, "media");
	const altBase = fingerprint?.hiddenWpPaths && fingerprint.uploadsBase && fingerprint.restUploadsBase ? { from: fingerprint.restUploadsBase, to: fingerprint.uploadsBase } : undefined;
	const absolute = (u: string) => (u.startsWith("/") ? new URL(u, config.source.url).href : u);
	interface Job {
		url: string;
		media?: ExporterMedia;
		referencedBy: string[];
	}
	const jobs: Job[] = [
		...library.map((m) => ({ url: m.url, media: m, referencedBy: [...(usedIds.get(String(m.id)) ?? [])] })),
		...[...unlisted].map(([u, ps]) => ({ url: absolute(u), referencedBy: [...ps] })),
	];
	reporter.emit({ type: "step:start", step: "Download media", total: jobs.length });
	let done = 0;
	const brokenUploads: ExtractSummary["refs"]["brokenUploads"] = [];
	const manifest = await mapLimit(jobs, 4, async (job): Promise<MediaEntry | undefined> => {
		const key = uploadsKey(job.url);
		const rel = key ? (/\/(?:wp-content\/uploads|storage)\/(.+)$/i.exec(job.url.split(/[?#]/)[0] ?? "")?.[1] ?? key) : `external/${createHash("sha1").update(job.url).digest("hex").slice(0, 12)}`;
		const file = join(mediaDir, decodeURIComponent(rel));
		const base: MediaEntry = {
			...(job.media ? { id: job.media.id, mime: job.media.mime_type, alt: job.media.alt, title: job.media.title, caption: job.media.caption, width: job.media.width, height: job.media.height } : {}),
			url: job.url,
			inLibrary: !!job.media,
			referencedBy: job.referencedBy,
			status: "failed",
		};
		const finish = (e: MediaEntry) => {
			reporter.emit({ type: "step:progress", step: "Download media", done: ++done, total: jobs.length, item: rel.slice(-60) });
			return e;
		};
		if (existsSync(file) && statSync(file).size > 0 && (!job.media?.filesize || statSync(file).size === job.media.filesize)) {
			const buf = readFileSync(file);
			return finish({ ...base, file: rel, bytes: buf.length, sha1: createHash("sha1").update(buf).digest("hex"), status: "cached" });
		}
		const candidates = [job.url];
		if (altBase && job.url.includes(altBase.from)) candidates.push(job.url.replace(altBase.from, altBase.to));
		let lastStatus = 0;
		for (const u of candidates) {
			try {
				const r = await client.download(u);
				lastStatus = r.status;
				if (r.bytes && !/text\/html/i.test(r.contentType ?? "")) {
					mkdirSync(dirname(file), { recursive: true });
					writeFileSync(file, r.bytes);
					return finish({ ...base, file: rel, bytes: r.bytes.length, sha1: createHash("sha1").update(r.bytes).digest("hex"), mime: base.mime ?? r.contentType, status: "downloaded" });
				}
			} catch (e) {
				base.error = redact((e as Error).message, creds);
			}
		}
		if (!job.media) {
			// Referenced but not on the server: already broken on the live site.
			brokenUploads.push({ url: job.url, status: lastStatus, posts: job.referencedBy });
			finish(base);
			return undefined;
		}
		return finish({ ...base, error: base.error ?? `HTTP ${lastStatus}` });
	});
	const entries = manifest.filter((m): m is MediaEntry => !!m);
	write(join(raw, "media-manifest.json"), entries);
	const failed = entries.filter((m) => m.status === "failed");
	const bytes = entries.reduce((n, m) => n + (m.bytes ?? 0), 0);
	reporter.emit({ type: "step:end", step: "Download media", ok: failed.length === 0, detail: `${entries.length - failed.length}/${entries.length} files, ${(bytes / 1e6).toFixed(1)} MB` });
	check("media-downloaded", "Every library and referenced upload downloaded", failed.length === 0, failed.length ? failed.map((f) => `${f.url} (${f.error})`).slice(0, 10).join("; ") : `${entries.length} files, ${(bytes / 1e6).toFixed(1)} MB`);

	// External media (CDN videos etc.): check reachability; the owner decides keep-hotlinked vs move to R2.
	const externalList: ExtractSummary["refs"]["externalMedia"] = await mapLimit([...external], 4, async ([u, ps]) => {
		const r = await fetchUrl(u, { headOnly: true, retries: 1 });
		return { url: u, status: r.status, posts: [...ps] };
	});
	const undecided = externalList.filter((e) => !externalMediaDecision(overrides, e.url));
	if (undecided.length) notes.push(`${undecided.length} media file(s) hosted outside WordPress (e.g. ${new URL(undecided[0]?.url ?? "https://x").host}). Decide in overrides.ts → media.external: "copy" (to R2) or "hotlink", with the reason in decisions.md.`);
	for (const e of externalList.filter((x) => externalMediaDecision(overrides, x.url))) notes.push(`Decided: ${e.url} → ${externalMediaDecision(overrides, e.url)}.`);
	if (brokenUploads.length) notes.push(`${brokenUploads.length} upload URL(s) referenced in content already return an error on the live site; listed in the report, fixed or dropped in transform.`);

	// ── Cross-check against the audit ─────────────────────────────────────────
	const discovery = readJson<{ items?: { id: number; type: string; slug: string }[] }>(join(paths.snapshot, "discovery.json"));
	const urls = readJson<{ path: string; kind: string; wp?: { id: number; type: string } }[]>(join(paths.snapshot, "urls.json")) ?? [];
	const extractedIds = new Set(allPosts.map((p) => p.id));
	const missingFromExtract = [
		...(discovery?.items ?? []).filter((i) => !extractedIds.has(i.id)).map((i) => `${i.type}#${i.id} ${i.slug}`),
		...urls.filter((u) => u.wp && !extractedIds.has(u.wp.id)).map((u) => `${u.path} (wp#${u.wp?.id})`),
	];
	const auditIds = new Set([...(discovery?.items ?? []).map((i) => i.id), ...urls.flatMap((u) => (u.wp ? [u.wp.id] : []))]);
	const privateNotInAudit = allPosts.filter((p) => p.post_type === "page" && p.status !== "publish" && !auditIds.has(p.id)).map((p) => `${p.slug} (${p.status})`);
	check("audit-crosscheck", "Every page the audit found is in the extract", missingFromExtract.length === 0, missingFromExtract.join(", ") || `${auditIds.size} audited entries matched`);
	if (privateNotInAudit.length) notes.push(`Not public, kept unpublished in EmDash: ${privateNotInAudit.join(", ")}.`);

	// ── Known gaps that need a human ──────────────────────────────────────────
	// Bricks: palette, global classes, theme styles and components are options the REST API does not serve.
	if (usesBricks(allPosts)) {
		const note = bricksOptionsNote(readBricksOptions(raw, options));
		if (note) notes.push(note);
	}
	if (isSalient) {
		const redux = existsSync(join(raw, "salient-options.json"));
		notes.push(
			redux
				? "Salient theme options found at raw/salient-options.json."
				: "Salient theme options (Redux) are not exposed over REST. Colours, fonts and header layout come from the audit's design capture. Optional for exact values: Salient → Options → Import/Export → download, save as raw/salient-options.json.",
		);
	}
	if (overrides.redirects.source === "unknown" && !existsSync(join(raw, "redirects.json")) && (/seo-by-rank-math|rank-math/i.test(JSON.stringify(fingerprint ?? {})) || probe.capabilities.rankmath)) {
		notes.push("Rank Math redirections are not exposed over REST. If the Redirections module is on: Rank Math → Redirections → Export (.htaccess or Nginx), put the file in raw/plugin-exports/ and rerun extract. Otherwise set redirects.source to \"none\" in overrides.ts.");
	}

	const summary: ExtractSummary = {
		extractedAt: new Date().toISOString(),
		exporter: { version: probe.emdash_exporter, wordpress: probe.wordpress_version, capabilities: probe.capabilities },
		credentialSource: creds.source,
		types: typeSummaries,
		media: { library: library.length, downloaded: entries.filter((e) => e.status === "downloaded").length, cached: entries.filter((e) => e.status === "cached").length, failed: failed.length, unlisted: entries.filter((e) => !e.inLibrary).length, bytes },
		refs: { ids: usedIds.size, unresolvedIds: [...unresolvedIds].map(([id, ps]) => ({ id, posts: [...ps] })), externalMedia: externalList, brokenUploads },
		menus: menus.map((m) => ({ name: m.name, locations: m.locations, items: m.items.length })),
		forms: formsSummary,
		auditCrossCheck: { missingFromExtract, privateNotInAudit },
		notes,
	};
	write(join(raw, "extract.json"), summary);
	const reportDir = join(paths.reports, "extract");
	write(join(reportDir, "extract.md"), extractReport(config.name, summary, checks));
	reporter.emit({ type: "log", level: "info", message: `Report: ${join(reportDir, "extract.md")}` });
	return checks;
}

/**
 * The active theme's Additional CSS: what the live pages print (`<style id="wp-custom-css">`, audit snapshots), else
 * the single custom_css post the exporter returns. Other themes' custom_css posts are listed as inactive.
 */
export async function readCustomCss(snapshotDir: string, exporterPosts: () => Promise<ExporterPost[]>): Promise<CustomCss | undefined> {
	const htmlDir = join(snapshotDir, "html");
	let live: string | undefined;
	if (existsSync(htmlDir)) {
		const files = readdirSync(htmlDir).filter((f) => f.endsWith(".html")).sort((a, b) => (a === "home.html" ? -1 : b === "home.html" ? 1 : a.localeCompare(b)));
		for (const f of files) if ((live = customCssFromHtml(readFileSync(join(htmlDir, f), "utf8")))) break;
	}
	const posts = (await exporterPosts()).filter((p) => (p.content ?? "").trim());
	const same = (p: ExporterPost) => (p.content ?? "").trim() === live;
	if (live) {
		const inactive = posts.filter((p) => !same(p)).map((p) => ({ slug: p.slug, bytes: Buffer.byteLength(p.content) }));
		return { source: "live-html", css: live, ...(inactive.length ? { inactive } : {}) };
	}
	// No saved pages to read: one custom_css post is the active theme's; several cannot be told apart (listed only).
	if (!existsSync(htmlDir) && posts.length === 1) return { source: "exporter", css: (posts[0] as ExporterPost).content.trim() };
	if (posts.length) return { source: "exporter", css: "", inactive: posts.map((p) => ({ slug: p.slug, bytes: Buffer.byteLength(p.content) })) };
	return undefined;
}
