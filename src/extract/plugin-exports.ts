/**
 * Plugin data the WordPress REST API does not expose (or only to some plugins): the owner exports it from the plugin's
 * own Import/Export screen, the operator drops the files into `sites/<slug>/raw/plugin-exports/` (any name), and
 * extract recognises each file by its content and turns it into the kit's shapes:
 *
 * - forms → `raw/forms/<provider>/<id>.json` (`definition` = the starter's form shape; Fluent keeps its own raw shape)
 * - redirects → `raw/redirects.json` (EmDash redirect rules) plus the rules EmDash cannot hold, reported, never dropped
 *
 * Formats follow each plugin's documented export (Gravity Forms JSON, WPForms JSON, Contact Form 7 via WordPress
 * Tools → Export, Fluent Forms JSON, Redirection JSON, Rank Math .htaccess/Nginx, Yoast CSV). Check a parser against the
 * first real file a client sends and add that case to the fixtures.
 */
import type { FormDefinitionOut, FormFieldOut } from "../scaffold/forms.js";

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Obj) : []);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const slugName = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "field";
const AUTOCOMPLETE: Record<string, string> = { first_name: "given-name", last_name: "family-name", name: "name", full_name: "name", email: "email", phone: "tel", your_name: "name", your_email: "email", your_phone: "tel" };

// ── What to ask the owner for ────────────────────────────────────────────────────────────────────────────────────

export interface PluginExportSpec {
	id: string;
	name: string;
	kind: "forms" | "redirects";
	/** Matched against the audit's plugin names and form providers. */
	match: RegExp;
	/** Extract already reads this plugin over REST when the app password is set: the file is only a fallback. */
	automatic?: boolean;
	steps: string;
}

export const PLUGIN_EXPORTS: PluginExportSpec[] = [
	{ id: "fluent-forms", name: "Fluent Forms", kind: "forms", match: /fluent[- ]?forms?/i, automatic: true, steps: "Fluent Forms → Tools → Export Forms → select all forms → Export Forms (.json)" },
	{ id: "gravity-forms", name: "Gravity Forms", kind: "forms", match: /gravity[- ]?forms?|gravityforms/i, steps: "Forms → Import/Export → Export Forms → select all → Download Export File (.json)" },
	{ id: "wpforms", name: "WPForms", kind: "forms", match: /wpforms/i, steps: "WPForms → Tools → Export → Form Exports → select all forms → Export (.json)" },
	{ id: "contact-form-7", name: "Contact Form 7", kind: "forms", match: /contact[- ]?form[- ]?7|wpcf7/i, steps: "Tools → Export → choose “Contact Forms” → Download Export File (.xml)" },
	{ id: "ninja-forms", name: "Ninja Forms", kind: "forms", match: /ninja[- ]?forms?/i, steps: "Ninja Forms → Import/Export → Export Forms → each form (.nff) — rebuilt by hand from the file" },
	{ id: "formidable", name: "Formidable Forms", kind: "forms", match: /formidable/i, steps: "Formidable → Import/Export → Export → Forms (.xml) — rebuilt by hand from the file" },
	{ id: "redirection", name: "Redirection", kind: "redirects", match: /^redirection$|redirection plugin|\bredirection\/v1/i, steps: "Tools → Redirection → Import/Export → Export: “Everything”, format “JSON” → Download" },
	{ id: "rank-math-redirects", name: "Rank Math redirections", kind: "redirects", match: /rank[- ]?math/i, steps: "Rank Math → Redirections → Export → “Apache (.htaccess)” (or Nginx) — only if the Redirections module is on" },
	{ id: "yoast-redirects", name: "Yoast SEO Premium redirects", kind: "redirects", match: /yoast/i, steps: "Yoast SEO → Redirects → Import/Export → Export redirects (.csv) — Premium only" },
];

/** Which exports to ask for, from the plugins and form providers the audit found. */
export function exportsFor(signals: string[]): PluginExportSpec[] {
	return PLUGIN_EXPORTS.filter((s) => signals.some((x) => s.match.test(x)));
}

