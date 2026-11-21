/**
 * WebMCP declarative form annotations (docs/spikes/webmcp-findings.md): `toolname` + `tooldescription` on a <form> make
 * Chrome expose it as a tool an AI agent can fill in; `toolparamdescription` on a field describes that parameter. Plain
 * HTML attributes, no JavaScript, ignored by browsers without WebMCP.
 *
 * Everything here comes from the form's own data (title, labels, options, submit label). No `toolautosubmit` on site
 * forms: the agent fills the form and the visitor still checks it and presses Submit, so Turnstile and the honeypot run
 * exactly as for a person. Forms of a site with sensitive data (health, legal, finance) are never exposed: an agent
 * would be copying the visitor's details out of its own context into the form, which we do not want to invite.
 *
 * Off with kit.config `forms.webmcp: false` (Worker var FORM_WEBMCP="0").
 */
import type { FormDefinition, FormField } from "./types.js";

export interface WebMcpEnv {
	/** "0": no WebMCP annotations anywhere (kit.config forms.webmcp: false). */
	FORM_WEBMCP?: string;
	/** "1": the site handles sensitive data (kit.config sensitiveData). */
	FORM_SENSITIVE?: string;
}

/** Form-level attributes, spread onto the <form>. */
export interface ToolAttrs {
	toolname: string;
	tooldescription: string;
	/** Only for side-effect-free forms (site search). */
	toolautosubmit?: boolean;
}

export const webMcpEnabled = (env: WebMcpEnv | undefined) => env?.FORM_WEBMCP !== "0";
const siteSensitive = (env: WebMcpEnv | undefined) => env?.FORM_SENSITIVE === "1";

/**
 * Description for a honeypot field. Chrome lists every visible-type text input as a parameter, honeypots included
 * (verified Chrome 159); without this an agent may fill it and the message is dropped as spam.
 */
export const HONEYPOT_DESCRIPTION = "Anti-spam check: always leave this empty.";

/** Stable tool name from the form id: lowercase letters, digits and underscores. */
export function toolNameOf(id: string): string {
	const s = id
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.slice(0, 64);
	return !s || /^\d/.test(s) ? `form_${s}`.replace(/_$/, "") : s;
}

/** Label text without the trailing "*" or ":" some imported labels carry. */
const clean = (s: string | undefined) =>
	(s ?? "")
		.replace(/\s+/g, " ")
		.replace(/[\s*:]+$/, "")
		.trim();

const quoted = (s: string) => `“${s}”`;
/** Fields Chrome turns into parameters (file inputs are skipped by Chrome; content blocks are not inputs). */
const isParam = (f: FormField) => f.type !== "content" && f.type !== "file";
/** Radio and checkbox groups: Chrome 159 drops every description source for these, so the tool description names them. */
const isGroup = (f: FormField) => f.type === "radio" || (f.type === "checkbox" && !!f.options?.length);

/** The <form> attributes for a site form, or undefined when it must not be exposed. */
export function formTool(form: FormDefinition, env: WebMcpEnv | undefined): ToolAttrs | undefined {
	if (!webMcpEnabled(env) || form.sensitive || siteSensitive(env)) return undefined;
	const title = clean(form.title) || form.id;
	const submit = clean(form.submitLabel) || "Submit";
	const parts = [`Fill in the ${quoted(title)} form on this page. The visitor checks the answers and presses ${quoted(submit)} to send it.`];
	const groups = form.fields.filter(isGroup).map((f) => `${quoted(clean(f.label) || f.name)} is ${f.name}${f.type === "checkbox" ? " (pick any)" : " (pick one)"}`);
	if (groups.length) parts.push(`Choice fields: ${groups.join("; ")}.`);
	if (form.fields.some((f) => f.type === "file")) parts.push("Files can only be attached by the visitor.");
	return { toolname: toolNameOf(form.id), tooldescription: parts.join(" ") };
}

/** `toolparamdescription` for one field, or undefined when the form is not exposed or the field is no parameter. */
export function paramDescription(field: FormField, form: FormDefinition, env: WebMcpEnv | undefined): string | undefined {
	if (!formTool(form, env) || !isParam(field)) return undefined;
	let d = clean(field.label) || field.name;
	if (field.type === "signature") d = `${d}: type the visitor's full name as their signature`;
	if (field.showIf) {
		const other = form.fields.find((f) => f.name === field.showIf?.field);
		const values = field.showIf.equals.map(quoted).join(" or ");
		d += `. Only when ${quoted(clean(other?.label) || field.showIf.field)} is ${field.showIf.not ? "not " : ""}${values}`;
	}
	return d.slice(0, 300);
}

/** The site search form (GET, no side effects: the agent may submit it and read the results page). */
export function searchTool(env: WebMcpEnv | undefined): ToolAttrs | undefined {
	return webMcpEnabled(env) ? { toolname: "search_site", tooldescription: "Search this website's pages and posts. Opens a results page with titles, links and excerpts.", toolautosubmit: true } : undefined;
}

/** The comment form. Not on sensitive sites (visitors there may write about their health, cases or money). */
export function commentTool(env: WebMcpEnv | undefined, submitLabel: string): ToolAttrs | undefined {
	return webMcpEnabled(env) && !siteSensitive(env) ? { toolname: "post_comment", tooldescription: `Write a public comment on this page. The visitor checks it and presses ${quoted(submitLabel)} to post it.` } : undefined;
}
