/**
 * Section inspector (docs/PLAN.md §10b feature 2). For one page × viewport: the WordPress row boxes measured on the audit
 * screenshot (snapshot/screens.json), the IR sections each row became (ir/), the raw shortcode / block source of that
 * row (raw/exporter/content/), and the verify crops. Read-only: "change type" and "drop" create a proposal that patches
 * overrides.ts → elements (approved in the queue, then transform reruns), never an edit of ir/ or the project.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBlocks, type Block } from "../adapters/gutenberg/index.js";
import { type AstNode, parseShortcodes, serialise } from "../adapters/wpbakery/parser.js";
import type { SectionBox, ScreenshotResult } from "../audit/browser.js";
import { loadOverrides } from "../config/overrides.js";
import { SITES_DIR, sitePaths } from "../core/paths.js";
import { createProposal } from "../core/proposals.js";
import { SECTION_TYPES } from "../ir/schema.js";
import type { VerifyResult } from "../phases/verify.js";
import { overridesTemplate } from "../templates/site.js";
import { sourceRowIndex } from "../verify/sections.js";
import { siteFileUrl, UserError, verifyFileUrl } from "./data.js";
import { oneLine, unifiedDiff } from "./queue.js";

const readJson = <T>(file: string): T | undefined => {
	try {
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
	} catch {
		return undefined;
	}
};

interface IrSectionLike {
	type: string;
	sourceRef?: { adapter?: string; path?: string; rawHash?: string };
	[k: string]: unknown;
}
interface IrDoc {
	kind: string;
	source: { wpId: number; type: string; slug: string; builder?: string };
	route?: { path: string };
	title?: string;
	sections: IrSectionLike[];
}

export interface InspectorSection {
	/** Index in its document (page or footer partial). */
	index: number;
	footer: boolean;
	type: string;
	path: string;
	/** The overrides.ts → elements key for this section's source row. */
	overrideKey: string;
	override?: string;
	json: IrSectionLike;
	raw?: { text: string; note: string };
}

export interface InspectorRegion {
	index: number;
	footer: boolean;
	y: number;
	height: number;
	label: string;
	/** Indexes into `sections` (same footer flag). */
	sections: number[];
	verify?: { ratio: number; over: boolean; types: string[]; note?: string; images?: { source?: string; target?: string; diff?: string } };
}

export interface InspectorView {
	page: { path: string; name: string; title?: string; irFile?: string; builder?: string };
	viewport: string;
	viewports: string[];
	sourceImage?: string;
	/** Page height in CSS px of the screenshot (boxes are in the same unit). */
	pageHeight?: number;
	regions: InspectorRegion[];
	sections: InspectorSection[];
	sectionTypes: string[];
	visualLimit?: number;
	notes: string[];
}

const RAW_MAX = 20_000;

function loadIrDocs(irDir: string): { file: string; doc: IrDoc }[] {
	const out: { file: string; doc: IrDoc }[] = [];
	for (const sub of ["pages", "posts"]) {
		const dir = join(irDir, sub);
		if (!existsSync(dir)) continue;
		for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
			const doc = readJson<IrDoc>(join(dir, f));
			if (doc?.sections) out.push({ file: `${sub}/${f}`, doc });
		}
	}
	return out;
}