const MARK_START = "<!-- wp2emdash:plugin-exports -->";
const MARK_END = "<!-- /wp2emdash:plugin-exports -->";

/** The ACCESS.md section (kept between markers so audit can rewrite it; ticks the owner made are kept). */
export function accessSection(specs: PluginExportSpec[], slug: string, previous = ""): string {
	const ticked = new Set([...previous.matchAll(/^- \[x\] (?:\(required\) )?\*\*([^*]+)\*\*/gim)].map((m) => m[1]));
	const lines = specs.map((s) => {
		const required = !s.automatic && s.kind === "forms";
		const tick = ticked.has(s.name) ? "x" : " ";
		const note = s.automatic ? " (read automatically over REST with the app password; the file is a fallback)" : s.kind === "redirects" ? " (or, if there are none, set `redirects: { source: \"none\" }` in overrides.ts)" : "";
		return `- [${tick}] ${required ? "(required) " : ""}**${s.name}**: ${s.steps}${note}`;
	});
	return `${MARK_START}
## Plugin data (before extract)

The REST API does not expose these plugins' settings. Export each one from WordPress admin and put the files in
\`sites/${slug}/raw/plugin-exports/\` (any file name; extract recognises the format). Never put form *entries*
(submissions) here: only the form definitions and redirect rules.

${lines.length ? lines.join("\n") : "- Nothing to export: no form or redirect plugin was detected."}
${MARK_END}`;
}

