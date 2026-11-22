/**
 * Form leads to a CRM or mailing list, in addition to the email: Brevo contacts, HubSpot contacts, Mailchimp audience
 * members. Request shapes and auth: docs/spikes/forms-crm-findings.md.
 *
 * Present on every site with the outbox, but nothing is sent until an admin turns a provider on (Form messages →
 * Settings → CRM & mailing lists), picks it for a form, AND the provider's secret exists as a Worker secret:
 *   BREVO_API_KEY (or, when EMAIL_PROVIDER=brevo, the email key EMAIL_API_KEY) · HUBSPOT_TOKEN (private app token,
 *   scope crm.objects.contacts.write) · MAILCHIMP_API_KEY (its "-us21" suffix is the server prefix; MAILCHIMP_SERVER_PREFIX
 *   overrides it).
 * Settings (providers, list / audience ids, provider field names, and per form which providers and which form field
 * goes where) live in the outbox's KV under `cfg:crm`. FORM_CRM="0" (kit.config forms.crm: false) removes the feature.
 *
 * What is sent: only the mapped fields (email, first / last / full name, phone, company, message) — never the whole
 * submission, never files or signatures. Marketing consent: when the form maps a newsletter / consent checkbox, the
 * contact is subscribed only if it was ticked (Brevo: added to the list; Mailchimp: subscribed, or pending with double
 * opt-in; HubSpot: the consent property set, if one is named). Otherwise the contact is created or updated as a
 * transactional contact only: Brevo without a list, HubSpot without the consent property, Mailchimp per setting —
 * skipped (default) or `transactional` (never `subscribed`). An existing contact's subscription is never downgraded or
 * upgraded without a tick.
 *
 * Sensitive data: on a site with FORM_SENSITIVE="1" (kit.config sensitiveData) or for a form marked sensitive, nothing
 * is ever sent and the settings cannot turn it on — checked when settings are saved, when a message arrives and again
 * when a retry runs.
 *
 * Delivery never blocks or fails a form submission: the endpoint hands `syncCrm` to waitUntil, and it never throws. A
 * provider that fails with a temporary error (network, 408, 429, 5xx) is kept as a small job in the same KV
 * (`crm:<time>:<hex>`, the mapped contact only, two days at most) and retried by the outbox's 5-minute cron with backoff
 * (5 min, 15 min, 1 h, 4 h, 12 h); a permanent error (other 4xx) or the last attempt is counted per day and provider
 * (`crmfail:<day>:<provider>`) and the provider's error text — scrubbed of the contact's details, email addresses and
 * long numbers — is kept as the provider's last error (`crmerr:<provider>`) for Settings. Logs carry provider names and
 * counts only.
 */
import { clean } from "./chat.js";
import type { KvLike, OutboxEnv } from "./outbox.js";
import { retentionDays } from "./outbox.js";

export type Provider = "brevo" | "hubspot" | "mailchimp";
export const PROVIDERS: readonly Provider[] = ["brevo", "hubspot", "mailchimp"];
export const PROVIDER_NAME: Record<Provider, string> = { brevo: "Brevo", hubspot: "HubSpot", mailchimp: "Mailchimp" };
/** The Worker secret each provider needs (Brevo also accepts the email key when EMAIL_PROVIDER=brevo). */
export const PROVIDER_SECRET: Record<Provider, string> = { brevo: "BREVO_API_KEY", hubspot: "HUBSPOT_TOKEN", mailchimp: "MAILCHIMP_API_KEY" };

/** What a form field can be sent as. `consent` is the marketing opt-in checkbox (never sent as a value). */
export type Target = "email" | "firstName" | "lastName" | "fullName" | "phone" | "company" | "message" | "consent";
export const TARGETS: readonly Target[] = ["email", "firstName", "lastName", "fullName", "phone", "company", "message", "consent"];
export const TARGET_LABEL: Record<Target, string> = { email: "Email", firstName: "First name", lastName: "Last name", fullName: "Full name (split into first and last)", phone: "Phone", company: "Company", message: "Message", consent: "Marketing opt-in (newsletter checkbox)" };
/** Provider-side names an admin can change (attribute, property or merge tag). Empty: not sent to that provider. */
export type NamedField = "firstName" | "lastName" | "phone" | "company" | "message";
export const NAMED_FIELDS: readonly NamedField[] = ["firstName", "lastName", "phone", "company", "message"];

export interface CrmFormSetting {
	providers: Provider[];
	map: Partial<Record<Target, string>>;
}

export interface CrmSettings {
	brevo: { on: boolean; listId?: number; names: Record<NamedField, string> };
	hubspot: { on: boolean; names: Record<NamedField, string>; consentProperty?: string };
	mailchimp: { on: boolean; audienceId?: string; doubleOptIn: boolean; unconsented: "skip" | "transactional"; names: Record<NamedField, string> };
	/** Per form (by id). A form without an entry uses the site default: the pre-selected providers and the auto-mapping. */
	forms: Record<string, CrmFormSetting>;
}