/** `vc_row[3]#1` → `vc_row[3]`: the row path the adapters look up in overrides.elements. */
export const rowPathOf = (path: string): string => path.replace(/#\d+$/, "");

// ── Raw source by path ────────────────────────────────────────────────────────────────────────────────────────

/** Same row numbering as the WPBakery adapter (src/adapters/wpbakery/index.ts → Rows). */
function wpbakeryRows(content: string): Map<string, string> {
	const rows = new Map<string, string>();
	let count = 0;
	const ast = parseShortcodes(content);
	const loose: AstNode[] = [];
	const flushLoose = (at: number) => {
		if (!loose.length) return;
		rows.set(`loose[${at}]`, loose.splice(0).map((n) => (n.type === "text" ? n.text : serialise(n))).join(""));
		count++;
	};
	ast.forEach((node, i) => {
		if (node.type === "shortcode" && (node.tag === "vc_row" || node.tag === "vc_section")) {
			flushLoose(i);
			const path = `${node.tag}[${count}]`;
			if (node.attrs.disable_element === "yes") return;
			if (node.tag === "vc_section") {
				for (const [j, inner] of node.children.entries())
					if (inner.type === "shortcode" && inner.tag === "vc_row") {
						rows.set(`${path}/vc_row[${j}]`, serialise(inner));
						count++;
					}
				return;
			}
			rows.set(path, serialise(node));
			count++;
		} else loose.push(node);
	});
	flushLoose(ast.length);
	return rows;
}

function blockSource(b: Block): string {
	if (b.name === "core/freeform") return b.innerHTML;
	const name = b.name.replace(/^core\//, "");
	const attrs = Object.keys(b.attrs).length ? ` ${JSON.stringify(b.attrs)}` : "";
	return `<!-- wp:${name}${attrs} -->${b.innerHTML}${b.innerBlocks.map(blockSource).join("\n")}<!-- /wp:${name} -->`;
}

function rawFor(path: string, content: string | undefined, builder: string | undefined): { text: string; note: string } | undefined {
	if (content === undefined) return undefined;
	const clip = (t: string, note: string) => ({ text: t.length > RAW_MAX ? `${t.slice(0, RAW_MAX)}\n… (${t.length - RAW_MAX} more characters)` : t, note });
	const row = rowPathOf(path);
	if (/^(?:vc_row|vc_section|loose)\[/.test(row)) {
		const t = wpbakeryRows(content).get(row);
		return t === undefined ? undefined : clip(t, "WPBakery shortcode source of this row (raw/exporter/content)");
	}
	const m = /^blocks\[(\d+)(?:-(\d+))?\]$/.exec(row);
	if (m) {
		const blocks = parseBlocks(content);
		const from = Number(m[1]);
		const to = m[2] === undefined ? from : Number(m[2]);
		const list = blocks.slice(from, to + 1);
		return list.length ? clip(list.map(blockSource).join("\n"), "Gutenberg block markup of this row, reconstructed from the parsed blocks (raw/exporter/content)") : undefined;
	}
	return builder === "bricks" ? { text: "", note: "Bricks elements: open the page's _bricks_page_content_2 in raw/exporter/content to see this element." } : undefined;
}

// ── View ─────────────────────────────────────────────────────────────────────────────────────────────────────

export async function inspectorView(slug: string, pageName: string, viewport: string, sitesDir = SITES_DIR, visualLimit?: number): Promise<InspectorView | undefined> {
	const paths = sitePaths(slug, sitesDir);
	const verify = readJson<VerifyResult>(join(paths.reports, "verify", "verify.json"));
	const vPage = verify?.pages?.find((p) => p.name === pageName);
	if (!vPage) return undefined;
	const viewports = Object.keys(vPage.visual ?? {});
	if (!viewports.includes(viewport)) return undefined;
	const notes: string[] = [];

	const docs = loadIrDocs(paths.ir);
	const own = docs.find((d) => d.doc.route?.path === vPage.path);
	if (!own) notes.push("No IR document for this path (run transform).");
	const footerFile = readJson<{ partials?: { role: string; file: string }[] }>(join(paths.ir, "site.json"))?.partials?.find((p) => p.role === "footer")?.file;
	const footer = footerFile && /^[a-z0-9_-]+\/[A-Za-z0-9._-]+\.json$/i.test(footerFile) ? readJson<IrDoc>(join(paths.ir, footerFile)) : undefined;

	let overrides: Record<string, string> = {};
	try {
		overrides = (await loadOverrides(paths.overrides)).elements as Record<string, string>;
	} catch (e) {
		notes.push(`overrides.ts could not be read: ${(e as Error).message.split("\n")[0]}`);
	}

	const contentCache = new Map<string, { id: number; content?: string }[]>();
	const rawContent = (doc: IrDoc) => {
		const type = doc.source.type;
		if (!/^[a-z0-9_-]+$/i.test(type)) return undefined;
		if (!contentCache.has(type)) contentCache.set(type, readJson<{ id: number; content?: string }[]>(join(paths.raw, "exporter", "content", `${type}.json`)) ?? []);
		return contentCache.get(type)?.find((p) => p.id === doc.source.wpId)?.content;
	};

	const sections: InspectorSection[] = [];
	const addDoc = (doc: IrDoc | undefined, isFooter: boolean) => {
		if (!doc) return;
		const content = rawContent(doc);
		if (content === undefined && !isFooter) notes.push("Raw WordPress content not found (raw/exporter/content): run extract to see the source of each row.");
		doc.sections.forEach((s, index) => {
			const path = s.sourceRef?.path ?? "";
			const key = `${doc.source.slug}:${rowPathOf(path)}`;
			const raw = path ? rawFor(path, content, doc.source.builder) : undefined;
			sections.push({ index, footer: isFooter, type: s.type, path, overrideKey: key, ...(overrides[key] ? { override: overrides[key] } : {}), json: s, ...(raw ? { raw } : {}) });
		});
	};
	addDoc(own?.doc, false);
	addDoc(footer, true);

	const shots = readJson<ScreenshotResult[]>(join(paths.snapshot, "screens.json")) ?? [];
	const shot = shots.find((s) => {
		try {
			return s.viewport === viewport && new URL(s.url).pathname === vPage.path;
		} catch {
			return false;
		}
	});
	const boxes: SectionBox[] = shot?.sections ?? [];
	if (!boxes.length) notes.push("No row boxes in snapshot/screens.json for this page and viewport (rerun audit): pick a section from the list instead.");
	const diffs = vPage.sections?.[viewport] ?? [];
	const limit = visualLimit ?? 0.03;
	const regions: InspectorRegion[] = boxes.map((b) => {
		const list = sections.filter((s) => s.footer === b.footer && sourceRowIndex(s.path) === b.index).map((s) => sections.indexOf(s));
		const d = diffs.find((x) => x.footer === b.footer && x.sourceIndex === b.index);
		return {
			index: b.index,
			footer: b.footer,
			y: b.y,
			height: b.height,
			label: `${b.footer ? "footer " : ""}row ${b.index + 1}`,
			sections: list,
			...(d
				? {
						verify: {
							ratio: d.ratio,
							over: d.ratio > limit,
							types: d.types,
							...(d.note ? { note: d.note } : {}),
							...(d.files ? { images: { source: verifyFileUrl(slug, paths.root, d.files.source), target: verifyFileUrl(slug, paths.root, d.files.target), diff: verifyFileUrl(slug, paths.root, d.files.diff) } } : {}),
						},
					}
				: {}),
		};
	});

	return {
		page: { path: vPage.path, name: vPage.name, ...(own?.doc.title ? { title: own.doc.title } : {}), ...(own ? { irFile: `ir/${own.file}` } : {}), ...(own?.doc.source.builder ? { builder: own.doc.source.builder } : {}) },
		viewport,
		viewports,
		sourceImage: siteFileUrl(slug, paths.root, join("snapshot", "screens", viewport, `${vPage.name}.png`)),
		...(shot?.height ? { pageHeight: shot.height } : {}),
		regions,
		sections,
		sectionTypes: [...SECTION_TYPES],
		...(visualLimit !== undefined ? { visualLimit } : {}),
		notes,
	};
}

// ── Proposals from the inspector ──────────────────────────────────────────────────────────────────────────────

/** Adds or replaces `key: value` in overrides.ts → elements, keeping everything else as written. */
export function setElementOverride(text: string, key: string, value: string): string {
	const entry = `${JSON.stringify(key)}: ${JSON.stringify(value)},`;
	const lines = text.split("\n");
	const unit = (ind: string) => (ind === "" || ind.includes("\t") ? "\t" : ind);
	// elements: {},
	let i = lines.findIndex((l) => /^\s*elements\s*:\s*\{\s*\}\s*,?\s*(?:\/\/.*)?$/.test(l));
	if (i >= 0) {
		const line = lines[i] as string;
		const ind = /^\s*/.exec(line)?.[0] ?? "";
		const comma = /\}\s*,/.test(line) ? "," : "";
		lines.splice(i, 1, `${ind}elements: {`, `${ind}${unit(ind)}${entry}`, `${ind}}${comma}`);
		return lines.join("\n");
	}
	// elements: {  …  },
	i = lines.findIndex((l) => /^\s*elements\s*:\s*\{\s*(?:\/\/.*)?$/.test(l));
	if (i >= 0) {
		const ind = /^\s*/.exec(lines[i] as string)?.[0] ?? "";
		for (let j = i + 1; j < lines.length; j++) {
			const l = lines[j] as string;
			if (/^\s*\}\s*,?\s*$/.test(l)) {
				lines.splice(j, 0, `${ind}${unit(ind)}${entry}`);
				return lines.join("\n");
			}
			if (/[{}]/.test(l.replace(/(["'])(?:\\.|(?!\1).)*\1/g, ""))) break;
			const m = /^(\s*)(["'])((?:\\.|(?!\2).)*)\2\s*:/.exec(l);
			if (m && (m[2] === '"' ? safeJson(`"${m[3]}"`) : m[3]) === key) {
				lines[j] = `${m[1]}${entry}`;
				return lines.join("\n");
			}
		}
		throw new UserError("overrides.ts → elements is written in a shape the dashboard cannot edit safely; add the entry by hand.");
	}
	if (/^\s*elements\s*:/m.test(text)) throw new UserError("overrides.ts → elements is written in a shape the dashboard cannot edit safely; add the entry by hand.");
	i = lines.findIndex((l) => /^\s*export\s+default\s*\{\s*$/.test(l));
	if (i < 0) throw new UserError("overrides.ts has no `export default {` block.");
	lines.splice(i + 1, 0, "\telements: {", `\t\t${entry}`, "\t},");
	return lines.join("\n");
}

function safeJson(s: string): string | undefined {
	try {
		return JSON.parse(s) as string;
	} catch {
		return undefined;
	}
}

export interface InspectorProposalInput {
	section?: unknown;
	footer?: unknown;
	action?: unknown;
	type?: unknown;
	by?: unknown;
	note?: unknown;
}

/** Creates a pending proposal that forces a row's section type (or drops the row) in overrides.ts. */
export async function proposeSectionChange(slug: string, pageName: string, viewport: string, input: InspectorProposalInput, sitesDir = SITES_DIR) {
	const by = oneLine(input.by, "Name", 120, true) as string;
	const note = oneLine(input.note, "Note", 500, false);
	const v = await inspectorView(slug, pageName, viewport, sitesDir);
	if (!v) throw new UserError("Unknown page or viewport.");
	const footer = input.footer === true;
	const s = v.sections.find((x) => x.footer === footer && x.index === input.section);
	if (!s) throw new UserError("Unknown section.");
	if (!s.path) throw new UserError("This section has no source path; it cannot be overridden.");
	if (/[\u0000-\u001f\u007f]/.test(s.overrideKey) || s.overrideKey.length > 300) throw new UserError("This section's key cannot be written to overrides.ts.");
	let value: string;
	if (input.action === "drop") value = "drop";
	else if (input.action === "type" && typeof input.type === "string" && v.sectionTypes.includes(input.type)) value = input.type;
	else throw new UserError("Choose a section type from the list, or drop.");
	if (s.override === value) throw new UserError(`overrides.ts already sets ${s.overrideKey} to ${value}.`);

	const paths = sitePaths(slug, sitesDir);
	const before = existsSync(paths.overrides) ? readFileSync(paths.overrides, "utf8") : "";
	const after = setElementOverride(before || overridesTemplate(), s.overrideKey, value);
	const patch = unifiedDiff(before, after, "overrides.ts");
	const what = value === "drop" ? `drop ${s.overrideKey}` : `make ${s.overrideKey} a ${value} section`;
	const summary = `Section inspector: ${what} (${v.page.path}, now ${s.type})${note ? ` — ${note}` : ""}`;
	try {
		return createProposal(slug, { by, summary, file: "overrides.ts", patch, rerun: "transform" }, { sitesDir });
	} catch (e) {
		throw new UserError(`Could not create the proposal: ${(e as Error).message}`);
	}
}
