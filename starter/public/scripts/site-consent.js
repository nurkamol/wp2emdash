// Consent banner (components/Consent.astro, Privacy & consent — @wp2emdash/consent): a real file, so the public
// Content-Security-Policy ('self') allows it without inline-script hashes. Reads its settings from
// <meta name="site-consent"> — the same for every visitor, because pages are cached for everyone — and keeps the
// visitor's choice only in this browser: localStorage "site-consent" and a first-party cookie "site_consent"
// (version, revision, three yes/no flags, time; no identifier), asked again after 180 days or when an admin asks
// everyone again. Every text is written with textContent; nothing from the settings is ever run.
//
// Runs before the analytics and widget loaders (deferred scripts run in document order), which read
// window.siteConsent.state() and listen for the "site-consent" event:
//   analytics   → Google Analytics / Tag Manager (analytics_storage), Clarity, Hotjar
//   marketing   → Google Ads (ad_storage, ad_user_data, ad_personalization), Meta Pixel
//   preferences → chat and review widgets
// Cloudflare Web Analytics is cookieless and always runs.
//
// Modes: "notice" (everything on until the visitor opts out), "opt-in" (nothing until the visitor agrees), "auto"
// (opt-in or notice by the visitor's region, asked from /_consent/region: uncached, no cookies; nothing loads while
// the answer is pending, unknown = opt-in). Global Privacy Control (navigator.globalPrivacyControl) keeps marketing off.
// "Cookie settings" in the footer (added here) or any [data-consent-open] element opens the choices again;
// ?consent-preview=1 shows the banner whatever was chosen (the admin's preview).
(() => {
	const meta = document.querySelector('meta[name="site-consent"]');
	let c = {};
	try {
		c = JSON.parse(meta ? meta.content : "{}") || {};
	} catch {}
	if (!c || typeof c !== "object" || !["notice", "opt-in", "auto"].includes(c.mode)) return;

	const KEY = "site-consent";
	const COOKIE = "site_consent";
	const REGION_KEY = "site-consent-region";
	const MAX_AGE = 180 * 86400;
	const OPTIONAL = ["analytics", "marketing", "preferences"];
	const LABELS = { necessary: "Necessary", analytics: "Analytics", marketing: "Marketing", preferences: "Preferences" };
	const rev = Number.isInteger(c.rev) && c.rev > 0 ? c.rev : 1;
	const cats = c.cats && typeof c.cats === "object" ? c.cats : {};
	const servicesOf = (k) => (cats[k] && Array.isArray(cats[k].s) ? cats[k].s.filter((x) => typeof x === "string").slice(0, 20) : []);
	const used = OPTIONAL.filter((k) => servicesOf(k).length > 0);
	const text = (k, d) => (c.text && typeof c.text[k] === "string" && c.text[k].trim() ? c.text[k].slice(0, 600) : d);
	const gpc = typeof navigator !== "undefined" && navigator.globalPrivacyControl === true;
	const preview = /[?&]consent-preview=1(?:&|$)/.test(location.search);
	const policy = typeof c.policy === "string" && /^\/(?!\/)[\w\-./~%]*$/.test(c.policy) ? c.policy : "";

	// ── The choice, kept in this browser only ──────────────────────────────────────────────────────────────
	const valid = (r) => {
		if (!r || r.v !== 1 || r.rev !== rev || typeof r.at !== "number") return undefined;
		const age = Date.now() - r.at;
		if (age > MAX_AGE * 1000 || age < -86400000) return undefined;
		return { analytics: r.a === true, marketing: r.m === true, preferences: r.p === true };
	};
	const readStored = () => {
		try {
			const s = localStorage.getItem(KEY);
			if (s) return valid(JSON.parse(s));
		} catch {}
		const m = /(?:^|;\s*)site_consent=([^;]+)/.exec(document.cookie || "");
		const p = m ? decodeURIComponent(m[1]).split(".") : [];
		if (p.length === 4 && p[0] === "1" && /^[01]{3}$/.test(p[2])) return valid({ v: 1, rev: Number(p[1]), a: p[2][0] === "1", m: p[2][1] === "1", p: p[2][2] === "1", at: parseInt(p[3], 36) });
		return undefined;
	};
	const writeStored = (s) => {
		const at = Date.now();
		try {
			localStorage.setItem(KEY, JSON.stringify({ v: 1, rev, a: s.analytics, m: s.marketing, p: s.preferences, at }));
		} catch {}
		const flags = `${s.analytics ? 1 : 0}${s.marketing ? 1 : 0}${s.preferences ? 1 : 0}`;
		document.cookie = `${COOKIE}=1.${rev}.${flags}.${at.toString(36)}; Path=/; Max-Age=${MAX_AGE}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
	};

	// ── The state machine (pure; window.siteConsent.decide) ────────────────────────────────────────────────
	// style: "strict" (opt-in), "notice", or "pending" (auto mode, region not known yet: nothing allowed, no banner).
	const decide = (mode, region, stored, gpcOn) => {
		const style = mode === "opt-in" ? "strict" : mode === "notice" ? "notice" : region === "strict" || region === "notice" ? region : "pending";
		if (stored) return { analytics: !!stored.analytics, marketing: !!stored.marketing && !gpcOn, preferences: !!stored.preferences, decided: true, style, show: false };
		if (style === "notice") return { analytics: true, marketing: !gpcOn, preferences: true, decided: false, style, show: true };
		return { analytics: false, marketing: false, preferences: false, decided: false, style, show: style === "strict" };
	};

	let region;
	if (c.mode === "auto") {
		try {
			const r = sessionStorage.getItem(REGION_KEY);
			if (r === "strict" || r === "notice") region = r;
		} catch {}
	}
	let stored = readStored();
	let state = decide(c.mode, region, stored, gpc);
	const pub = () => ({ analytics: state.analytics, marketing: state.marketing, preferences: state.preferences, decided: state.decided, style: state.style, gpc });
	const emit = () => {
		try {
			document.dispatchEvent(new CustomEvent("site-consent", { detail: pub() }));
		} catch {}
	};

	// ── Withdrawal: tracker cookies on this site's domains are removed, and the page reloads without them ─────
	const TRACKER_COOKIE = /^(?:_ga|_gid|_gat|_gcl_|_fbp|_fbc|_clck|_clsk|_hj|_uet)/;
	const clearCookies = () => {
		const parts = location.hostname.split(".");
		const domains = [""];
		for (let i = 0; i < parts.length - 1; i++) domains.push(`; Domain=.${parts.slice(i).join(".")}`);
		for (const pair of (document.cookie || "").split(";")) {
			const name = pair.split("=")[0].trim();
			if (TRACKER_COOKIE.test(name)) for (const d of domains) document.cookie = `${name}=; Path=/; Max-Age=0${d}`;
		}
	};

	const logChoice = (how) => {
		if (typeof c.log !== "string" || !/^\/_emdash\/api\/plugins\/[\w-]+\/log$/.test(c.log)) return;
		try {
			fetch(c.log, { method: "POST", credentials: "omit", keepalive: true, headers: { "content-type": "application/json", "X-EmDash-Request": "1" }, body: JSON.stringify({ choice: how }) }).catch(() => {});
		} catch {}
	};

	// ── The banner ────────────────────────────────────────────────────────────────────────────────────────
	let box;
	let panel;
	let title;
	let chooseBtn;
	let saveBtn;
	let reopened = false;
	let lastFocus;
	const el = (tag, attrs, kids) => {
		const e = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs || {})) {
			if (k === "text") e.textContent = v;
			else if (v === true) e.setAttribute(k, "");
			else if (v !== false && v !== undefined && v !== null) e.setAttribute(k, String(v));
		}
		for (const kid of kids || []) if (kid) e.appendChild(kid);
		return e;
	};
	const shownCats = () => ["necessary", ...OPTIONAL.filter((k) => used.includes(k) || (preview && !used.length))];
	const sync = () => {
		for (const k of OPTIONAL) {
			const i = document.getElementById(`consent-cat-${k}`);
			if (i) i.checked = k === "marketing" && gpc ? false : !!state[k];
		}
	};
	const togglePanel = (open) => {
		panel.hidden = !open;
		chooseBtn.setAttribute("aria-expanded", open ? "true" : "false");
		chooseBtn.hidden = open;
		saveBtn.hidden = !open;
	};
	const build = () => {
		title = el("h2", { id: "consent-title", class: "consent__title", tabindex: "-1", text: text("title", "Your privacy") });
		const body = el("p", { id: "consent-desc", class: "consent__text", text: `${text("body", "We use cookies and similar tools to run this site and, with your permission, to measure visits and for marketing.")} ` });
		if (policy) body.appendChild(el("a", { href: policy, text: "Privacy policy" }));
		const note = gpc ? el("p", { class: "consent__note", text: "Your browser sends a Global Privacy Control signal, so marketing stays off." }) : null;
		const list = el("fieldset", { class: "consent__choices" }, [el("legend", { class: "consent__legend", text: "Choose what to allow" })]);
		for (const k of shownCats()) {
			const id = `consent-cat-${k}`;
			const services = servicesOf(k);
			const d = cats[k] && typeof cats[k].d === "string" ? cats[k].d.slice(0, 300) : "";
			const input = el("input", { type: "checkbox", id, name: k, "aria-describedby": `${id}-desc` });
			if (k === "necessary" || (k === "marketing" && gpc)) input.disabled = true;
			input.checked = k === "necessary";
			list.appendChild(el("div", { class: "consent__cat" }, [input, el("label", { for: id, text: `${LABELS[k]}${k === "necessary" ? " (always on)" : ""}` }), el("p", { id: `${id}-desc`, class: "consent__desc", text: `${d}${services.length ? ` ${services.join(", ")}.` : ""}`.trim() })]));
		}
		panel = el("div", { class: "consent__panel", id: "consent-panel", hidden: true }, [list]);
		const btn = (key, label, cls) => el("button", { type: "button", class: `consent__btn ${cls}`, [`data-consent-${key}`]: true, text: label });
		const reject = btn("reject", text("reject", "Reject non-essential"), "consent__btn--solid");
		const accept = btn("accept", text("accept", "Accept all"), "consent__btn--solid");
		chooseBtn = btn("choose", text("choose", "Choose"), "consent__btn--ghost");
		chooseBtn.setAttribute("aria-expanded", "false");
		chooseBtn.setAttribute("aria-controls", "consent-panel");
		saveBtn = btn("save", text("save", "Save choices"), "consent__btn--ghost");
		saveBtn.hidden = true;
		box = el("div", { class: `consent consent--${c.position === "card" ? "card" : "bar"}`, role: "dialog", "aria-modal": "false", "aria-labelledby": "consent-title", "aria-describedby": "consent-desc", "data-consent-banner": true, hidden: true }, [el("div", { class: "consent__inner" }, [title, body, note, panel, el("div", { class: "consent__actions" }, [accept, reject, chooseBtn, saveBtn])])]);
		accept.addEventListener("click", () => choose({ analytics: true, marketing: true, preferences: true }, "accept"));
		reject.addEventListener("click", () => choose({ analytics: false, marketing: false, preferences: false }, "reject"));
		chooseBtn.addEventListener("click", () => {
			togglePanel(true);
			const first = panel.querySelector("input:not([disabled])");
			if (first) first.focus();
		});
		saveBtn.addEventListener("click", () => {
			const v = {};
			for (const k of OPTIONAL) {
				const i = document.getElementById(`consent-cat-${k}`);
				v[k] = !!(i && i.checked);
			}
			choose(v, "custom");
		});
		box.addEventListener("keydown", (e) => {
			if (e.key !== "Escape") return;
			// Escape never decides for the visitor: it folds the choices away, or closes a banner opened from the link.
			if (reopened) close();
			else if (!panel.hidden) {
				togglePanel(false);
				chooseBtn.focus();
			}
		});
		// First in the tab order (after "Skip to content"), so keyboard and screen-reader users reach it at once.
		const skip = document.querySelector(".skip-link");
		document.body.insertBefore(box, skip && skip.parentNode === document.body ? skip.nextSibling : document.body.firstChild);
	};
	const open = (fromUser) => {
		if (!box) build();
		sync();
		box.hidden = false;
		document.documentElement.classList.add("has-consent-banner");
		if (fromUser) {
			reopened = true;
			lastFocus = document.activeElement;
			togglePanel(true);
			title.focus();
		}
	};
	const close = () => {
		if (!box) return;
		const inside = box.contains(document.activeElement);
		box.hidden = true;
		document.documentElement.classList.remove("has-consent-banner");
		if (reopened && lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
		else if (inside) {
			const main = document.getElementById("main");
			if (main) main.focus({ preventScroll: true });
		}
		reopened = false;
	};
	const render = () => {
		if (state.show || preview) open(false);
		else close();
	};
	const choose = (next, how) => {
		const before = state;
		stored = { analytics: !!next.analytics, marketing: !!next.marketing && !gpc, preferences: !!next.preferences };
		writeStored(stored);
		state = decide(c.mode, region, stored, gpc);
		emit();
		logChoice(how);
		close();
		if (OPTIONAL.some((k) => before[k] && !state[k])) {
			// Google, Meta and Clarity are told through their consent APIs (the analytics loader). Hotjar and chat or
			// review widgets have none: if one already runs on this page, reload the page without it.
			clearCookies();
			const running = (before.analytics && !state.analytics && typeof window.hj === "function") || (before.preferences && !state.preferences && window.siteWidgetsStarted === true);
			if (running) setTimeout(() => location.reload(), 60);
		}
	};

	window.siteConsent = { state: pub, open: () => open(true), decide, version: 1 };

	if (state.style === "pending") {
		fetch(typeof c.region === "string" && /^\/[\w/-]+$/.test(c.region) ? c.region : "/_consent/region", { credentials: "omit", cache: "no-store", headers: { accept: "application/json" } })
			.then((r) => (r.ok ? r.json() : { strict: true }))
			.catch(() => ({ strict: true }))
			.then((j) => {
				region = j && j.strict === false ? "notice" : "strict";
				try {
					sessionStorage.setItem(REGION_KEY, region);
				} catch {}
				state = decide(c.mode, region, stored, gpc);
				emit();
				if (used.length || preview) render();
			});
	}

	if (!used.length && !preview) return;
	// "Cookie settings": the site's own [data-consent-open] link if it has one; else next to the footer's privacy policy
	// link, dressed like it (same classes, same inner <span>), so it joins the legal links row; else at the end of the footer.
	if (c.footer !== false && !document.querySelector("[data-consent-open]")) {
		const f = document.querySelector("footer.site-footer") || document.querySelector("footer");
		const slash = (p) => p.replace(/\/?$/, "/");
		const pl = f && policy ? Array.from(f.querySelectorAll("a[href]")).find((a) => { try { const u = new URL(a.href, location.href); return u.origin === location.origin && slash(u.pathname) === slash(policy); } catch { return false; } }) : null;
		if (pl && pl.parentElement) {
			const label = text("settings", "Cookie settings");
			const span = pl.children.length === 1 && pl.firstElementChild.tagName === "SPAN" && pl.textContent.trim() === pl.firstElementChild.textContent.trim();
			const b = el("button", { type: "button", class: `${pl.className} consent-link--inline`.trim(), style: pl.getAttribute("style"), "data-consent-open": true, ...(span ? {} : { text: label }) }, span ? [el("span", { text: label })] : []);
			pl.parentElement.insertBefore(b, pl);
		} else if (f) f.appendChild(el("p", { class: "consent-footer" }, [el("button", { type: "button", class: "consent-link", "data-consent-open": true, text: text("settings", "Cookie settings") })]));
	}
	document.addEventListener("click", (e) => {
		const t = e.target && typeof e.target.closest === "function" ? e.target.closest("[data-consent-open]") : null;
		if (!t) return;
		e.preventDefault();
		open(true);
	});
	render();
})();