export interface CrmEnv extends OutboxEnv {
	BREVO_API_KEY?: string;
	HUBSPOT_TOKEN?: string;
	MAILCHIMP_API_KEY?: string;
	/** Optional: the Mailchimp data center (e.g. "us21") when it cannot be read from the key. */
	MAILCHIMP_SERVER_PREFIX?: string;
	/** "0": no CRM sync on this site (kit.config forms.crm: false). */
	FORM_CRM?: string;
	/** kit.config forms.crm.providers: the providers switched on (and picked for every form) until an admin saves. */
	FORM_CRM_PRESELECT?: string;
	FORM_CRM_BREVO_LIST?: string;
	FORM_CRM_MAILCHIMP_AUDIENCE?: string;
	/** "1": sensitive data (kit.config sensitiveData) — CRM sync is impossible. */
	FORM_SENSITIVE?: string;
	/** "1": the opt-in staging environment — never syncs (its leads are tests). */
	STAGING?: string;
}

export const DEFAULT_NAMES: Record<Provider, Record<NamedField, string>> = {
	// Brevo's default contact attributes (accounts in other languages may use e.g. PRENOM / NOM: editable).
	brevo: { firstName: "FIRSTNAME", lastName: "LASTNAME", phone: "SMS", company: "", message: "" },
	// HubSpot's default contact properties.
	hubspot: { firstName: "firstname", lastName: "lastname", phone: "phone", company: "company", message: "message" },
	// Mailchimp's default merge fields (an audience has no company or message field unless one is added).
	mailchimp: { firstName: "FNAME", lastName: "LNAME", phone: "PHONE", company: "", message: "" },
};

export const MAX_ATTEMPTS = 6;
/** Minutes to wait after attempt n (1-based) before the next one. */
export const BACKOFF_MINUTES = [5, 15, 60, 240, 720] as const;
const SETTINGS_KEY = "cfg:crm";
const JOB = "crm:";
const JOB_KEY = /^crm:[0-9TZ:.-]+:[0-9a-f]{8}$/;
const FAIL = "crmfail:";
const LAST_ERROR = "crmerr:";
const DAY = 86_400;
const FORM_ID = /^[\w-]{1,80}$/;
const FIELD_NAME = /^[\w.:\[\]-]{1,100}$/;
const EMAIL = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
const NAME_RULE: Record<Provider, RegExp> = { brevo: /^[A-Za-z][A-Za-z0-9_]{0,49}$/, hubspot: /^[a-z][a-z0-9_]{0,99}$/, mailchimp: /^[A-Z][A-Z0-9_]{0,9}$/ };
const NAME_HINT: Record<Provider, string> = { brevo: "a Brevo attribute name (letters, digits, _; e.g. COMPANY)", hubspot: "a HubSpot property's internal name (lower case, digits, _; e.g. company)", mailchimp: "a Mailchimp merge tag (capitals, digits, _; up to 10; e.g. COMPANY)" };
const AUDIENCE = /^[0-9a-f]{6,20}$/;

export const crmEnabled = (env: CrmEnv) => env.FORM_CRM !== "0";
export const crmSiteSensitive = (env: CrmEnv) => env.FORM_SENSITIVE === "1";

/** The key a provider uses (never logged, never returned to the admin). */
function keyOf(env: CrmEnv, p: Provider): string {
	if (p === "brevo") return (env.BREVO_API_KEY ?? (env.EMAIL_PROVIDER === "brevo" ? env.EMAIL_API_KEY : undefined) ?? "").trim();
	return ((p === "hubspot" ? env.HUBSPOT_TOKEN : env.MAILCHIMP_API_KEY) ?? "").trim();
}

/** Mailchimp's data center: MAILCHIMP_SERVER_PREFIX, else the key's suffix ("…-us21" → "us21"). */
export function mailchimpServer(env: CrmEnv): string | undefined {
	const set = (env.MAILCHIMP_SERVER_PREFIX ?? "").trim().toLowerCase();
	if (/^[a-z]{2,4}\d{1,3}$/.test(set)) return set;
	const m = /-([a-z]{2,4}\d{1,3})$/.exec(keyOf(env, "mailchimp"));
	return m?.[1];
}

/** Whether a provider's secret is set and looks right (the value itself never leaves this module). */
export function crmSecretSet(env: CrmEnv, p: Provider): boolean {
	const k = keyOf(env, p);
	if (!k || /\s/.test(k)) return false;
	if (p === "brevo") return k.length >= 20 && k.length <= 200;
	if (p === "hubspot") return /^pat-[a-z0-9]+-[\w-]{20,}$/.test(k);
	return /^[0-9a-f]{32}-[a-z]{2,4}\d{1,3}$/.test(k) || (k.length >= 20 && !!mailchimpServer(env));
}

/** Whether Brevo would use the email key (no separate BREVO_API_KEY): shown in Settings. */
export const brevoUsesEmailKey = (env: CrmEnv) => !(env.BREVO_API_KEY ?? "").trim() && env.EMAIL_PROVIDER === "brevo" && !!(env.EMAIL_API_KEY ?? "").trim();

// ── Settings ──────────────────────────────────────────────────────────────────────────────────────────────────────

const preselected = (env: CrmEnv): Provider[] => (crmSiteSensitive(env) ? [] : [...new Set((env.FORM_CRM_PRESELECT ?? "").split(",").map((s) => s.trim()).filter((s): s is Provider => (PROVIDERS as readonly string[]).includes(s)))]);

