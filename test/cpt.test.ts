/**
 * Custom post types → EmDash collections: field definitions (ACF, Meta Box, Pods), the field-type map, value
 * conversion, the transform (collections, entries, gates, report), seed, load helpers and the starter's routing.
 * Synthetic WordPress fixture: test/fixtures/cpt/site.json. Goldens: test/golden/cpt/*.json (regenerate after an
 * intended change: UPDATE_GOLDEN=1 pnpm test).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { overridesSchema } from "../src/config/overrides.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { isPhpSerialized, phpUnserialize } from "../src/extract/php-unserialize.js";
import { recognise } from "../src/extract/plugin-exports.js";
import type { IrPage } from "../src/ir/schema.js";
import { entryAction, entryFields, resolveReferences } from "../src/phases/load.js";
import { runTransform } from "../src/phases/transform.js";
import { buildSeed, seedMediaResolver } from "../src/scaffold/seed.js";
import { judgeUrl } from "../src/verify/urls-accounted.js";
import { customContentGuide } from "../src/scaffold/client-repo.js";
import { type CptPlan, collectionFields, starterCollectionsConfig } from "../src/transform/cpt.js";
import { acfGroupsFromPosts, convertValue, dateOf, fieldKind, isInternalMeta, mapField, mediaOf, metaBoxGroupsFromExport, podsGroupsFromExport, type WpFieldDef } from "../src/transform/cpt-fields.js";
import { collectionRoute, entryCollections, entryHref, fieldText, hasValue, jsonLines } from "../starter/src/utils/collections.js";

const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "cpt", "site.json"), "utf8"));
const goldenDir = join(import.meta.dirname, "golden", "cpt");
const golden = (name: string, value: unknown) => {
	const file = join(goldenDir, name);
	const json = `${JSON.stringify(value, null, "\t")}\n`;
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
		mkdirSync(goldenDir, { recursive: true });
		writeFileSync(file, json);
	}
	expect(json).toBe(readFileSync(file, "utf8"));
};

const dir = mkdtempSync(join(tmpdir(), "wp2e-cpt-"));
const put = (file: string, data: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const config = kitConfigSchema.parse({ slug: "cpt", name: "Example Studio", source: { url: "https://cpt.example.test" }, target: { productionUrl: "https://cpt.example.test" } });

/** A site workspace with the fixture's extract and audit output. */
function workspace(name: string, overrides?: string, opts: { definitions?: boolean } = {}) {
	const paths = sitePaths(name, dir);
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "options.json"), fx.options);
	put(join(paths.raw, "exporter", "content", "page.json"), fx.pages);
	for (const t of ["team", "services", "location"]) put(join(paths.raw, "exporter", "content", `${t}.json`), fx[t]);
	put(join(paths.raw, "exporter", "taxonomies.json"), fx.taxonomies);
	put(join(paths.raw, "exporter", "analyze.json"), fx.analyze);
	put(join(paths.raw, "exporter", "types.json"), fx.types);
	if (opts.definitions !== false) for (const [f, d] of Object.entries(fx.fieldDefinitions)) put(join(paths.raw, "field-definitions", f), d);
	put(join(paths.raw, "media-manifest.json"), fx.media);
	put(join(paths.snapshot, "urls.json"), fx.urls);
	put(join(paths.snapshot, "discovery.json"), fx.discovery);
	if (overrides) put(paths.overrides, overrides);
	return paths;
}
const run = (paths: ReturnType<typeof sitePaths>) => runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
const DECIDED = `export default { contentTypes: { team: { as: "collection", fields: { legacy_code: "string" } } } };\n`;
const readDir = (d: string) => (existsSync(d) ? Object.fromEntries(readdirSync(d).sort().map((f) => [f, JSON.parse(readFileSync(join(d, f), "utf8"))])) : {});

