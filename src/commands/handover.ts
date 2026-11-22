/**
 * `wp2emdash handover <slug> [--out <dir>] [--json]`: the client handover pack — handover.html (printable,
 * self-contained) and handover.md — from what this site actually has: kit.config.ts, cloudflare.json, the IR
 * (sections, menus, site parts, forms, users counts, comments, blog, collections) and the generated form definitions.
 *
 * Written to sites/<slug>/handover/ (the gitignored client workspace). `--out` may point anywhere outside the kit
 * repository, or inside this site's own workspace — never into the kit's tracked files. Reads no secrets (.env is never
 * opened), no form messages and no people: role counts come from ir/users.json, never from users/invites.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadConfig } from "../config/load.js";
import { readCf, siteEnvironments } from "../core/environments.js";
import { KIT_ROOT, SITES_DIR, sitePaths } from "../core/paths.js";
import { buildHandover, type HandoverForm, type HandoverInput, type HandoverModel, renderHtml, renderMarkdown } from "../handover/build.js";
import type { IrPage, IrSite, SectionType } from "../ir/schema.js";
import { SECTION_TYPES } from "../ir/schema.js";
import { loadEnv } from "../extract/credentials.js";
import { MONITOR_DIR, OPERATOR_FILE } from "./monitor.js";

export interface HandoverOptions {
	sitesDir?: string;
	out?: string;
	now?: Date;
	/** Agency name / link / contact line (else kit.config credit, WP2EMDASH_AGENCY_* in the environment or kit .env, PixelKraft). */
	agency?: string;
	agencyUrl?: string;
	contact?: string;
	env?: Record<string, string | undefined>;
	/** Folder of the outside-in monitor (default: the kit's monitor/ or WP2EMDASH_MONITOR_DIR). */
	monitorDir?: string;
}

export interface HandoverResult {
	dir: string;
	files: string[];
	model: HandoverModel;
}

const readJson = <T>(file: string): T | undefined => {
	if (!existsSync(file)) return undefined;
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
};
const jsonFiles = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort() : []);
const within = (p: string, base: string) => {
	const d = relative(base, p);
	return d === "" || (!d.startsWith("..") && !isAbsolute(d));
};

/** Where the pack goes: sites/<slug>/handover by default; never into the kit repository outside this site's workspace. */
export function handoverDir(siteRoot: string, out?: string): string {
	const dir = out ? resolve(out) : join(siteRoot, "handover");
	if (within(dir, KIT_ROOT) && !within(dir, resolve(siteRoot))) throw new Error(`Refused: ${dir} is inside the kit repository. The pack holds client details: write it to sites/<slug>/handover (default) or a folder outside the kit.`);
	return dir;
}

