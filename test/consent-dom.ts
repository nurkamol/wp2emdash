/**
 * A very small DOM for running the starter's browser scripts (site-consent.js, site-analytics.js, site-widgets.js)
 * in node:vm: elements with attributes, children, events and the few queries those scripts use. Not a browser —
 * the real-browser check is src/verify/consent.ts (Playwright).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

export class FakeEl {
	tagName: string;
	attrs: Record<string, string> = {};
	children: FakeEl[] = [];
	parentNode: FakeEl | null = null;
	textContent = "";
	hidden = false;
	checked = false;
	disabled = false;
	src = "";
	async = false;
	listeners: Record<string, ((e: unknown) => void)[]> = {};
	focused = false;
	constructor(tag: string, private doc: FakeDoc) {
		this.tagName = tag.toUpperCase();
	}
	setAttribute(k: string, v: string) {
		this.attrs[k] = String(v);
		if (k === "hidden") this.hidden = true;
	}
	getAttribute(k: string) {
		return this.attrs[k] ?? null;
	}
	appendChild(c: FakeEl) {
		c.parentNode = this;
		this.children.push(c);
		this.doc.added.push(c);
		return c;
	}
	insertBefore(c: FakeEl, ref: FakeEl | null) {
		c.parentNode = this;
		const i = ref ? this.children.indexOf(ref) : -1;
		if (i < 0) this.children.push(c);
		else this.children.splice(i, 0, c);
		this.doc.added.push(c);
		return c;
	}
	get firstChild(): FakeEl | null {
		return this.children[0] ?? null;
	}
	get nextSibling(): FakeEl | null {
		const p = this.parentNode;
		return p ? (p.children[p.children.indexOf(this) + 1] ?? null) : null;
	}
	addEventListener(t: string, f: (e: unknown) => void) {
		(this.listeners[t] ??= []).push(f);
	}
	click() {
		for (const f of this.listeners.click ?? []) f({ target: this, preventDefault() {} });
		this.doc.dispatchEvent({ type: "click", target: this, preventDefault() {} });
	}
	keydown(key: string) {
		for (const f of this.listeners.keydown ?? []) f({ key });
	}
	focus() {
		this.doc.activeElement = this;
	}
	contains(e: unknown): boolean {
		return e === this || this.children.some((c) => c.contains(e));
	}
	all(): FakeEl[] {
		return [this, ...this.children.flatMap((c) => c.all())];
	}
	matches(sel: string): boolean {
		if (sel === "input:not([disabled])") return this.tagName === "INPUT" && !this.disabled;
		const attr = /^\[([\w-]+)\]$/.exec(sel);
		if (attr) return (attr[1] ?? "") in this.attrs;
		if (sel.startsWith(".")) return (this.attrs.class ?? "").split(/\s+/).includes(sel.slice(1));
		if (sel === "footer.site-footer") return this.tagName === "FOOTER" && (this.attrs.class ?? "").includes("site-footer");
		return this.tagName === sel.toUpperCase();
	}
	querySelector(sel: string): FakeEl | null {
		return this.all().slice(1).find((e) => e.matches(sel)) ?? null;
	}
	querySelectorAll(sel: string): FakeEl[] {
		return this.all().slice(1).filter((e) => e.matches(sel));
	}
	closest(sel: string): FakeEl | null {
		let e: FakeEl | null = this;
		while (e) {
			if (e.matches(sel)) return e;
			e = e.parentNode;
		}
		return null;
	}
	text(): string {
		return [this.textContent, ...this.children.map((c) => c.text())].join("");
	}
}

export class FakeDoc {
	added: FakeEl[] = [];
	cookie = "";
	activeElement: unknown = null;
	listeners: Record<string, ((e: unknown) => void)[]> = {};
	metas: Record<string, string> = {};
	head = new FakeEl("head", this);
	body = new FakeEl("body", this);
	classes = new Set<string>();
	documentElement = { classList: { add: (c: string) => this.classes.add(c), remove: (c: string) => this.classes.delete(c) } };
	constructor() {
		const skip = new FakeEl("a", this);
		skip.setAttribute("class", "skip-link");
		this.body.appendChild(skip);
		const main = new FakeEl("main", this);
		main.setAttribute("id", "main");
		this.body.appendChild(main);
		const footer = new FakeEl("footer", this);
		footer.setAttribute("class", "site-footer");
		this.body.appendChild(footer);
		this.added = [];
	}
	createElement(tag: string) {
		return new FakeEl(tag, this);
	}
	createTextNode(t: string) {
		const e = new FakeEl("#text", this);
		e.textContent = t;
		return e;
	}
	querySelector(sel: string): FakeEl | { content: string } | null {
		const m = /^meta\[name="([\w-]+)"\]$/.exec(sel);
		if (m) return m[1] && this.metas[m[1]] !== undefined ? { content: this.metas[m[1]] as string } : null;
		return this.body.querySelector(sel);
	}
	getElementById(id: string) {
		return this.body.all().find((e) => e.attrs.id === id) ?? null;
	}
	addEventListener(t: string, f: (e: unknown) => void) {
		(this.listeners[t] ??= []).push(f);
	}
	removeEventListener(t: string, f: (e: unknown) => void) {
		this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f);
	}
	dispatchEvent(e: { type: string; [k: string]: unknown }) {
		for (const f of [...(this.listeners[e.type] ?? [])]) f(e);
		return true;
	}
	/** The consent banner, when built. */
	banner(): FakeEl | undefined {
		return this.body.all().find((e) => "data-consent-banner" in e.attrs);
	}
	find(attr: string): FakeEl | undefined {
		return this.body.all().find((e) => attr in e.attrs);
	}
}

