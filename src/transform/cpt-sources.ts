/**
 * Where custom field definitions come from on disk (extract output): plugin export files the owner sent
 * (raw/field-definitions/*.json, recognised and copied by extract from raw/plugin-exports/), the ACF, Meta Box and Pods
 * configuration posts the Exporter returned (raw/exporter/content/<type>.json), and the Exporter's analyze `acf` list.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { acfGroupsFromAnalyze, acfGroupsFromExport, acfGroupsFromPosts, metaBoxGroupsFromExport, podsGroupsFromExport, type WpFieldGroup } from "./cpt-fields.js";

type Post = { id: number; slug: string; title: string; excerpt: string; content: string; parent: number | null; menu_order: number; status: string; meta: Record<string, unknown> };

/** Every field group, richest sources first. */
export function fieldGroups(input: { raw: string; content: (type: string) => unknown[]; analyzeAcf?: unknown }): WpFieldGroup[] {
	const groups: WpFieldGroup[] = [];
	const dir = join(input.raw, "field-definitions");
	if (existsSync(dir)) {
		for (const f of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
			const j = JSON.parse(readFileSync(join(dir, f), "utf8")) as { provider?: string; file?: string; data?: unknown };
			const from = `${j.provider ?? "export"} export ${j.file ?? f}`;
			if (j.provider === "acf") groups.push(...acfGroupsFromExport(j.data, from));
			else if (j.provider === "metabox") groups.push(...metaBoxGroupsFromExport(j.data, from));
			else if (j.provider === "pods") groups.push(...podsGroupsFromExport(j.data, from));
		}
	}
	const posts = (t: string) => input.content(t) as Post[];
	const acfFields = posts("acf-field");
	if (acfFields.length) groups.push(...acfGroupsFromPosts(posts("acf-field-group"), acfFields));
	// Meta Box Builder keeps each field group as a `meta-box` post with its settings in post meta (unserialized by the Exporter).
	for (const p of posts("meta-box").filter((x) => x.status === "publish")) groups.push(...metaBoxGroupsFromExport({ post_title: p.title, meta_box: p.meta?.meta_box, settings: p.meta?.settings }, "Meta Box field groups (meta-box posts)"));
	// Pods: a `_pods_pod` post per pod, its fields as `_pods_field` posts (settings in post meta).
	const pods = posts("_pods_pod");
	if (pods.length) {
		const fields = posts("_pods_field");
		groups.push(...podsGroupsFromExport({ pods: pods.map((p) => ({ name: p.slug, label: p.title, type: p.meta?.type, fields: fields.filter((f) => f.parent === p.id).sort((a, b) => a.menu_order - b.menu_order).map((f) => ({ ...f.meta, name: f.slug, label: f.title })) })) }, "Pods configuration (_pods_pod posts)"));
	}
	groups.push(...acfGroupsFromAnalyze(input.analyzeAcf));
	return groups;
}