describe("field definitions", () => {
	it("PHP-serialized ACF settings (acf-field posts)", () => {
		const s = 'a:4:{s:4:"type";s:8:"repeater";s:5:"label";s:6:"Skills";s:7:"choices";a:2:{s:1:"a";s:4:"Ä b";i:0;s:1:"x";}s:8:"required";i:1;}';
		expect(isPhpSerialized(s)).toBe(true);
		expect(phpUnserialize(s)).toEqual({ type: "repeater", label: "Skills", choices: { a: "Ä b", "0": "x" }, required: 1 });
		expect(phpUnserialize('a:2:{i:0;s:2:"33";i:1;s:2:"34";}')).toEqual(["33", "34"]);
		expect(phpUnserialize("b:0;")).toBe(false);
		expect(() => phpUnserialize("x:1;")).toThrow();
		const groups = acfGroupsFromPosts(
			[{ id: 10, slug: "group_team", title: "Team member", content: 'a:1:{s:8:"location";a:1:{i:0;a:1:{i:0;a:3:{s:5:"param";s:9:"post_type";s:8:"operator";s:2:"==";s:5:"value";s:4:"team";}}}}', status: "publish" }],
			[
				{ id: 11, slug: "field_skills", title: "Skills", excerpt: "skills", content: 'a:1:{s:4:"type";s:8:"repeater";}', parent: 10, menu_order: 1 },
				{ id: 12, slug: "field_skill", title: "Skill", excerpt: "skill", content: 'a:1:{s:4:"type";s:4:"text";}', parent: 11, menu_order: 0 },
				{ id: 13, slug: "field_role", title: "Role", excerpt: "role", content: 'a:2:{s:4:"type";s:4:"text";s:8:"required";i:1;}', parent: 10, menu_order: 0 },
			],
		);
		expect(groups).toEqual([{ source: "acf", title: "Team member", postTypes: ["team"], from: "ACF field groups (acf-field posts)", fields: [{ source: "acf", name: "role", label: "Role", type: "text", required: true }, { source: "acf", name: "skills", label: "Skills", type: "repeater", subFields: [{ source: "acf", name: "skill", label: "Skill", type: "text" }] }] }]);
	});
	it("Meta Box and Pods exports", () => {
		const mb = metaBoxGroupsFromExport(fx.fieldDefinitions["metabox-services.json"].data, "x");
		expect(mb[0]).toMatchObject({ source: "metabox", postTypes: ["services"], fields: [{ name: "price", type: "number" }, { name: "duration" }, { name: "photos", type: "image_advanced" }, { name: "booking_url", type: "url" }] });
		const pods = podsGroupsFromExport(fx.fieldDefinitions["pods-location.json"].data, "x");
		expect(pods[0]?.fields.find((f) => f.name === "services_offered")).toEqual({ source: "pods", name: "services_offered", label: "Services", type: "pick", multiple: true, targets: ["services"] });
	});
	it("extract recognises field-definition exports among the plugin exports", () => {
		expect(recognise("acf.json", JSON.stringify(fx.fieldDefinitions["acf-team.json"].data), [])).toMatchObject({ kind: "fields", provider: "acf" });
		expect(recognise("mb.json", JSON.stringify(fx.fieldDefinitions["metabox-services.json"].data), [])).toMatchObject({ kind: "fields", provider: "metabox" });
		expect(recognise("pods.json", JSON.stringify(fx.fieldDefinitions["pods-location.json"].data), [])).toMatchObject({ kind: "fields", provider: "pods" });
		expect(recognise("x.json", JSON.stringify({ hello: 1 }), []).kind).toBe("unknown");
	});
});