const ROOT = new URL("..", import.meta.url).pathname;
export const starterScript = (name: string) => readFileSync(join(ROOT, "starter", "public", "scripts", name), "utf8");

export interface Browser {
	doc: FakeDoc;
	window: Record<string, any>;
	storage: Map<string, string>;
	session: Map<string, string>;
	fetches: { url: string; init?: Record<string, unknown> }[];
	reloads: number;
	run(script: string): void;
	flush(): Promise<void>;
}

/** One page load: a document with the given metas, storage carried over between loads via `storage`. */
export function page(o: { consent?: unknown; analytics?: unknown; widgets?: unknown; gpc?: boolean; search?: string; storage?: Map<string, string>; session?: Map<string, string>; cookie?: string; region?: { strict: boolean } | "fail" }): Browser {
	const doc = new FakeDoc();
	if (o.consent !== undefined) doc.metas["site-consent"] = typeof o.consent === "string" ? o.consent : JSON.stringify(o.consent);
	if (o.analytics !== undefined) doc.metas["site-analytics"] = JSON.stringify(o.analytics);
	if (o.widgets !== undefined) doc.metas["site-widgets"] = JSON.stringify(o.widgets);
	doc.cookie = o.cookie ?? "";
	const storage = o.storage ?? new Map<string, string>();
	const session = o.session ?? new Map<string, string>();
	const fetches: Browser["fetches"] = [];
	const pending: Promise<unknown>[] = [];
	const b: Browser = {
		doc,
		window: {},
		storage,
		session,
		fetches,
		reloads: 0,
		run: (script) => runInNewContext(script, ctx),
		flush: async () => {
			for (let i = 0; i < 5; i++) await Promise.all(pending.splice(0));
			await new Promise((r) => setTimeout(r, 0));
		},
	};
	const store = (m: Map<string, string>) => ({ getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k) });
	// document.cookie: writes add/replace one cookie; reads give "a=1; b=2".
	const jar = new Map<string, string>(doc.cookie ? doc.cookie.split(/;\s*/).map((p) => [p.split("=")[0] as string, p.slice(p.indexOf("=") + 1)]) : []);
	Object.defineProperty(doc, "cookie", {
		get: () => [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
		set: (v: string) => {
			const [pair] = v.split(";");
			const name = (pair ?? "").split("=")[0]?.trim() ?? "";
			if (/max-age=0/i.test(v)) jar.delete(name);
			else jar.set(name, (pair ?? "").slice((pair ?? "").indexOf("=") + 1));
		},
	});
	const fetchFn = (url: string, init?: Record<string, unknown>) => {
		fetches.push({ url, ...(init ? { init } : {}) });
		const p = url.includes("/_consent/region") && o.region !== "fail" ? Promise.resolve({ ok: true, json: () => Promise.resolve(o.region ?? { strict: true }) }) : url.includes("/_consent/region") ? Promise.reject(new Error("offline")) : Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
		pending.push(p.catch(() => {}));
		return p;
	};
	class CustomEvent {
		type: string;
		detail: unknown;
		constructor(type: string, init?: { detail?: unknown }) {
			this.type = type;
			this.detail = init?.detail;
		}
	}
	const ctx: Record<string, unknown> = {
		window: b.window,
		document: doc,
		navigator: { globalPrivacyControl: o.gpc === true },
		location: { search: o.search ?? "", protocol: "https:", hostname: "www.acme.example", reload: () => void b.reloads++ },
		localStorage: store(storage),
		sessionStorage: store(session),
		fetch: fetchFn,
		CustomEvent,
		setTimeout: (f: () => void) => f(),
		Date,
		JSON,
		encodeURIComponent,
		decodeURIComponent,
		Array,
		Object,
		String,
		Number,
		Set,
		Promise,
		Error,
		RegExp,
		Math,
	};
	b.window.document = doc;
	return b;
}