/** The settings before an admin saved any: everything off, unless kit.config pre-selected providers. */
export function defaultCrm(env: CrmEnv = {}): CrmSettings {
	const pre = preselected(env);
	const list = Number(env.FORM_CRM_BREVO_LIST);
	const audience = (env.FORM_CRM_MAILCHIMP_AUDIENCE ?? "").trim();
	return {
		brevo: { on: pre.includes("brevo"), ...(Number.isInteger(list) && list > 0 ? { listId: list } : {}), names: { ...DEFAULT_NAMES.brevo } },
		hubspot: { on: pre.includes("hubspot"), names: { ...DEFAULT_NAMES.hubspot } },
		mailchimp: { on: pre.includes("mailchimp") && AUDIENCE.test(audience), ...(AUDIENCE.test(audience) ? { audienceId: audience } : {}), doubleOptIn: true, unconsented: "skip", names: { ...DEFAULT_NAMES.mailchimp } },
		forms: {},
	};
}

function parseNames(p: Provider, raw: unknown): Record<NamedField, string> {
	const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
	const out = { ...DEFAULT_NAMES[p] };
	for (const n of NAMED_FIELDS) if (typeof o[n] === "string") out[n] = NAME_RULE[p].test(o[n] as string) ? (o[n] as string) : "";
	return out;
}

function parseFormSetting(raw: unknown): CrmFormSetting | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const o = raw as Record<string, unknown>;
	const providers = Array.isArray(o.providers) ? [...new Set(o.providers.filter((p): p is Provider => (PROVIDERS as readonly unknown[]).includes(p)))] : [];
	const map: Partial<Record<Target, string>> = {};
	const m = (typeof o.map === "object" && o.map !== null ? o.map : {}) as Record<string, unknown>;
	for (const t of TARGETS) if (typeof m[t] === "string" && FIELD_NAME.test(m[t] as string)) map[t] = m[t] as string;
	return { providers, map };
}

/** Stored settings (or anything else) as settings: unknown values fall back to the defaults (everything off). */
export function parseCrmSettings(raw: unknown): CrmSettings {
	const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, any>;
	const list = Number(o.brevo?.listId);
	const forms: Record<string, CrmFormSetting> = {};
	if (typeof o.forms === "object" && o.forms !== null)
		for (const [id, v] of Object.entries(o.forms as Record<string, unknown>).slice(0, 100)) {
			const f = FORM_ID.test(id) ? parseFormSetting(v) : undefined;
			if (f) forms[id] = f;
		}
	return {
		brevo: { on: o.brevo?.on === true, ...(Number.isInteger(list) && list > 0 ? { listId: list } : {}), names: parseNames("brevo", o.brevo?.names) },
		hubspot: { on: o.hubspot?.on === true, names: parseNames("hubspot", o.hubspot?.names), ...(typeof o.hubspot?.consentProperty === "string" && NAME_RULE.hubspot.test(o.hubspot.consentProperty) ? { consentProperty: o.hubspot.consentProperty as string } : {}) },
		mailchimp: { on: o.mailchimp?.on === true && AUDIENCE.test(o.mailchimp?.audienceId ?? ""), ...(AUDIENCE.test(o.mailchimp?.audienceId ?? "") ? { audienceId: o.mailchimp.audienceId as string } : {}), doubleOptIn: o.mailchimp?.doubleOptIn !== false, unconsented: o.mailchimp?.unconsented === "transactional" ? "transactional" : "skip", names: parseNames("mailchimp", o.mailchimp?.names) },
		forms,
	};
}

export async function readCrmSettings(env: CrmEnv): Promise<CrmSettings> {
	const raw = await env.FORM_OUTBOX?.get(SETTINGS_KEY).catch(() => null);
	if (!raw) return defaultCrm(env);
	try {
		return parseCrmSettings(JSON.parse(raw));
	} catch {
		return defaultCrm(env);
	}
}

export async function writeCrmSettings(env: CrmEnv, s: CrmSettings): Promise<void> {
	await env.FORM_OUTBOX?.put(SETTINGS_KEY, JSON.stringify(parseCrmSettings(s)));
}

/** A form as the CRM settings see it: id, title, whether it is sensitive and its fields (name, label, type, autocomplete). */
export interface CrmForm {
	id: string;
	title?: string;
	sensitive?: boolean;
	fields: { name: string; label?: string; type: string; autocomplete?: string }[];
}

/** The field types each target accepts. */
const TYPES: Record<Target, readonly string[]> = {
	email: ["email"],
	consent: ["checkbox", "consent"],
	phone: ["tel", "text"],
	message: ["textarea", "text"],
	firstName: ["text"],
	lastName: ["text"],
	fullName: ["text"],
	company: ["text", "select", "radio"],
};
export const fieldFits = (t: Target, f: { type: string; options?: unknown[] }) => TYPES[t].includes(f.type) && !(t === "consent" && f.type === "checkbox" && Array.isArray(f.options) && f.options.length > 1);

const words = (f: { name: string; label?: string; autocomplete?: string }) => `${f.name} ${f.label ?? ""}`.toLowerCase();
const CONSENT_WORDS = /newsletter|subscribe|marketing|opt.?in|mailing.?list|e-?mail updates|news and|offers|promotion/;