/** Everything the pack needs, read from the site's workspace. */
export async function gatherHandover(slug: string, o: HandoverOptions = {}): Promise<HandoverInput> {
	const paths = sitePaths(slug, o.sitesDir ?? SITES_DIR);
	if (!existsSync(paths.config)) throw new Error(`No site "${slug}" (${paths.config} not found)`);
	const config = await loadConfig(paths.config);
	const site = readJson<IrSite>(join(paths.ir, "site.json"));
	if (!site) throw new Error(`No transform output for ${slug}: run \`wp2emdash run ${slug} transform\` first (ir/site.json missing)`);
	const cf = readCf(paths.root);
	const envs = siteEnvironments(config, cf);
	const ir = paths.ir;
	const load = (d: string) => jsonFiles(join(ir, d)).map((f) => readJson<IrPage>(join(ir, d, f))).filter((p): p is IrPage => !!p);
	const pages = load("pages").filter((p) => p.kind === "page");
	const posts = readJson<unknown>(join(ir, "blog.json")) ? load("posts").filter((p) => p.kind === "post") : [];
	const cpt = readJson<{ collections: { slug: string; label: string; shop?: boolean }[] }>(join(ir, "collections.json"));
	const entries = (cpt?.collections ?? []).flatMap((c) => load(join("entries", c.slug)));
	const partials = site.partials.map((p) => readJson<IrPage>(join(ir, p.file))).filter((p): p is IrPage => !!p);
	const popups = site.popups.map((p) => readJson<IrPage>(join(ir, p.file))).filter((p): p is IrPage => !!p);
	const docs = [...pages, ...posts, ...entries, ...partials, ...popups];

	// Section types used anywhere, in the library's order.
	const counts = new Map<SectionType, number>();
	for (const d of docs) for (const s of d.sections) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
	const sections = SECTION_TYPES.filter((t) => counts.has(t)).map((type) => ({ type, count: counts.get(type) ?? 0 }));

	// Forms: the generated definitions (project/src/forms), else the IR's own (Bricks), and where each is placed.
	const placed = new Map<string, string[]>();
	for (const d of [...pages, ...posts, ...entries, ...partials, ...popups])
		for (const s of d.sections)
			if (s.type === "form") {
				const id = `${s.fields.formRef.provider}-${s.fields.formRef.id}`;
				const where = d.kind === "partial" ? "every page" : d.kind === "popup" ? `popup “${d.title}”` : (d.route?.path ?? `/${d.source.slug}/`);
				placed.set(id, [...new Set([...(placed.get(id) ?? []), where])]);
			}
	type Def = { id: string; title?: string; fields?: { type: string }[] };
	const defs = new Map<string, Def>();
	for (const dir of [join(ir, "forms"), join(paths.project, "src", "forms")]) for (const f of jsonFiles(dir)) {
		const d = readJson<Def>(join(dir, f));
		if (d?.id) defs.set(d.id, d);
	}
	const forms: HandoverForm[] = [...new Set([...defs.keys(), ...placed.keys()])].sort().map((id) => {
		const d = defs.get(id);
		return { id, title: d?.title?.trim() || `Form ${id}`, pages: placed.get(id) ?? [], ...(d?.fields?.some((x) => x.type === "file") ? { uploads: true } : {}) };
	});

	const users = readJson<{ invite?: HandoverInput["invites"] }>(join(ir, "users.json"));
	const consentPlan = readJson<{ mode?: "off" | "notice" | "opt-in" | "auto" }>(join(ir, "consent.json"));
	const comments = readJson<{ migrate: boolean; collections: { form: boolean; approved: number }[] }>(join(ir, "comments.json"));
	const commentsOn = !!comments?.collections.some((c) => c.form || (comments.migrate && c.approved > 0));
	const reusable = readJson<{ sections: unknown[] }>(join(ir, "sections.json"))?.sections.length ?? 0;
	const widgetAreas = readJson<{ areas: unknown[] }>(join(ir, "widgets.json"))?.areas.length ?? 0;
	const health = config.health;
	const backups = config.backups;
	const consent = config.consent;

	const env = o.env ?? { ...loadEnv(join(KIT_ROOT, ".env")), ...process.env };
	const credit = config.credit === false ? undefined : config.credit;
	const agency = {
		name: o.agency ?? env.WP2EMDASH_AGENCY_NAME ?? credit?.name ?? "PixelKraft",
		url: o.agencyUrl ?? env.WP2EMDASH_AGENCY_URL ?? credit?.url ?? "https://pixelkraft.net",
		...((o.contact ?? env.WP2EMDASH_AGENCY_CONTACT) ? { contact: (o.contact ?? env.WP2EMDASH_AGENCY_CONTACT) as string } : {}),
	};
	const stagingUrl = config.target.stagingUrl ?? cf.staging?.worker?.url;
	const monitorDir = o.monitorDir ?? MONITOR_DIR;

	return {
		name: config.name,
		slug: config.slug,
		generatedAt: (o.now ?? new Date()).toISOString(),
		productionUrl: config.target.productionUrl,
		live: envs.live,
		...(cf.production?.worker?.url ? { workersDevUrl: cf.production.worker.url } : {}),
		keepWorkersDev: config.target.keepWorkersDev,
		...(envs.staging ? { staging: stagingUrl ? { url: stagingUrl } : {} } : {}),
		aliasDomains: config.target.aliasDomains,
		sessionDays: config.sessions.days,
		emailProvider: config.email.provider,
		emailTo: config.email.to,
		sections,
		pages: pages.length,
		posts: posts.length,
		collections: (cpt?.collections ?? []).map((c) => c.label),
		menus: site.menus.map((m) => ({ name: m.name, role: m.role, items: m.items.length, ...(m.lang ? { lang: m.lang } : {}) })),
		siteParts: { header: site.partials.some((p) => p.role === "header"), footer: site.partials.some((p) => p.role === "footer"), announcement: site.partials.some((p) => p.role === "announcement") },
		popups: popups.length,
		reusableSections: reusable,
		widgetAreas,
		protectedPages: [...pages, ...posts].filter((d) => d.access?.as === "protect").length,
		...(site.i18n?.languages.length ? { multilingual: site.i18n.languages.map((l) => l.label) } : {}),
		forms,
		...(config.forms.outbox ? { formsInbox: { days: config.forms.outbox.days, keepSent: config.forms.outbox.keepSent } } : {}),
		formChat: !!config.forms.outbox && config.forms.chat !== false,
		spamProtection: !!config.forms.turnstileSiteKey,
		...(config.sensitiveData ? { sensitiveNotice: config.forms.notice } : {}),
		plugins: {
			seo: config.seo.panel,
			fixit: config.seo.panel && !config.sensitiveData,
			...(health !== false ? { health: { reportTo: health.reportTo ?? config.email.to, monthlyReport: health.monthlyReport } } : {}),
			...(backups !== false ? { backups: { daily: backups.retention.daily, monthly: backups.retention.monthly, ...(backups.restoreDrill !== false ? { restoreTestDays: backups.restoreDrill.everyDays } : {}), offsite: !!backups.offsite } } : {}),
			...(consent !== false ? { consent: { mode: consent.mode ?? consentPlan?.mode ?? "auto" } } : {}),
			comments: commentsOn,
			changeRequests: config.changeRequests !== false,
			media: config.media !== false,
			og: config.og.cards,
			motion: config.motionPanel,
		},
		invites: users?.invite ?? {},
		outsideMonitor: (envs.live || !!cf.production?.worker?.url) && existsSync(join(monitorDir, OPERATOR_FILE)),
		monitorDays: config.target.cutover.monitorDays,
		keepWordPressDays: config.target.cutover.keepWordPressDays,
		agency,
	};
}

export async function handover(slug: string, o: HandoverOptions = {}): Promise<HandoverResult> {
	const paths = sitePaths(slug, o.sitesDir ?? SITES_DIR);
	const dir = handoverDir(paths.root, o.out);
	const model = buildHandover(await gatherHandover(slug, o));
	mkdirSync(dir, { recursive: true });
	const files = [join(dir, "handover.html"), join(dir, "handover.md")];
	writeFileSync(files[0] as string, renderHtml(model));
	writeFileSync(files[1] as string, renderMarkdown(model));
	return { dir, files, model };
}