/** Replace (or append) the generated section in an ACCESS.md text. */
export function withAccessSection(access: string, section: string): string {
	const re = new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`);
	return re.test(access) ? access.replace(re, section) : `${access.trimEnd()}\n\n${section}\n`;
}
export const previousSection = (access: string): string => new RegExp(`${MARK_START}[\\s\\S]*?${MARK_END}`).exec(access)?.[0] ?? "";

// ── Forms ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ImportedForm {
	provider: string;
	id: string;
	title: string;
	status: "publish" | "draft";
	/** Fluent Forms keeps its REST shape (scaffold's own converter reads it); the others carry the definition. */
	raw?: Obj;
	definition?: Omit<FormDefinitionOut, "sensitive"> & { sensitive?: boolean };
	/** Number of notification recipients configured in WordPress (the addresses stay in raw/, never in the project). */
	recipients?: string[];
}

const field = (name: string, label: string, type: FormFieldOut["type"], extra: Partial<FormFieldOut> = {}): FormFieldOut => {
	const ac = AUTOCOMPLETE[name] ?? (type === "email" ? "email" : type === "tel" ? "tel" : undefined);
	return { name, label: label || name, type, ...extra, ...(ac && !extra.autocomplete ? { autocomplete: ac } : {}) };
};
const def = (id: string, title: string, fields: FormFieldOut[], submitLabel: string | undefined, success: string | undefined, warnings: string[]): ImportedForm["definition"] => ({
	id,
	title,
	submitLabel: submitLabel?.trim() || "Send",
	successMessage: success ? stripHtml(success) : "Thank you — we will be in touch.",
	fields,
	warnings,
});
const emails = (s: string | undefined) => [...new Set((s ?? "").split(/[\s,;]+/).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];

/** Gravity Forms export: `{ "0": form, "1": form, …, "version": "2.x" }` (older exports: an array). */
export function parseGravityForms(json: unknown): ImportedForm[] {
	const forms = (Array.isArray(json) ? json : Object.entries(o(json)).filter(([k]) => /^\d+$/.test(k)).map(([, v]) => v)).map(o).filter((f) => Array.isArray(f.fields));
	const TYPE: Record<string, FormFieldOut["type"]> = { text: "text", name: "text", email: "email", phone: "tel", number: "number", website: "url", date: "date", textarea: "textarea", select: "select", radio: "select", checkbox: "checkbox", consent: "checkbox", multiselect: "select" };
	return forms.map((f, i) => {
		const id = str(f.id) ?? String(i + 1);
		const warnings: string[] = [];
		const fields: FormFieldOut[] = [];
		for (const x of (f.fields as unknown[]).map(o)) {
			const t = str(x.type) ?? "";
			const label = stripHtml(str(x.label) ?? "");
			const required = truthy(x.isRequired);
			if (t === "name" && Array.isArray(x.inputs)) {
				for (const sub of (x.inputs as unknown[]).map(o)) {
					if (truthy(sub.isHidden)) continue;
					const l = stripHtml(str(sub.customLabel) || str(sub.label) || "");
					const n = /first/i.test(l) ? "first_name" : /last/i.test(l) ? "last_name" : slugName(l);
					fields.push(field(n, l, "text", { ...(required ? { required } : {}), half: true }));
				}
				continue;
			}
			const type = TYPE[t];
			if (!type) {
				if (!["html", "section", "page", "captcha", "hidden"].includes(t)) warnings.push(`field "${t}" (${label || "no label"}) not supported; rebuild by hand`);
				continue;
			}
			const name = slugName(str(x.adminLabel) || (t === "email" ? "email" : t === "phone" ? "phone" : label) || `${t}_${str(x.id)}`);
			const options = t === "consent" ? undefined : arr(x.choices).map((c) => str(o(c).text) ?? "").filter(Boolean);
			const placeholder = str(x.placeholder);
			fields.push(field(name, t === "consent" ? stripHtml(str(x.checkboxLabel) ?? label) : label, type, { ...(required ? { required } : {}), ...(placeholder ? { placeholder } : {}), ...(options?.length ? { options } : {}) }));
		}
		const confirmation = arr(f.confirmations).map(o).find((c) => truthy(c.isDefault)) ?? arr(f.confirmations).map(o)[0];
		if (confirmation && str(confirmation.type) && confirmation.type !== "message") warnings.push(`confirmation is a ${str(confirmation.type)} (redirect/page): rebuilt as a message`);
		const recipients = arr(f.notifications).map(o).filter((n) => !n.isActive || truthy(n.isActive)).flatMap((n) => emails(str(n.to)));
		const title = str(f.title) ?? `Form ${id}`;
		return { provider: "gravity-forms", id, title, status: f.is_active === undefined || truthy(f.is_active) ? "publish" : "draft", definition: def(`gravity-forms-${id}`, title, fields, str(o(f.button).text), str(confirmation?.message), warnings), recipients };
	});
}

/** WPForms export: an array of forms (`fields` keyed by field id, `settings`). */
export function parseWpForms(json: unknown): ImportedForm[] {
	const TYPE: Record<string, FormFieldOut["type"]> = { text: "text", name: "text", email: "email", phone: "tel", number: "number", "number-slider": "number", url: "url", "date-time": "date", textarea: "textarea", select: "select", radio: "select", checkbox: "checkbox", gdpr: "checkbox", "gdpr-checkbox": "checkbox" };
	return arr(json)
		.map(o)
		.filter((f) => f.fields && f.settings)
		.map((f, i) => {
			const id = str(f.id) ?? String(i + 1);
			const s = o(f.settings);
			const warnings: string[] = [];
			const fields: FormFieldOut[] = [];
			for (const x of arr(f.fields).map(o)) {
				const t = str(x.type) ?? "";
				const label = stripHtml(str(x.label) ?? "");
				const required = truthy(x.required);
				if (t === "name" && /first/.test(str(x.format) ?? "")) {
					fields.push(field("first_name", "First name", "text", { ...(required ? { required } : {}), half: true }));
					fields.push(field("last_name", "Last name", "text", { ...(required ? { required } : {}), half: true }));
					continue;
				}
				const type = TYPE[t];
				if (!type) {
					if (!["html", "divider", "pagebreak", "hidden", "captcha", "content", "entry-preview"].includes(t)) warnings.push(`field "${t}" (${label || "no label"}) not supported; rebuild by hand`);
					continue;
				}
				const name = t === "email" ? "email" : t === "phone" ? "phone" : t === "name" ? "name" : slugName(label || `${t}_${str(x.id)}`);
				const options = ["select", "radio", "checkbox"].includes(t) ? arr(x.choices).map((c) => str(o(c).label) ?? "").filter(Boolean) : undefined;
				const placeholder = str(x.placeholder);
				fields.push(field(name, label, type, { ...(required ? { required } : {}), ...(placeholder ? { placeholder } : {}), ...(options && options.length > 1 ? { options } : {}) }));
			}
			const confirmation = arr(s.confirmations).map(o)[0];
			if (confirmation && str(confirmation.type) && confirmation.type !== "message") warnings.push(`confirmation is a ${str(confirmation.type)} (redirect/page): rebuilt as a message`);
			const recipients = arr(s.notifications).flatMap((n) => emails(str(o(n).email)));
			if (arr(s.notifications).some((n) => /\{admin_email\}/.test(str(o(n).email) ?? ""))) warnings.push("a notification goes to {admin_email}: set the recipients in the site's admin (Form messages → Settings)");
			const title = str(s.form_title) ?? str(f.post_title) ?? `Form ${id}`;
			return { provider: "wpforms", id, title, status: "publish" as const, definition: def(`wpforms-${id}`, title, fields, str(s.submit_text), str(confirmation?.message), warnings), recipients };
		});
}

/** One value from a PHP-serialised array: `s:12:"mail_sent_ok";s:N:"…"`. */
const phpValue = (serialised: string, key: string): string | undefined => {
	const re = new RegExp(`s:\\d+:"${key}";s:(\\d+):"`);
	const m = re.exec(serialised);
	if (!m) return undefined;
	const start = m.index + m[0].length;
	// Lengths are in bytes; read up to the closing quote that ends the value.
	const end = serialised.indexOf('";', start + Math.max(0, Number(m[1]) - 8));
	return end > start ? serialised.slice(start, end) : undefined;
};
const xmlText = (s: string) => s.replace(/^<!\[CDATA\[|\]\]>$/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");

/** Contact Form 7, from WordPress Tools → Export (WXR items of post type wpcf7_contact_form). */
export function parseContactForm7(xml: string): ImportedForm[] {
	const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1] ?? "").filter((i) => /<wp:post_type>(?:<!\[CDATA\[)?wpcf7_contact_form/.test(i));
	const meta = (item: string, key: string) => {
		const m = new RegExp(`<wp:meta_key>(?:<!\\[CDATA\\[)?${key}(?:\\]\\]>)?</wp:meta_key>\\s*<wp:meta_value>([\\s\\S]*?)</wp:meta_value>`).exec(item);
		return m?.[1] ? xmlText(m[1].trim()) : undefined;
	};
	const TYPE: Record<string, FormFieldOut["type"]> = { text: "text", email: "email", tel: "tel", number: "number", url: "url", date: "date", textarea: "textarea", select: "select", radio: "select", checkbox: "checkbox", acceptance: "checkbox" };
	return items.map((item) => {
		const id = /<wp:post_id>(\d+)<\/wp:post_id>/.exec(item)?.[1] ?? "0";
		const title = xmlText(/<title>([\s\S]*?)<\/title>/.exec(item)?.[1]?.trim() ?? `Form ${id}`);
		const template = meta(item, "_form") ?? "";
		const warnings: string[] = [];
		const fields: FormFieldOut[] = [];
		let submit: string | undefined;
		// Label text written right before a tag (`<label> Your name [text* your-name] </label>`).
		const tagRe = /\[(\w+)(\*?)\s+([\w-]+)([^\]]*)\]/g;
		let last = 0;
		for (let m = tagRe.exec(template); m; m = tagRe.exec(template)) {
			const [, t = "", star, name = "", rest = ""] = m;
			const before = stripHtml(template.slice(last, m.index).split(/<\/label>|<br\s*\/?>|\n\s*\n/i).pop() ?? "");
			last = m.index + m[0].length;
			if (t === "submit") continue;
			const type = TYPE[t];
			if (!type) {
				if (!["hidden", "recaptcha", "quiz", "file", "response"].includes(t)) warnings.push(`field "${t}" (${name}) not supported; rebuild by hand`);
				if (t === "file") warnings.push(`file upload "${name}" is not carried over (the new forms take no attachments)`);
				continue;
			}
			const quoted = [...rest.matchAll(/"([^"]*)"/g)].map((q) => q[1] ?? "");
			const placeholder = /\bplaceholder\b/.test(rest) ? quoted[0] : undefined;
			const options = ["select", "radio", "checkbox"].includes(t) && quoted.length > 1 ? quoted : undefined;
			const acceptance = t === "acceptance" ? stripHtml(new RegExp(`\\[acceptance[^\\]]*\\b${name}\\b[^\\]]*\\]([\\s\\S]*?)\\[/acceptance\\]`).exec(template)?.[1] ?? "") : undefined;
			const n = name.replace(/-/g, "_");
			const label = acceptance || before || placeholder || (t === "checkbox" && quoted.length === 1 ? quoted[0] : undefined) || name.replace(/^your-/, "").replace(/-/g, " ");
			fields.push(field(n, label ?? n, type, { ...(star || t === "acceptance" ? { required: true } : {}), ...(placeholder ? { placeholder } : {}), ...(options ? { options } : {}) }));
		}
		submit = /\[submit\s+"([^"]+)"\]/.exec(template)?.[1];
		const messages = meta(item, "_messages") ?? "";
		const mail = meta(item, "_mail") ?? "";
		const recipients = emails(phpValue(mail, "recipient"));
		if (/\[_site_admin_email\]/.test(phpValue(mail, "recipient") ?? "")) warnings.push("mail goes to [_site_admin_email]: set the recipients in the site's admin (Form messages → Settings)");
		const status = /<wp:status>(?:<!\[CDATA\[)?publish/.test(item) ? "publish" : "draft";
		return { provider: "contact-form-7", id, title, status, definition: def(`contact-form-7-${id}`, title, fields, submit, phpValue(messages, "mail_sent_ok"), warnings), recipients };
	});
}

/** Fluent Forms Tools → Export: an array of forms with `form_fields` (JSON string) and `metas`; kept in the REST shape. */
export function parseFluentFormsExport(json: unknown): ImportedForm[] {
	return arr(json)
		.map(o)
		.filter((f) => f.form_fields !== undefined && (f.title !== undefined || f.id !== undefined))
		.map((f) => {
			const parse = (v: unknown) => {
				if (typeof v !== "string") return v;
				try {
					return JSON.parse(v);
				} catch {
					return v;
				}
			};
			const settings: Obj = {};
			for (const m of arr(f.metas).map(o)) {
				const key = str(m.meta_key);
				if (key && ["formSettings", "notifications", "advancedValidationSettings", "double_optin_settings"].includes(key)) settings[key] = [...((settings[key] as unknown[]) ?? []), { value: parse(m.value) }];
			}
			const id = str(f.id) ?? "0";
			const title = str(f.title) ?? `Form ${id}`;
			const recipients = ((settings.notifications as Obj[] | undefined) ?? []).flatMap((n) => emails(str(o(o(n).value).sendTo && o(o(o(n).value).sendTo).email)));
			return { provider: "fluent-forms", id, title, status: str(f.status) === "unpublished" ? ("draft" as const) : ("publish" as const), raw: { provider: "fluent-forms", id, title, status: str(f.status) ?? "published", form: { form_fields: parse(f.form_fields) }, settings }, recipients };
		});
}

// ── Redirects ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RedirectRule {
	source: string;
	destination: string;
	type: 301 | 302 | 307 | 308 | 410 | 451;
	from: string;
}
export interface Unconverted {
	rule: string;
	reason: string;
	from: string;
}