/** A sensible mapping from the form's field names, labels and autocomplete hints. Terms checkboxes are never opt-ins. */
export function autoMap(form: Pick<CrmForm, "fields">): Partial<Record<Target, string>> {
	const fields = form.fields;
	const map: Partial<Record<Target, string>> = {};
	const pick = (t: Target, test: (f: CrmForm["fields"][number]) => boolean) => {
		const used = new Set(Object.values(map));
		const f = fields.find((x) => fieldFits(t, x) && !used.has(x.name) && test(x));
		if (f) map[t] = f.name;
	};
	pick("email", () => true);
	pick("firstName", (f) => f.autocomplete === "given-name" || /first.?name|fname|given|vorname|prénom|prenom/.test(words(f)));
	pick("lastName", (f) => f.autocomplete === "family-name" || /last.?name|lname|surname|family|nachname/.test(words(f)));
	if (!map.firstName && !map.lastName) pick("fullName", (f) => f.autocomplete === "name" || /(^|[\s_-])(full.?)?name($|[\s_-])|your.?name/.test(words(f)));
	pick("phone", (f) => f.type === "tel" || /phone|mobile|tel\b|cell/.test(words(f)));
	pick("company", (f) => f.autocomplete === "organization" || /company|organi[sz]ation|business|firm/.test(words(f)));
	pick("message", (f) => f.type === "textarea");
	pick("consent", (f) => CONSENT_WORDS.test(words(f)));
	return map;
}

/** The setting a form uses: its saved entry, else the pre-selected providers with the auto-mapping. */
export function formSetting(s: CrmSettings, env: CrmEnv, form: CrmForm): CrmFormSetting {
	return s.forms[form.id] ?? { providers: preselected(env), map: autoMap(form) };
}

/** A provider is ready to receive: on, with its secret, and (Mailchimp) an audience. */
export const providerReady = (s: CrmSettings, env: CrmEnv, p: Provider) => s[p].on && crmSecretSet(env, p) && (p !== "mailchimp" || !!s.mailchimp.audienceId);

/** Why CRM sync cannot be used for a form (or the site), if it cannot. */
export function unavailable(env: CrmEnv, form?: { sensitive?: boolean }): string | undefined {
	if (!crmEnabled(env)) return "CRM sync is turned off for this site in its configuration.";
	if (crmSiteSensitive(env)) return "This site handles sensitive information (health, legal or financial), so form messages are never sent to a CRM or mailing list.";
	if (form?.sensitive) return "This form handles sensitive information, so its messages are never sent to a CRM or mailing list.";
	return undefined;
}

/**
 * The admin's Settings form → settings. A provider whose secret is missing cannot be turned on; a sensitive site or
 * form cannot use any; Mailchimp needs an audience; every form sending somewhere needs its email field mapped.
 */
export function crmSettingsFromForm(v: Record<string, unknown>, o: { env: CrmEnv; forms: CrmForm[]; current?: CrmSettings }): { settings: CrmSettings; errors: string[] } {
	const errors: string[] = [];
	const base = o.current ?? defaultCrm(o.env);
	if (unavailable(o.env)) {
		if (PROVIDERS.some((p) => v[`crm_${p}_on`] === true)) errors.push(unavailable(o.env) as string);
		return { settings: { ...parseCrmSettings({}), forms: {} }, errors };
	}
	const str = (k: string) => (typeof v[k] === "string" ? (v[k] as string).trim() : undefined);
	const names = (p: Provider) => {
		const out = { ...base[p].names };
		for (const n of NAMED_FIELDS) {
			const val = str(`crm_${p}_name_${n}`);
			if (val === undefined) continue;
			if (val && !NAME_RULE[p].test(val)) errors.push(`${PROVIDER_NAME[p]} ${TARGET_LABEL[n].toLowerCase()}: "${val.slice(0, 40)}" is not ${NAME_HINT[p]}.`);
			else out[n] = val;
		}
		return out;
	};
	const on = (p: Provider) => (v[`crm_${p}_on`] === undefined ? base[p].on : v[`crm_${p}_on`] === true) && crmSecretSet(o.env, p);
	const listRaw = str("crm_brevo_list");
	const list = listRaw ? Number(listRaw) : undefined;
	if (listRaw && !(Number.isInteger(list) && (list as number) > 0)) errors.push("The Brevo list id is a whole number (Contacts → Lists, the # column).");
	const audience = str("crm_mailchimp_audience") ?? base.mailchimp.audienceId ?? "";
	if (audience && !AUDIENCE.test(audience)) errors.push("The Mailchimp audience id is 6 to 20 lower-case letters and digits (Audience → Settings → Audience name and defaults).");
	if (on("mailchimp") && !AUDIENCE.test(audience)) errors.push("Mailchimp needs an audience id before it can be turned on.");
	const consentProp = str("crm_hubspot_consent") ?? base.hubspot.consentProperty ?? "";
	if (consentProp && !NAME_RULE.hubspot.test(consentProp)) errors.push(`HubSpot opt-in property: "${consentProp.slice(0, 40)}" is not ${NAME_HINT.hubspot}.`);
	const settings: CrmSettings = parseCrmSettings({
		brevo: { on: on("brevo"), ...(listRaw === undefined ? (base.brevo.listId ? { listId: base.brevo.listId } : {}) : list ? { listId: list } : {}), names: names("brevo") },
		hubspot: { on: on("hubspot"), names: names("hubspot"), ...(consentProp && NAME_RULE.hubspot.test(consentProp) ? { consentProperty: consentProp } : {}) },
		mailchimp: { on: on("mailchimp") && AUDIENCE.test(audience), ...(AUDIENCE.test(audience) ? { audienceId: audience } : {}), doubleOptIn: v.crm_mailchimp_double === undefined ? base.mailchimp.doubleOptIn : v.crm_mailchimp_double === true, unconsented: (v.crm_mailchimp_unconsented ?? base.mailchimp.unconsented) === "transactional" ? "transactional" : "skip", names: names("mailchimp") },
		forms: {},
	});
	const forms: Record<string, CrmFormSetting> = { ...base.forms };
	for (const form of o.forms) {
		if (!FORM_ID.test(form.id)) continue;
		const prefix = `crm_form_${form.id}_`;
		const touched = Object.keys(v).some((k) => k.startsWith(prefix));
		if (form.sensitive) {
			// Server-side refusal: a sensitive form never sends, whatever the request says.
			const asked = Array.isArray(v[`${prefix}providers`]) && (v[`${prefix}providers`] as unknown[]).length > 0;
			if (asked) errors.push(`${form.title ?? form.id}: ${unavailable(o.env, form)}`);
			forms[form.id] = { providers: [], map: {} };
			continue;
		}
		if (!touched) continue;
		const picked = (Array.isArray(v[`${prefix}providers`]) ? (v[`${prefix}providers`] as unknown[]) : []).filter((p): p is Provider => (PROVIDERS as readonly unknown[]).includes(p) && settings[p as Provider].on);
		const map: Partial<Record<Target, string>> = {};
		for (const t of TARGETS) {
			const name = str(`${prefix}${t}`);
			if (!name) continue;
			const field = form.fields.find((f) => f.name === name);
			if (!field || !fieldFits(t, field)) errors.push(`${form.title ?? form.id}: the field "${name.slice(0, 40)}" cannot be sent as ${TARGET_LABEL[t].toLowerCase()}.`);
			else map[t] = name;
		}
		if (picked.length && !map.email) errors.push(`${form.title ?? form.id}: choose the email field — every provider needs an email address.`);
		forms[form.id] = { providers: picked, map };
	}
	settings.forms = parseCrmSettings({ forms }).forms;
	return { settings, errors };
}