describe("field-type map (golden)", () => {
	it("maps every ACF, Meta Box and Pods type to an EmDash field type", () => {
		const acf = ["text", "textarea", "number", "range", "email", "url", "password", "image", "file", "wysiwyg", "oembed", "gallery", "select", "checkbox", "radio", "button_group", "true_false", "link", "post_object", "page_link", "relationship", "taxonomy", "user", "google_map", "date_picker", "date_time_picker", "time_picker", "color_picker", "message", "accordion", "tab", "group", "repeater", "flexible_content", "clone"];
		const metabox = ["text", "textarea", "number", "email", "url", "wysiwyg", "checkbox", "checkbox_list", "radio", "select", "date", "datetime", "time", "color", "single_image", "image_advanced", "file_advanced", "post", "taxonomy", "user", "oembed", "map", "group", "heading", "key_value"];
		const pods = ["text", "website", "phone", "email", "paragraph", "wysiwyg", "code", "datetime", "date", "time", "number", "currency", "oembed", "boolean", "color", "file", "pick"];
		const ctx = () => ({ collectionFor: (t: string) => (t === "team" ? "team" : t === "page" ? "pages" : undefined), taken: new Set<string>() });
		const sub = [{ source: "acf" as const, name: "a", label: "A", type: "text" }, { source: "acf" as const, name: "b", label: "B", type: "image" }];
		const row = (source: WpFieldDef["source"], type: string) => {
			const def: WpFieldDef = { source, name: "f", label: "F", type, ...(type === "relationship" || type === "post_object" || type === "post" ? { targets: ["team"] } : {}), ...(["group", "repeater", "clone"].includes(type) ? { subFields: sub } : {}), ...(type === "pick" ? { targets: ["team"], multiple: true } : {}) };
			const m = mapField(def, ctx());
			return `${source} ${type} → ${fieldKind(def)} → ${m.map((f) => `${f.slug}:${f.type}${f.subFields ? `[${f.subFields.map((s) => s.type).join(",")}]` : ""}${f.targetCollection ? `→${f.targetCollection}` : ""}`).join(" ") || "(no field)"}`;
		};
		golden("field-types.json", [...acf.map((t) => row("acf", t)), ...metabox.map((t) => row("metabox", t)), ...pods.map((t) => row("pods", t))]);
	});
	it("a repeater whose rows hold rich text, files or nested rows is kept as JSON (EmDash repeaters are flat)", () => {
		const m = mapField({ source: "acf", name: "faq", label: "FAQ", type: "repeater", subFields: [{ source: "acf", name: "q", label: "Q", type: "text" }, { source: "acf", name: "a", label: "A", type: "wysiwyg" }] }, { collectionFor: () => undefined, taken: new Set() });
		expect(m).toMatchObject([{ slug: "faq", type: "json", warn: true }]);
		expect(m[0]?.note).toMatch(/a \(html\)/);
	});
	it("reserved and duplicate slugs are renamed", () => {
		const taken = new Set<string>(["title"]);
		expect(mapField({ source: "acf", name: "title", label: "Title", type: "text" }, { collectionFor: () => undefined, taken })[0]?.slug).toBe("wp_title");
		expect(mapField({ source: "acf", name: "Price (€)", label: "", type: "number" }, { collectionFor: () => undefined, taken })[0]).toMatchObject({ slug: "price", label: "Price (€)" });
		expect(mapField({ source: "acf", name: "price", label: "", type: "number" }, { collectionFor: () => undefined, taken })[0]?.slug).toBe("price_2");
	});
});

describe("values", () => {
	const ctx = { mediaIdForUrl: (u: string) => (u.endsWith("/known.jpg") ? 77 : undefined), typeOfId: (id: number) => (id === 5 ? "team" : undefined), html: (h: string) => [{ _type: "block", _key: "k", children: [{ _type: "span", text: h.replace(/<[^>]+>/g, "") }] }], keyPrefix: "x_" };
	it("dates, media, references, repeaters", () => {
		expect(dateOf("20240510")).toBe("2024-05-10T00:00:00.000Z");
		expect(dateOf("2024-05-10 09:30:00")).toBe("2024-05-10T09:30:00.000Z");
		expect(dateOf("May 10, 2024")).toBeUndefined();
		expect(mediaOf({ type: "image", id: 3, alt: "A" }, "image", ctx)).toEqual({ wpId: 3, kind: "image", alt: "A" });
		expect(mediaOf("https://x.test/wp-content/uploads/known.jpg", "image", ctx)).toEqual({ wpId: 77, kind: "image" });
		expect(mediaOf("12", "file", ctx)).toEqual({ wpId: 12, kind: "file" });
		// ACF formats a date picker for display; the raw meta (Ymd) wins.
		expect(convertValue({ kind: "date", type: "datetime", slug: "d" }, "May 10, 2024", "20240510", ctx).value).toBe("2024-05-10T00:00:00.000Z");
		expect(convertValue({ kind: "reference", type: "reference", slug: "r" }, [5, 6], undefined, ctx)).toEqual({ refs: ["team:5"], problems: ["r: points at #6, which the extract does not have (deleted or private)"] });
		expect(convertValue({ kind: "boolean", type: "boolean", slug: "b" }, undefined, "0", ctx).value).toBe(false);
		expect(convertValue({ kind: "url", type: "url", slug: "u" }, "javascript:alert(1)", undefined, ctx).problems?.[0]).toMatch(/not a URL/);
		expect(convertValue({ kind: "repeater", type: "repeater", slug: "s", subFields: [{ slug: "skill", label: "S", type: "string", kind: "string", wpName: "skill" }, { slug: "years", label: "Y", type: "number", kind: "number", wpName: "years" }] }, [{ skill: "Mat", years: "4" }], undefined, ctx).value).toEqual([{ skill: "Mat", years: 4 }]);
		expect(convertValue({ kind: "gallery", type: "repeater", slug: "g" }, undefined, 'a:1:{i:0;s:2:"33";}', ctx).value).toEqual([{ image: { wpId: 33, kind: "image" } }]);
	});
	it("internal meta is never reported as unmapped content", () => {
		for (const k of ["_thumbnail_id", "_role", "rank_math_title", "_yoast_wpseo_title", "_elementor_data", "footnotes", "_pods_x"]) expect(isInternalMeta(k), k).toBe(true);
		for (const k of ["legacy_code", "price", "role"]) expect(isInternalMeta(k), k).toBe(false);
	});
});