/** Hosts that count as this site (old and new): their absolute URLs become paths. */
export function toPath(url: string, siteHosts: string[]): string | undefined {
	const u = url.trim();
	if (!u) return undefined;
	if (u.startsWith("/") && !u.startsWith("//")) return u;
	if (!/^https?:\/\//i.test(u)) return `/${u.replace(/^\.?\//, "")}`;
	try {
		const p = new URL(u);
		if (!siteHosts.map((h) => h.replace(/^www\./, "")).includes(p.host.replace(/^www\./, ""))) return undefined;
		return `${p.pathname}${p.search}`;
	} catch {
		return undefined;
	}
}

const STATUS = new Set([301, 302, 307, 308, 410, 451]);
const status = (v: unknown): RedirectRule["type"] => {
	const n = Number(v);
	return (STATUS.has(n) ? n : 301) as RedirectRule["type"];
};

/** `^/?old/(.*)$` → `/old/[...path]` with `$1` → `[...path]`: the only regex shape EmDash's route patterns can hold. */
export function regexToPattern(source: string, destination: string): { source: string; destination: string } | undefined {
	const m = /^\^?\/?((?:[\w-]+\/)*[\w-]+)\/?\(\.\*\)\/?\$?$/.exec(source.trim());
	if (!m) {
		const exact = /^\^?(\/?[\w\-/.]*?)\/?\??\$$/.exec(source.trim());
		if (exact && !/[()[\]*+?{}|\\]/.test(exact[1]?.replace(/\./g, "") ?? "")) return { source: `/${(exact[1] ?? "").replace(/^\//, "")}`.replace(/\\\./g, "."), destination };
		return undefined;
	}
	const base = `/${m[1]}`;
	if ((destination.match(/\$1/g) ?? []).length > 1 || /\$[2-9]/.test(destination)) return undefined;
	return { source: `${base}/[...path]`, destination: destination.replace("$1", "[...path]") };
}

function rule(source: string, destination: string, code: unknown, from: string, hosts: string[], isRegex: boolean, out: RedirectRule[], bad: Unconverted[]): void {
	const type = status(code);
	const terminal = type === 410 || type === 451;
	let src = source;
	let dest = destination;
	if (isRegex) {
		const p = regexToPattern(source, destination);
		if (!p) return void bad.push({ rule: `${source} → ${destination}`, reason: "regular expression EmDash cannot express (route patterns only: [param], [...rest])", from });
		src = p.source;
		dest = p.destination;
	}
	const s = toPath(src, hosts);
	if (!s) return void bad.push({ rule: `${source} → ${destination}`, reason: "source is not on this site", from });
	const d = terminal ? "" : toPath(dest, hosts);
	if (d === undefined) return void bad.push({ rule: `${source} → ${destination}`, reason: "destination is another site (EmDash redirects only to paths on this site): keep it as a link or an edge rule", from });
	if (!terminal && s === d) return;
	out.push({ source: s, destination: d, type, from });
}

/** Redirection plugin JSON export. */
export function parseRedirection(json: unknown, hosts: string[]): { rules: RedirectRule[]; unconverted: Unconverted[] } {
	const rules: RedirectRule[] = [];
	const unconverted: Unconverted[] = [];
	for (const r of arr(o(json).redirects).map(o)) {
		const url = str(r.url) ?? "";
		if (r.enabled === false || r.status === "disabled") continue;
		if ((str(r.match_type) ?? "url") !== "url" || (str(r.action_type) ?? "url") !== "url") {
			if (str(r.action_type) === "error" && str(r.match_type) === "url") rule(url, "", 410, "redirection", hosts, truthy(r.regex), rules, unconverted);
			else unconverted.push({ rule: url, reason: `match "${str(r.match_type)}" / action "${str(r.action_type)}" (conditional or non-URL rule)`, from: "redirection" });
			continue;
		}
		const data = r.action_data;
		const target = typeof data === "string" ? data : (str(o(data).url) ?? "");
		rule(url, target, r.action_code, "redirection", hosts, truthy(r.regex), rules, unconverted);
	}
	return { rules, unconverted };
}

/** Apache (.htaccess) or Nginx rules, as Rank Math exports them (and hand-written ones of the same shapes). */
export function parseServerRules(text: string, hosts: string[], from = "rank-math"): { rules: RedirectRule[]; unconverted: Unconverted[] } {
	const rules: RedirectRule[] = [];
	const unconverted: Unconverted[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#") || /^(RewriteEngine|RewriteBase|<\/?IfModule|RewriteCond|server\s*\{|\}|location\s*\/\s*\{)/i.test(line)) {
			if (/^RewriteCond/i.test(line)) unconverted.push({ rule: line, reason: "conditional rule (RewriteCond)", from });
			continue;
		}
		let m = /^Redirect(?:Permanent)?\s+(?:(\d{3}|permanent|temp|gone)\s+)?"?([^"\s]+)"?(?:\s+"?([^"\s]+)"?)?/i.exec(line);
		if (m) {
			const code = m[1] === "gone" ? 410 : m[1] === "temp" ? 302 : m[1] && /^\d+$/.test(m[1]) ? m[1] : 301;
			rule(m[2] ?? "", m[3] ?? "", code, from, hosts, false, rules, unconverted);
			continue;
		}
		m = /^RedirectMatch\s+(?:(\d{3})\s+)?"?([^"\s]+)"?\s+"?([^"\s]+)"?/i.exec(line);
		if (m) {
			rule(m[2] ?? "", m[3] ?? "", m[1] ?? 301, from, hosts, true, rules, unconverted);
			continue;
		}
		m = /^RewriteRule\s+"?([^"\s]+)"?\s+"?([^"\s]+)"?\s+\[([^\]]*)\]/i.exec(line);
		if (m) {
			const flags = m[3] ?? "";
			const code = /R=(\d{3})/i.exec(flags)?.[1] ?? (/\bG\b/.test(flags) ? 410 : /\bR\b/.test(flags) ? 302 : undefined);
			if (!code) unconverted.push({ rule: line, reason: "internal rewrite, not a redirect", from });
			else rule(m[1] ?? "", m[2] ?? "", code, from, hosts, true, rules, unconverted);
			continue;
		}
		m = /^location\s+(=|~\*?)?\s*"?([^"\s{]+)"?\s*\{\s*return\s+(\d{3})\s*([^;\s]*)\s*;\s*\}?/i.exec(line);
		if (m) {
			rule(m[2] ?? "", m[4] ?? "", m[3], from, hosts, (m[1] ?? "").startsWith("~"), rules, unconverted);
			continue;
		}
		m = /^rewrite\s+"?([^"\s]+)"?\s+"?([^"\s]+)"?\s+(permanent|redirect)\s*;/i.exec(line);
		if (m) {
			rule(m[1] ?? "", m[2] ?? "", m[3] === "permanent" ? 301 : 302, from, hosts, true, rules, unconverted);
			continue;
		}
		unconverted.push({ rule: line.slice(0, 200), reason: "line not understood", from });
	}
	return { rules, unconverted };
}