// ── The contact ───────────────────────────────────────────────────────────────────────────────────────────────────

/** What is sent: the mapped fields only. `consent` is undefined when the form maps no opt-in checkbox. */
export interface Contact {
	email: string;
	firstName?: string;
	lastName?: string;
	phone?: string;
	company?: string;
	message?: string;
	consent?: boolean;
}

/** The mapped values of one submission. Undefined without a valid email (nothing to identify the contact by). */
export function buildContact(map: Partial<Record<Target, string>>, values: { field: { name: string; type: string }; value: string }[]): Contact | undefined {
	const get = (t: Target) => (map[t] ? values.find((x) => x.field.name === map[t])?.value : undefined);
	const email = clean(get("email") ?? "", 254);
	if (!EMAIL.test(email)) return undefined;
	const c: Contact = { email };
	let first = get("firstName") ? clean(get("firstName") as string, 100) : "";
	let last = get("lastName") ? clean(get("lastName") as string, 100) : "";
	const full = get("fullName") ? clean(get("fullName") as string, 200) : "";
	if (full && !first && !last) {
		const [a, ...rest] = full.split(" ");
		first = clean(a ?? "", 100);
		last = clean(rest.join(" "), 100);
	}
	if (first) c.firstName = first;
	if (last) c.lastName = last;
	const phone = get("phone") ? clean(get("phone") as string, 40) : "";
	if (phone) c.phone = phone;
	const company = get("company") ? clean(get("company") as string, 200) : "";
	if (company) c.company = company;
	const message = get("message") ? clean(get("message") as string, 2000, { lines: true }) : "";
	if (message) c.message = message;
	// Only visible, filled values reach `values`: a ticked checkbox is present ("Yes"/"Accepted: …"), an unticked one absent.
	if (map.consent) c.consent = !!get("consent");
	return c;
}

/** E.164-ish phone for Brevo's SMS attribute (it refuses numbers without a country code). */
export function e164(phone: string): string | undefined {
	const t = phone.replace(/[\s().-]/g, "");
	const n = t.startsWith("00") ? `+${t.slice(2)}` : t;
	return /^\+[1-9]\d{6,14}$/.test(n) ? n : undefined;
}

const named = (names: Record<NamedField, string>, c: Contact, o: { brevoSms?: boolean } = {}): Record<string, string> => {
	const out: Record<string, string> = {};
	for (const n of NAMED_FIELDS) {
		const key = names[n];
		let val = c[n];
		if (!key || !val) continue;
		if (o.brevoSms && n === "phone" && key.toUpperCase() === "SMS") val = e164(val);
		if (val) out[key] = val;
	}
	return out;
};

// ── Requests (pure: tested without network) ───────────────────────────────────────────────────────────────────────

export interface CrmRequest {
	url: string;
	method: "POST" | "PUT" | "PATCH";
	headers: Record<string, string>;
	body: Record<string, unknown>;
}

/** Brevo: create or update the contact (updateEnabled); the list only with a ticked opt-in. */
export function brevoRequest(c: Contact, s: CrmSettings, key: string): CrmRequest {
	const attributes = named(s.brevo.names, c, { brevoSms: true });
	const listIds = c.consent === true && s.brevo.listId ? [s.brevo.listId] : undefined;
	return { url: "https://api.brevo.com/v3/contacts", method: "POST", headers: { "api-key": key, accept: "application/json", "content-type": "application/json" }, body: { email: c.email, updateEnabled: true, ...(Object.keys(attributes).length ? { attributes } : {}), ...(listIds ? { listIds } : {}) } };
}