describe("cpt transform", () => {
	it("collections, fields, entries and references (golden); content types and fields decided", async () => {
		const paths = workspace("decided", DECIDED);
		const checks = await run(paths);
		for (const id of ["content-types-handled", "cpt-fields", "ir-valid", "unmapped", "media-refs", "images-kept", "links"]) expect(checks.find((c) => c.id === id), id).toMatchObject({ ok: true });
		const plan = JSON.parse(readFileSync(join(paths.ir, "collections.json"), "utf8")) as CptPlan;
		golden("collections.json", plan);
		golden("entries.json", Object.fromEntries(plan.collections.map((c) => [c.slug, readDir(join(paths.ir, "entries", c.slug))])));
		golden("wp-urls.json", JSON.parse(readFileSync(join(paths.ir, "wp-urls.json"), "utf8")).rules);
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/## Custom post types[\s\S]*### Team \(`team` → collection `team`\)/);
		expect(md).toMatch(/\| Works with \(`related`\) \| reference → team \(many\) \| acf relationship `related` \| 2 \|/);
		expect(md).toMatch(/\| `legacy_code` \| 2 \| JD-01 \| string \|/);
	});

	it("keeps entry data: slug, status, dates, featured image, terms, order, parent, fields, references", async () => {
		const paths = workspace("data", DECIDED);
		await run(paths);
		const jane = JSON.parse(readFileSync(join(paths.ir, "entries", "team", "jane.json"), "utf8")) as IrPage;
		expect(jane).toMatchObject({ kind: "entry", route: { path: "/team/jane/" }, featuredImage: { wpId: 31 }, entry: { collection: "team", excerpt: "Lead instructor.", publishedAt: "2024-02-01T09:00:00.000Z", menuOrder: 1, terms: { department: ["coaching"] }, references: { related: ["team:102"] } } });
		expect(jane.entry?.fields).toMatchObject({ role: "Lead instructor", photo: { wpId: 32, kind: "image", alt: "Jane portrait" }, start_date: "2020-01-15T00:00:00.000Z", level: "senior", accepts_clients: true, skills: [{ skill: "Reformer", years: 8 }, { skill: "Mat", years: 12 }], gallery: [{ image: { wpId: 33, kind: "image", alt: "Studio" } }, { image: { wpId: 34, kind: "image" } }], profile_link: { title: "Profile", url: "https://example.org/jane", target: "" }, legacy_code: "JD-01" });
		expect((jane.entry?.fields.bio as { _type: string }[])[0]?._type).toBe("block");
		// Classic content → Portable Text (body); Gutenberg/builder content → sections, like pages.
		expect(jane.entry?.body.map((b) => b._type)).toEqual(["block", "block"]);
		const sam = JSON.parse(readFileSync(join(paths.ir, "entries", "team", "sam.json"), "utf8")) as IrPage;
		expect(sam.entry?.references).toEqual({ related: ["team:101"] });
		expect(sam.diagnostics.some((d) => /#999/.test(d.message))).toBe(true);
		const draft = JSON.parse(readFileSync(join(paths.ir, "entries", "team", "team-103.json"), "utf8")) as IrPage;
		expect(draft).toMatchObject({ source: { status: "draft", slug: "team-103" }, route: { path: "/team/team-103/" } });
		const child = JSON.parse(readFileSync(join(paths.ir, "entries", "services", "private-sessions.json"), "utf8")) as IrPage;
		expect(child).toMatchObject({ route: { path: "/services/pilates/private-sessions/" }, entry: { menuOrder: 1, references: { parent: ["services:201"] }, fields: { price: 90, duration: "60 minutes" } } });
		expect(child.diagnostics.find((d) => d.path === "fields.booking_url")?.message).toMatch(/not a URL/);
		const pilates = JSON.parse(readFileSync(join(paths.ir, "entries", "services", "pilates.json"), "utf8")) as IrPage;
		expect(pilates.entry?.fields.photos).toEqual([{ image: { wpId: 35, kind: "image" } }]);
		expect(pilates.entry?.body.some((b) => b._type === "image")).toBe(true);
		const group = JSON.parse(readFileSync(join(paths.ir, "entries", "services", "group-classes.json"), "utf8")) as IrPage;
		expect(group.source.builder).toBe("gutenberg");
		expect(group.sections.length).toBeGreaterThan(0);
		const loc = JSON.parse(readFileSync(join(paths.ir, "entries", "location", "downtown.json"), "utf8")) as IrPage;
		expect(loc.entry).toMatchObject({ fields: { address: "1 Main Street\nSpringfield", website: "/", open_weekends: true, phone: "+1 555 0100" }, references: { services_offered: ["services:201", "services:202"] } });
		const plan = JSON.parse(readFileSync(join(paths.ir, "collections.json"), "utf8")) as CptPlan;
		const by = Object.fromEntries(plan.collections.map((c) => [c.type, c]));
		expect(by.team).toMatchObject({ slug: "team", base: "/team/", archive: "/team/", routable: true, core: { excerpt: true, featuredImage: true, body: true, bylines: true } });
		expect(by.services).toMatchObject({ hierarchical: true, base: "/services/", archive: "/services/", core: { parent: true, menuOrder: true, ordered: true, sections: true, body: true } });
		expect(by.location).toMatchObject({ base: "/location/" });
		expect(by.location?.archive).toBeUndefined();
		expect(plan.taxonomies).toMatchObject([{ name: "department", collections: ["team"], base: "/department/", terms: [{ slug: "coaching" }, { slug: "front-desk" }] }]);
		// Team supports `author`: a guest byline per WordPress author (no user accounts), credited on each entry.
		expect(plan.bylines).toEqual([{ slug: "studio-admin", displayName: "Studio Admin", wpId: 1, posts: 2 }]);
		expect(jane.entry?.bylines).toEqual(["studio-admin"]);
	});

	it("meta no definition describes keeps the gate red until decided", async () => {
		const checks = await run(workspace("open"));
		expect(checks.find((c) => c.id === "cpt-fields")).toMatchObject({ ok: false });
		expect(checks.find((c) => c.id === "cpt-fields")?.detail).toMatch(/team\.legacy_code \(2\)/);
		// Public post types the Exporter describes are collections by default: no decision needed.
		expect(checks.find((c) => c.id === "content-types-handled")).toMatchObject({ ok: true, detail: "migrated: location, page, services, team, attachment, department" });
	});

	it("without field definitions the fields are reported, not guessed; skip and pages still work", async () => {
		const paths = workspace("nodefs", `export default { contentTypes: { location: { as: "skip", reason: "test: closed" }, services: { as: "pages", reason: "test: as pages" } } };\n`, { definitions: false });
		const checks = await run(paths);
		const plan = JSON.parse(readFileSync(join(paths.ir, "collections.json"), "utf8")) as CptPlan;
		expect(plan.collections.map((c) => c.slug)).toEqual(["team"]);
		// Only the Exporter's analyze list (role, photo) describes fields: everything else is reported.
		expect(plan.collections[0]?.fields.map((f) => f.slug)).toEqual(["role", "photo"]);
		expect(plan.collections[0]?.unknownMeta.map((u) => u.key)).toEqual(["accepts_clients", "bio", "gallery", "legacy_code", "level", "related", "skills", "skills_0_skill", "skills_0_years", "skills_1_skill", "skills_1_years", "start_date"]);
		expect(checks.find((c) => c.id === "cpt-fields")).toMatchObject({ ok: false });
		expect(existsSync(join(paths.ir, "pages", "services-pilates.json"))).toBe(true);
	});

	it("a brochure site without custom post types writes no collections", async () => {
		const paths = sitePaths("brochure", dir);
		put(join(paths.raw, "extract.json"), {});
		put(join(paths.raw, "exporter", "options.json"), fx.options);
		put(join(paths.raw, "exporter", "content", "page.json"), fx.pages);
		put(join(paths.raw, "exporter", "analyze.json"), { post_types: [fx.analyze.post_types[0]] });
		const checks = await run(paths);
		expect(existsSync(join(paths.ir, "collections.json"))).toBe(false);
		expect(checks.some((c) => c.id === "cpt-fields")).toBe(false);
		expect(readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8")).not.toMatch(/Custom post types/);
	});
});

describe("seed, load and starter", async () => {
	const paths = workspace("generated", DECIDED);
	await run(paths);
	const plan = JSON.parse(readFileSync(join(paths.ir, "collections.json"), "utf8")) as CptPlan;
	const entries = plan.collections.flatMap((c) => Object.values(readDir(join(paths.ir, "entries", c.slug)))) as IrPage[];
	const pages = Object.values(readDir(join(paths.ir, "pages"))) as IrPage[];
	const media = seedMediaResolver(new Map(fx.media.map((m: { id: number; url: string }) => [m.id, { url: m.url }])), (u) => u);
	const seed = buildSeed({ name: "x", site: { version: 1, title: "Example Studio", menus: [], partials: [], popups: [] }, pages, partials: [], popups: [], media, titleSeparator: "-", forms: [], includeContent: true, collections: { plan, entries } });

	it("seed: collections after pages, fields, taxonomies, entries with $media and $ref (golden)", () => {
		expect((seed.collections as { slug: string; sortOrder: number }[]).map((c) => [c.slug, c.sortOrder])).toEqual([["pages", 1], ["services", 2], ["location", 3], ["team", 4], ["site_parts", 5], ["popups", 6]]);
		golden("seed.json", { collections: (seed.collections as { slug: string }[]).filter((c) => !["pages", "site_parts", "popups"].includes(c.slug)), taxonomies: seed.taxonomies, content: Object.fromEntries(Object.entries(seed.content as object).filter(([k]) => !["pages", "site_parts", "popups"].includes(k))) });
		const team = (seed.content as Record<string, { id: string; data: Record<string, unknown> }[]>).team ?? [];
		expect(team.find((e) => e.id === "team:101")?.data).toMatchObject({ related: ["$ref:team:102"], photo: { $media: { url: "https://cpt.example.test/wp-content/uploads/2024/02/jane-portrait.jpg" } } });
		expect(JSON.stringify(seed.content)).not.toContain('"_media"');
	});

	it("fields: core first, references with their target collection, select options completed from the values", () => {
		const services = plan.collections.find((c) => c.slug === "services") as CptPlan["collections"][number];
		expect(collectionFields(services, ["section_hero"]).map((f) => `${f.slug}:${f.type}`)).toEqual(["title:string", "body:portableText", "content:blocks", "menu_order:integer", "parent:reference", "price:number", "duration:string", "photos:repeater", "booking_url:url"]);
		const team = plan.collections.find((c) => c.slug === "team") as CptPlan["collections"][number];
		expect(collectionFields(team, []).find((f) => f.slug === "related")).toEqual({ slug: "related", label: "Works with", type: "reference", validation: { targetCollection: "team", multiple: true } });
		expect(team.fields.find((f) => f.slug === "level")?.options).toEqual(["junior", "senior"]);
	});

	it("load: entry data with EmDash media, references in a second pass, statuses", () => {
		const jane = entries.find((e) => e.source.wpId === 101) as IrPage;
		const team = plan.collections.find((c) => c.slug === "team") as CptPlan["collections"][number];
		const data = entryFields(jane, team, (m) => ({ provider: "local", id: `M${m.wpId}`, ...(m.alt ? { alt: m.alt } : {}) }), (m) => ({ id: `M${m.wpId}`, url: `/_emdash/api/media/file/${m.wpId}.jpg` }));
		expect(data).toMatchObject({ excerpt: "Lead instructor.", menu_order: 1, photo: { provider: "local", id: "M32", alt: "Jane portrait" }, gallery: [{ image: { provider: "local", id: "M33", alt: "Studio" } }, { image: { provider: "local", id: "M34" } }] });
		expect(data).not.toHaveProperty("related");
		const missing: string[] = [];
		expect(resolveReferences({ related: ["team:102", "team:999"] }, (k) => (k === "team:102" ? "E2" : undefined), (f, k) => missing.push(`${f} ${k}`))).toEqual({ related: ["E2"] });
		expect(missing).toEqual(["related team:999"]);
		expect(entryAction(jane)).toBe("publish");
		expect(entryAction({ ...jane, source: { ...jane.source, status: "draft" } })).toBe("draft");
	});

	it("starter: archives, term archives, entries by address; fields as text", () => {
		const cfg = starterCollectionsConfig(plan);
		expect(cfg.map((c) => [c.slug, c.base, c.archive, c.order, c.references])).toEqual([["location", "/location/", undefined, undefined, ["services_offered"]], ["services", "/services/", "/services/", "menu", ["parent"]], ["team", "/team/", "/team/", "menu", ["related"]]]);
		expect(collectionRoute("/team/", cfg)).toMatchObject({ kind: "archive", collection: { slug: "team" }, page: 1 });
		expect(collectionRoute("/team/page/2/", cfg)).toMatchObject({ kind: "archive", page: 2 });
		expect(collectionRoute("/department/coaching/", cfg)).toMatchObject({ kind: "term", taxonomy: "department", slug: "coaching", collections: [{ slug: "team" }] });
		for (const p of ["/team/jane/", "/about/", "/department/"]) expect(collectionRoute(p, cfg), p).toBeUndefined();
		expect(entryCollections("services/pilates/private-sessions", cfg).map((c) => c.slug)).toEqual(["services"]);
		expect(entryCollections("about", cfg)).toEqual([]);
		expect(entryHref("team/jane")).toBe("/team/jane/");
		expect(entryHref("team/jane", "never")).toBe("/team/jane");
		expect(fieldText("boolean", 1)).toBe("Yes");
		expect(fieldText("datetime", "2020-01-15T00:00:00.000Z")).toBe("January 15, 2020");
		expect(fieldText("multiSelect", ["a", "b"])).toBe("a, b");
		expect(jsonLines({ title: "Profile", url: "https://x", target: "", id: 4 })).toEqual(["Profile"]);
		expect(hasValue([{ image: null }])).toBe(false);
		expect(hasValue([{ image: { id: "M1" } }])).toBe(true);
		expect(hasValue(false)).toBe(true);
	});

	it("client docs: editing custom content", () => {
		const md = customContentGuide([{ label: "Team", labelSingular: "Team member", slug: "team", archive: "/team/", base: "/team/", fields: [{ label: "Role", type: "string" }, { label: "Works with", type: "reference" }], hierarchical: false, taxonomies: ["Departments"] }]);
		expect(md).toMatch(/## Team\n\nListed at `\/team\/`/);
		expect(md).toMatch(/\| Works with \| a link to another entry/);
	});

	it("verify: a migrated entry or archive must answer 200 (a redirect does not account for it)", () => {
		const ctx = { overrides: overridesSchema.parse({}), realRoutes: new Set(["/team/jane/", "/team/"]) };
		expect(judgeUrl({ path: "/team/jane/", kind: "team", type: "team" }, { status: 200 }, ctx).ok).toBe(true);
		expect(judgeUrl({ path: "/team/jane/", kind: "team", type: "team" }, { status: 301, location: "/", next: 200 }, ctx)).toMatchObject({ ok: false, why: "migrated entry or archive answers 301 → / (a real route: 200 expected)" });
		expect(judgeUrl({ path: "/team", kind: "page" }, { status: 404 }, ctx).ok).toBe(false);
		expect(judgeUrl({ path: "/old/", kind: "page" }, { status: 301, location: "/", next: 200 }, ctx).ok).toBe(true);
	});

	it("overrides accept collection decisions", () => {
		expect(overridesSchema.safeParse({ contentTypes: { team: { as: "collection", name: "people", fields: { x: "text", y: "skip" } } } }).success).toBe(true);
		expect(overridesSchema.safeParse({ contentTypes: { team: { as: "collection", name: "Bad Name" } } }).success).toBe(false);
		expect(overridesSchema.safeParse({ contentTypes: { team: { as: "collection", fields: { x: "email" } } } }).success).toBe(false);
	});
});