/** CSV: Yoast (Origin, Target, Type, Format) or any `from,to[,code]` file; regex rows (Yoast format "regex") are converted when they can be. */
export function parseRedirectCsv(text: string, hosts: string[], from = "csv"): { rules: RedirectRule[]; unconverted: Unconverted[] } {
	const rules: RedirectRule[] = [];
	const unconverted: Unconverted[] = [];
	const rows = text.split(/\r?\n/).filter((l) => l.trim()).map((l) => [...l.matchAll(/("([^"]|"")*"|[^,;\t]*)(?:[,;\t]|$)/g)].map((m) => (m[1] ?? "").replace(/^"|"$/g, "").replace(/""/g, '"').trim()).filter((_, i, a) => i < a.length - 1 || a[i] !== ""));
	const header = rows[0]?.map((h) => h.toLowerCase()) ?? [];
	const hasHeader = header.some((h) => /origin|source|from|old|url/.test(h)) && !header.some((h) => h.startsWith("/") || /^https?:/.test(h));
	const col = (re: RegExp, fallback: number) => (hasHeader ? Math.max(header.findIndex((h) => re.test(h)), -1) : fallback);
	const [ci, ct, cc, cf] = [col(/origin|source|from|old/, 0), col(/target|destination|to|new/, 1), col(/type|code|status/, 2), col(/format|regex/, 3)];
	for (const r of rows.slice(hasHeader ? 1 : 0)) {
		const src = r[ci < 0 ? 0 : ci] ?? "";
		if (!src) continue;
		rule(src, r[ct < 0 ? 1 : ct] ?? "", r[cc] ?? 301, from, hosts, /regex/i.test(r[cf] ?? ""), rules, unconverted);
	}
	return { rules, unconverted };
}

// ── Recognise a dropped file ─────────────────────────────────────────────────────────────────────────────────────

export type Recognised =
	| { kind: "forms"; provider: string; forms: ImportedForm[] }
	| { kind: "redirects"; provider: string; rules: RedirectRule[]; unconverted: Unconverted[] }
	| { kind: "unknown"; reason: string };

export function recognise(fileName: string, content: string, hosts: string[]): Recognised {
	const text = content.replace(/^\uFEFF/, "");
	if (/\.nff$/i.test(fileName)) return { kind: "unknown", reason: "Ninja Forms export: rebuild the form by hand from it (fields are listed in the file)" };
	if (text.trimStart().startsWith("<")) {
		if (/wpcf7_contact_form/.test(text)) return { kind: "forms", provider: "contact-form-7", forms: parseContactForm7(text) };
		if (/<forms>|formidable/i.test(text)) return { kind: "unknown", reason: "Formidable export: rebuild the form by hand from it" };
		return { kind: "unknown", reason: "XML without Contact Form 7 forms" };
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		json = undefined;
	}
	if (json !== undefined) {
		const top = o(json);
		if (Array.isArray(top.redirects)) {
			const r = parseRedirection(json, hosts);
			return { kind: "redirects", provider: "redirection", ...r };
		}
		const list = arr(json).map(o);
		if (list.some((f) => f.form_fields !== undefined)) return { kind: "forms", provider: "fluent-forms", forms: parseFluentFormsExport(json) };
		if (list.some((f) => f.fields && f.settings && (o(f.settings).form_title !== undefined || o(f.settings).submit_text !== undefined))) return { kind: "forms", provider: "wpforms", forms: parseWpForms(json) };
		if (top.version !== undefined || list.some((f) => Array.isArray(f.fields) && (f.button || f.confirmations || f.notifications))) {
			const forms = parseGravityForms(json);
			if (forms.length) return { kind: "forms", provider: "gravity-forms", forms };
		}
		return { kind: "unknown", reason: "JSON in a shape the kit does not know" };
	}
	if (/^\s*(Redirect|RewriteRule|RewriteEngine|<IfModule|location\s|rewrite\s|server\s*\{)/im.test(text)) return { kind: "redirects", provider: /\blocation\s|rewrite\s.*(permanent|redirect);/i.test(text) ? "nginx" : "htaccess", ...parseServerRules(text, hosts, /\.conf$|nginx/i.test(fileName) ? "nginx" : "htaccess") };
	if (/[,;\t]/.test(text.split(/\r?\n/)[0] ?? "")) return { kind: "redirects", provider: "csv", ...parseRedirectCsv(text, hosts, /yoast/i.test(fileName) || /^"?origin"?[,;]/i.test(text) ? "yoast" : "csv") };
	return { kind: "unknown", reason: "format not recognised" };
}