const hubspotProps = (c: Contact, s: CrmSettings): Record<string, string> => ({ email: c.email, ...named(s.hubspot.names, c), ...(c.consent === true && s.hubspot.consentProperty ? { [s.hubspot.consentProperty]: "true" } : {}) });

/** HubSpot: create the contact (409 when it exists → `hubspotUpdate`). */
export function hubspotCreate(c: Contact, s: CrmSettings, token: string): CrmRequest {
	return { url: "https://api.hubapi.com/crm/v3/objects/contacts", method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: { properties: hubspotProps(c, s) } };
}

/** HubSpot: update the existing contact by email (idProperty=email). */
export function hubspotUpdate(c: Contact, s: CrmSettings, token: string): CrmRequest {
	const { email: _e, ...properties } = hubspotProps(c, s);
	return { url: `https://api.hubapi.com/crm/v3/objects/contacts/${encodeURIComponent(c.email)}?idProperty=email`, method: "PATCH", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: { properties } };
}

/** MD5 of the lower-case email (Mailchimp's subscriber hash). Small, dependency-free: Web Crypto has no MD5. */
export function md5(input: string): string {
	const bytes = new TextEncoder().encode(input);
	const len = bytes.length;
	const words = new Uint32Array((((len + 8) >> 6) + 1) * 16);
	for (let i = 0; i < len; i++) (words[i >> 2] as number) |= (bytes[i] as number) << ((i % 4) * 8);
	(words[len >> 2] as number) |= 0x80 << ((len % 4) * 8);
	words[words.length - 2] = (len * 8) >>> 0;
	words[words.length - 1] = Math.floor((len * 8) / 2 ** 32);
	const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
	const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
	let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476];
	for (let o = 0; o < words.length; o += 16) {
		let [a, b, c, d] = [a0, b0, c0, d0];
		for (let i = 0; i < 64; i++) {
			const r = i >> 4;
			let f: number;
			let g: number;
			if (r === 0) [f, g] = [(b & c) | (~b & d), i];
			else if (r === 1) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
			else if (r === 2) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
			else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
			const tmp = d;
			d = c;
			c = b;
			const sum = (a + f + (K[i] as number) + (words[o + g] as number)) >>> 0;
			const s = S[r * 4 + (i % 4)] as number;
			b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
			a = tmp;
		}
		a0 = (a0 + a) >>> 0;
		b0 = (b0 + b) >>> 0;
		c0 = (c0 + c) >>> 0;
		d0 = (d0 + d) >>> 0;
	}
	return [a0, b0, c0, d0].map((n) => [0, 8, 16, 24].map((sh) => ((n >>> sh) & 0xff).toString(16).padStart(2, "0")).join("")).join("");
}

/**
 * Mailchimp: add or update the audience member (PUT by subscriber hash). Ticked opt-in: `subscribed` (or `pending` with
 * double opt-in) for a new member, and an existing one is (re)subscribed. No tick / no opt-in field: undefined (skip),
 * or with "transactional" a new member is `transactional` and an existing member keeps its status.
 */
export function mailchimpRequest(c: Contact, s: CrmSettings, key: string, server: string): CrmRequest | undefined {
	const audience = s.mailchimp.audienceId;
	if (!audience) return undefined;
	const merge_fields = named(s.mailchimp.names, c);
	const opted = c.consent === true;
	if (!opted && s.mailchimp.unconsented === "skip") return undefined;
	const status = opted ? (s.mailchimp.doubleOptIn ? "pending" : "subscribed") : "transactional";
	return {
		url: `https://${server}.api.mailchimp.com/3.0/lists/${audience}/members/${md5(c.email.toLowerCase())}`,
		method: "PUT",
		headers: { authorization: `Basic ${btoa(`wp2emdash:${key}`)}`, "content-type": "application/json" },
		body: { email_address: c.email, status_if_new: status, ...(opted ? { status } : {}), ...(Object.keys(merge_fields).length ? { merge_fields } : {}) },
	};
}

// ── Sending ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const TIMEOUT_MS = 8000;

export type SendResult = { ok: true; skipped?: boolean } | { ok: false; retry: boolean; status: number; error: string };

/** Remove the contact's details, any email address and long digit runs from a provider's error text. */
export function scrub(text: string, c?: Partial<Contact>): string {
	let t = clean(text, 600);
	// Whole values, plus each word of a name or company (a provider may echo "Sam" from "Sam Visitor").
	const parts = new Set<string>();
	for (const [k, v] of Object.entries(c ?? {})) {
		if (typeof v !== "string" || v.length < 2) continue;
		parts.add(v);
		if (k === "firstName" || k === "lastName" || k === "company") for (const w of v.split(/\s+/)) if (w.length >= 3) parts.add(w);
	}
	for (const part of [...parts].sort((a, b) => b.length - a.length)) t = t.split(part).join("[…]").split(part.toLowerCase()).join("[…]");
	t = t.replace(/[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+/g, "[email]").replace(/\+?\d[\d\s().-]{5,}\d/g, "[number]");
	return clean(t, 300);
}

/** The provider's own words about a failure: Brevo {code,message}, HubSpot {category,message}, Mailchimp {title,detail}. */
async function errorText(res: Response): Promise<string> {
	const raw = await res.text().catch(() => "");
	try {
		const j = JSON.parse(raw) as Record<string, unknown>;
		const parts = [j.code ?? j.category ?? j.title, j.message ?? j.detail].filter((x) => typeof x === "string" && x);
		if (parts.length) return parts.join(": ");
	} catch {}
	return raw.slice(0, 200) || res.statusText || "error";
}

const retryable = (status: number) => status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;

async function call(req: CrmRequest, f: Fetch): Promise<Response | { status: 0; error: string }> {
	try {
		const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
		return await f(req.url, { method: req.method, headers: req.headers, body: JSON.stringify(req.body), redirect: "manual", ...(signal ? { signal } : {}) });
	} catch (err) {
		return { status: 0, error: (err as Error)?.name === "TimeoutError" ? "timed out" : "network error" };
	}
}

async function outcome(r: Response | { status: 0; error: string }, c: Contact): Promise<SendResult> {
	if (!(r instanceof Response)) return { ok: false, retry: true, status: 0, error: r.error };
	if (r.ok) {
		await r.body?.cancel().catch(() => {});
		return { ok: true };
	}
	return { ok: false, retry: retryable(r.status), status: r.status, error: scrub(await errorText(r), c) };
}

/** Send one contact to one provider. Never throws, never logs the key or the contact. */
export async function sendToProvider(env: CrmEnv, s: CrmSettings, p: Provider, c: Contact, f: Fetch = (u, i) => fetch(u, i)): Promise<SendResult> {
	if (!crmSecretSet(env, p)) return { ok: false, retry: false, status: 0, error: `${PROVIDER_SECRET[p]} is not set` };
	const key = keyOf(env, p);
	if (p === "brevo") return outcome(await call(brevoRequest(c, s, key), f), c);
	if (p === "hubspot") {
		const r = await call(hubspotCreate(c, s, key), f);
		if (r instanceof Response && r.status === 409) {
			await r.body?.cancel().catch(() => {});
			return outcome(await call(hubspotUpdate(c, s, key), f), c);
		}
		return outcome(r, c);
	}
	const server = mailchimpServer(env);
	if (!server) return { ok: false, retry: false, status: 0, error: "the Mailchimp server prefix is unknown (set MAILCHIMP_SERVER_PREFIX)" };
	const req = mailchimpRequest(c, s, key, server);
	if (!req) return { ok: true, skipped: true };
	return outcome(await call(req, f), c);
}

interface Job {
	form: string;
	contact: Contact;
	providers: Provider[];
	attempts: number;
	/** Not before (ISO). */
	next: string;
}

export interface LastError {
	at: string;
	form: string;
	status: number;
	text: string;
}

async function recordFailure(kv: KvLike, p: Provider, form: string, r: { status: number; error: string }, now = Date.now()): Promise<void> {
	const key = `${FAIL}${new Date(now).toISOString().slice(0, 10)}:${p}`;
	const n = Number(await kv.get(key)) || 0;
	await kv.put(key, String(n + 1), { expirationTtl: 30 * DAY });
	const last: LastError = { at: new Date(now).toISOString(), form, status: r.status, text: r.error };
	await kv.put(`${LAST_ERROR}${p}`, JSON.stringify(last), { expirationTtl: 30 * DAY });
}

/** Jobs live at most two days (and never past the outbox's retention period). */
const jobTtl = (env: CrmEnv) => Math.min(2, retentionDays(env)) * DAY;

async function keepForRetry(env: CrmEnv, kv: KvLike, job: Omit<Job, "next">, now = Date.now()): Promise<void> {
	const wait = BACKOFF_MINUTES[Math.min(job.attempts, BACKOFF_MINUTES.length) - 1] ?? 5;
	const at = new Date(now).toISOString();
	await kv.put(`${JOB}${at}:${crypto.randomUUID().slice(0, 8)}`, JSON.stringify({ ...job, next: new Date(now + wait * 60_000).toISOString() } satisfies Job), { expirationTtl: jobTtl(env) });
}

/** Send to each provider; failures that may pass are retried, the others recorded. */
async function sendAll(env: CrmEnv, kv: KvLike, s: CrmSettings, job: Omit<Job, "next">, f?: Fetch, now = Date.now()): Promise<{ sent: Provider[]; retry: Provider[]; failed: Provider[] }> {
	const results = await Promise.all(job.providers.map(async (p) => [p, await sendToProvider(env, s, p, job.contact, f)] as const));
	const sent: Provider[] = [];
	const retry: Provider[] = [];
	const failed: Provider[] = [];
	for (const [p, r] of results) {
		if (r.ok) sent.push(p);
		else if (r.retry && job.attempts < MAX_ATTEMPTS) retry.push(p);
		else {
			failed.push(p);
			await recordFailure(kv, p, job.form, r, now).catch(() => {});
		}
	}
	if (retry.length) await keepForRetry(env, kv, { ...job, providers: retry }, now).catch(() => {});
	return { sent, retry, failed };
}

export interface NewLead {
	form: CrmForm;
	values: { field: { name: string; type: string }; value: string }[];
	/** A test message (FORM_LIVE_HOST): never synced. */
	test?: boolean;
}

/** The providers a new message from `form` goes to, and why none when none (for tests and the admin). */
export function providersFor(s: CrmSettings, env: CrmEnv, form: CrmForm): Provider[] {
	if (unavailable(env, form) || !env.FORM_OUTBOX || env.STAGING === "1") return [];
	return formSetting(s, env, form).providers.filter((p) => providerReady(s, env, p));
}

/**
 * Send a new form message's mapped fields to the providers picked for its form. Meant for waitUntil: never throws, and
 * the caller has already answered the visitor. Refuses on sensitive sites and forms, test messages and staging.
 */
export async function syncCrm(env: CrmEnv, m: NewLead, f?: Fetch): Promise<{ sent: Provider[]; retry: Provider[]; failed: Provider[] }> {
	const none = { sent: [], retry: [], failed: [] };
	try {
		if (m.test || unavailable(env, m.form) || !env.FORM_OUTBOX) return none;
		const s = await readCrmSettings(env);
		const providers = providersFor(s, env, m.form);
		if (!providers.length) return none;
		const contact = buildContact(formSetting(s, env, m.form).map, m.values);
		if (!contact) return none;
		const r = await sendAll(env, env.FORM_OUTBOX, s, { form: m.form.id, contact, providers, attempts: 1 }, f);
		console.log(JSON.stringify({ form: m.form.id, crm: { sent: r.sent, ...(r.retry.length ? { retry: r.retry } : {}), ...(r.failed.length ? { failed: r.failed } : {}) } }));
		return r;
	} catch {
		return none;
	}
}

/**
 * Cron: retry the contacts whose time has come. A provider turned off, unpicked for the form or without its secret since
 * is dropped, as is everything on a site that became sensitive. Counts only in the log.
 */
export async function flushCrm(env: CrmEnv, f?: Fetch, now = Date.now()): Promise<{ sent: number; retry: number; failed: number; dropped: number; waiting: number }> {
	const out = { sent: 0, retry: 0, failed: 0, dropped: 0, waiting: 0 };
	const kv = env.FORM_OUTBOX;
	if (!kv) return out;
	const keys = await jobKeys(kv);
	if (!keys.length) return out;
	const s = await readCrmSettings(env);
	for (const key of keys) {
		const raw = await kv.get(key);
		if (!raw) continue;
		let job: Job;
		try {
			job = JSON.parse(raw) as Job;
		} catch {
			await kv.delete(key);
			continue;
		}
		const due = Date.parse(job.next ?? "");
		if (!unavailable(env) && !Number.isNaN(due) && due > now) {
			out.waiting++;
			continue;
		}
		await kv.delete(key);
		const entry = s.forms[job.form];
		const picked = entry ? entry.providers : preselected(env);
		const live = unavailable(env) || env.STAGING === "1" ? [] : (job.providers ?? []).filter((p) => picked.includes(p) && providerReady(s, env, p));
		out.dropped += (job.providers ?? []).length - live.length;
		if (!live.length || !job.contact) continue;
		const r = await sendAll(env, kv, s, { form: job.form, contact: job.contact, providers: live, attempts: (job.attempts ?? 1) + 1 }, f, now);
		out.sent += r.sent.length;
		out.retry += r.retry.length;
		out.failed += r.failed.length;
	}
	if (out.sent || out.retry || out.failed || out.dropped) console.log(JSON.stringify({ crm: { sent: out.sent, retry: out.retry, failed: out.failed, ...(out.dropped ? { dropped: out.dropped } : {}) } }));
	return out;
}

async function jobKeys(kv: KvLike): Promise<string[]> {
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: JOB, limit: 1000, ...(cursor ? { cursor } : {}) });
		keys.push(...page.keys.map((k) => k.name).filter((k) => JOB_KEY.test(k)));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return keys;
}

/** For Settings: failures per provider since `sinceDay`, each provider's last error (scrubbed), contacts waiting for a retry. */
export async function readCrmStatus(env: CrmEnv, sinceDay: string): Promise<{ failures: Record<Provider, number>; lastErrors: Partial<Record<Provider, LastError>>; pending: number }> {
	const failures: Record<Provider, number> = { brevo: 0, hubspot: 0, mailchimp: 0 };
	const lastErrors: Partial<Record<Provider, LastError>> = {};
	const kv = env.FORM_OUTBOX;
	if (!kv) return { failures, lastErrors, pending: 0 };
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: FAIL, limit: 1000, ...(cursor ? { cursor } : {}) });
		for (const { name } of page.keys) {
			const m = /^crmfail:(\d{4}-\d{2}-\d{2}):(brevo|hubspot|mailchimp)$/.exec(name);
			if (!m || (m[1] as string) < sinceDay) continue;
			failures[m[2] as Provider] += Number(await kv.get(name)) || 0;
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	for (const p of PROVIDERS) {
		const raw = await kv.get(`${LAST_ERROR}${p}`).catch(() => null);
		if (!raw) continue;
		try {
			const e = JSON.parse(raw) as LastError;
			if (typeof e.at === "string" && typeof e.text === "string") lastErrors[p] = { at: e.at, form: String(e.form ?? ""), status: Number(e.status) || 0, text: clean(e.text, 300) };
		} catch {}
	}
	return { failures, lastErrors, pending: (await jobKeys(kv)).length };
}

/** An admin cleared a provider's last error (after fixing it). */
export async function clearCrmError(env: CrmEnv, p: Provider): Promise<void> {
	await env.FORM_OUTBOX?.delete(`${LAST_ERROR}${p}`);
}
