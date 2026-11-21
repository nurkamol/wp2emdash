/**
 * Site behaviour, no framework: header scroll states, burger menu (motion from motion.css),
 * popups (<dialog>), tabs, reveal-on-scroll, form submission, signature pads, conversion events.
 */
import { mountPrefill } from "@wp2emdash/forms/prefill";
import { mountSignaturePads } from "@wp2emdash/forms/signature-pad";
import { classifyLink } from "@wp2emdash/seo/analytics/events";
import { prefetchable, slowConnection } from "../utils/prefetch";

/**
 * Conversion events (SEO & Analytics → Analytics): handed to the analytics loader (public/scripts/site-analytics.js),
 * which exists only where tracking codes load and sends only the kinds switched on. Kind and a non-personal label
 * only (form id, "phone"/"email", a host) — never what a visitor typed.
 */
const track = (kind: "lead" | "contact" | "booking" | "outbound", label: string) => (window as { siteAnalytics?: { track(k: string, l: string): void } }).siteAnalytics?.track(kind, label);
document.addEventListener(
	"click",
	(e) => {
		const a = (e.target as Element | null)?.closest?.("a[href]");
		const href = a?.getAttribute("href");
		const ev = href ? classifyLink(href, location.host) : undefined;
		if (ev) track(ev.kind, ev.label);
	},
	{ capture: true },
);

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
// Plugins → Motion (@wp2emdash/motion) can switch the entrance reveal and the old site's parallax/drift off.
const motionOff = (what: "motionEntrance" | "motionParallax") => document.documentElement.dataset[what] === "off";

// ── Announcement bar: keeps --announce-h / --announce-offset current (the inline script after the bar set them
// before first paint); the close button hides it and remembers this message version. ──
const bar = document.querySelector<HTMLElement>("[data-announcement]");
if (bar && !bar.hidden) {
	const root = document.documentElement;
	const sticky = bar.hasAttribute("data-sticky");
	let h = bar.offsetHeight;
	const place = () => {
		const on = bar.hidden ? 0 : h;
		root.style.setProperty("--announce-h", `${on}px`);
		root.style.setProperty("--announce-offset", `${sticky ? on : Math.max(0, on - window.scrollY)}px`);
	};
	new ResizeObserver(() => {
		h = bar.offsetHeight || h;
		place();
	}).observe(bar);
	if (!sticky) window.addEventListener("scroll", place, { passive: true });
	bar.querySelector("[data-announcement-close]")?.addEventListener("click", () => {
		try {
			localStorage.setItem(`announcement:${bar.dataset.version}`, "closed");
		} catch {}
		const done = () => {
			bar.hidden = true;
			root.classList.remove("has-announcement");
			place();
			// Focus would be lost with the bar: move it to the page content.
			document.getElementById("main")?.focus({ preventScroll: true });
		};
		if (reduce) done();
		else {
			bar.classList.add("is-closing");
			window.setTimeout(done, 200);
		}
	});
}

// ── Header: transparent over the hero → solid; hide on scroll down, reveal on scroll up ──
const header = document.querySelector<HTMLElement>("[data-header]");
if (header) {
	let last = window.scrollY;
	const onScroll = () => {
		const y = window.scrollY;
		header.classList.toggle("is-scrolled", y > 10);
		if (header.classList.contains("hides-on-scroll") && !document.body.classList.contains("menu-open")) {
			header.classList.toggle("is-hidden", y > last && y > header.offsetHeight);
		}
		last = y;
	};
	onScroll();
	window.addEventListener("scroll", onScroll, { passive: true });
}

// ── Burger menu ──────────────────────────────────────────────────────────────
const toggle = document.querySelector<HTMLButtonElement>("[data-menu-toggle]");
const panel = document.querySelector<HTMLElement>("[data-menu-panel]");
const overlay = document.querySelector<HTMLElement>("[data-menu-overlay]");
const main = document.getElementById("main");
const footer = document.querySelector<HTMLElement>(".site-footer");
const closeMs = () => (reduce ? 0 : Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--menu-close-ms")) || 400);

function setMenu(open: boolean) {
	if (!toggle || !panel || !overlay) return;
	toggle.setAttribute("aria-expanded", String(open));
	document.body.classList.toggle("menu-open", open);
	for (const el of [main, footer, bar]) if (el) el.inert = open;
	if (open) {
		panel.hidden = false;
		overlay.hidden = false;
		requestAnimationFrame(() => {
			panel.classList.add("is-open");
			overlay.classList.add("is-open");
			// Once visible: a closed panel is visibility:hidden and cannot take focus.
			panel.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true });
		});
	} else {
		panel.classList.remove("is-open");
		overlay.classList.remove("is-open");
		window.setTimeout(() => {
			if (!panel.classList.contains("is-open")) {
				panel.hidden = true;
				overlay.hidden = true;
			}
		}, closeMs());
		toggle.focus({ preventScroll: true });
	}
}
toggle?.addEventListener("click", () => setMenu(toggle.getAttribute("aria-expanded") !== "true"));
overlay?.addEventListener("click", () => setMenu(false));
panel?.addEventListener("click", (e) => {
	// A link, or the panel's own close button (Bricks offcanvas sheet), closes the menu.
	if ((e.target as HTMLElement).closest("a, [data-menu-close]")) setMenu(false);
});
document.addEventListener("keydown", (e) => {
	if (!document.body.classList.contains("menu-open")) return;
	if (e.key === "Escape") setMenu(false);
	if (e.key === "Tab" && panel && toggle) {
		const focusables = [toggle, ...panel.querySelectorAll<HTMLElement>("a, button")];
		const first = focusables[0];
		const lastEl = focusables[focusables.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			lastEl?.focus();
		} else if (!e.shiftKey && document.activeElement === lastEl) {
			e.preventDefault();
			first?.focus();
		}
	}
});

// Sub-menus in the panel open on their chevron button (the parent link still navigates).
for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-submenu-toggle]")) {
	btn.addEventListener("click", () => {
		const open = btn.getAttribute("aria-expanded") !== "true";
		btn.setAttribute("aria-expanded", String(open));
		const sub = document.getElementById(btn.getAttribute("aria-controls") ?? "");
		sub?.toggleAttribute("data-open", open);
	});
}

// ── Popups ─────────────────────────────────────────────────────────────────────
const dialogs = [...document.querySelectorAll<HTMLDialogElement>("dialog.popup")];
const openPopup = (id: string) => {
	const d = document.getElementById(id) as HTMLDialogElement | null;
	if (d && !d.open) {
		if (document.body.classList.contains("menu-open")) setMenu(false);
		d.showModal();
	}
};
document.addEventListener("click", (e) => {
	const t = e.target as HTMLElement;
	const trigger = t.closest<HTMLElement>("[data-popup]");
	if (trigger?.dataset.popup && document.getElementById(trigger.dataset.popup)) {
		e.preventDefault();
		openPopup(trigger.dataset.popup);
		return;
	}
	for (const d of dialogs) {
		const sel = d.dataset.selectors;
		// Popup Maker selectors often name the popup's own id (#book-now): a click inside the popup is never a trigger.
		const hit = sel ? t.closest(sel) : null;
		if (hit && !d.contains(hit)) {
			e.preventDefault();
			openPopup(d.id);
			return;
		}
	}
});
for (const d of dialogs) {
	d.addEventListener("click", (e) => {
		if (e.target === d || (e.target as HTMLElement).closest("[data-popup-close]")) d.close();
	});
	const delay = Number(d.dataset.autoOpen);
	if (delay >= 0 && d.dataset.autoOpen !== undefined && !sessionStorage.getItem(`popup:${d.id}`)) {
		window.setTimeout(() => {
			openPopup(d.id);
			try {
				sessionStorage.setItem(`popup:${d.id}`, "1");
			} catch {}
		}, delay);
	}
}
if (location.hash && dialogs.some((d) => `#${d.id}` === location.hash)) openPopup(location.hash.slice(1));

// ── Tabs ───────────────────────────────────────────────────────────────────────
for (const tabs of document.querySelectorAll<HTMLElement>("[data-tabs]")) {
	const buttons = [...tabs.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
	const select = (i: number) =>
		buttons.forEach((b, n) => {
			b.setAttribute("aria-selected", String(n === i));
			b.tabIndex = n === i ? 0 : -1;
			const p = document.getElementById(b.getAttribute("aria-controls") ?? "");
			if (p) p.hidden = n !== i;
		});
	buttons.forEach((b, i) => {
		b.addEventListener("click", () => select(i));
		b.addEventListener("keydown", (e) => {
			const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
			if (d) {
				const n = (i + d + buttons.length) % buttons.length;
				select(n);
				buttons[n]?.focus();
			}
		});
	});
}

// ── Reveal on scroll ───────────────────────────────────────────────────────────
if (!reduce && "IntersectionObserver" in window && !motionOff("motionEntrance")) {
	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) if (e.isIntersecting) {
				e.target.classList.add("is-visible");
				io.unobserve(e.target);
			}
		},
		{ rootMargin: "0px 0px -10% 0px" },
	);
	// The footer and popups are never held back: the last footer row can't rise 10% above the screen's bottom edge.
	const revealable = [...document.querySelectorAll<HTMLElement>("[data-reveal]")].filter((el) => !el.closest(".site-footer, dialog"));
	// Calm motion: what is already on screen at load is shown as it is (no entrance), so the largest paint is not held back.
	if (document.documentElement.classList.contains("motion-calm")) for (const el of revealable) if (el.getBoundingClientRect().top < window.innerHeight) el.classList.add("is-visible");
	for (const el of revealable) if (!el.classList.contains("is-visible")) io.observe(el);
	// At the end of the page, anything still waiting is shown.
	const atEnd = () => {
		if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) for (const el of revealable) el.classList.add("is-visible");
	};
	window.addEventListener("scroll", atEnd, { passive: true });
	document.documentElement.classList.add("js-reveal");
}

// ── Forms ──────────────────────────────────────────────────────────────────────
// Without JavaScript the endpoint sends the browser back with ?form=sent|error: say so on the form.
{
	const state = new URLSearchParams(location.search).get("form");
	const status = document.querySelector<HTMLElement>("form[data-form] .form__status");
	if (state && status) status.textContent = state === "sent" ? "Thank you — your message was sent." : "Your message could not be sent. Please try again, or call or email us.";
	if (state === "sent") status?.closest<HTMLFormElement>("form[data-after=hide]")?.classList.add("is-sent");
}
// Signature fields: the drawing pad (without JavaScript the typed-name input is the signature).
mountSignaturePads();
// ?product= (a catalogue product's Buy button → the contact form) and other query values fill the empty fields of that name.
mountPrefill();
/**
 * Conditional fields (data-show-if, the definition's `showIf`): shown only while the field they depend on has one of the
 * values; a hidden field's inputs are disabled, so they are neither validated nor sent. Without JavaScript every field
 * shows and the server ignores the ones that do not apply (packages/forms/src/logic.ts).
 */
function applyConditions(form: HTMLFormElement): void {
	const valuesOf = (name: string): string[] => {
		const inputs = [...form.querySelectorAll<HTMLElement>(`[name="${CSS.escape(name)}"]`)].map((i) => i as HTMLInputElement).filter((i) => !i.disabled);
		return inputs.flatMap((i) => (i instanceof HTMLInputElement && (i.type === "checkbox" || i.type === "radio") ? (i.checked ? [i.type === "checkbox" && !form.querySelector(`[data-field="${CSS.escape(name)}"].field--checkbox-group`) ? "yes" : i.value] : []) : [i.value]));
	};
	// Twice: a field depending on a field that was just hidden follows it.
	for (let pass = 0; pass < 2; pass++) {
		for (const el of form.querySelectorAll<HTMLElement>("[data-show-if]")) {
			let rule: { field: string; equals: string[]; not?: boolean };
			try {
				rule = JSON.parse(el.dataset.showIf ?? "");
			} catch {
				continue;
			}
			const values = valuesOf(rule.field).map((x) => x.trim().toLowerCase());
			const hit = values.some((x) => rule.equals.map((w) => w.trim().toLowerCase()).includes(x));
			const show = rule.not ? !hit : hit;
			el.hidden = !show;
			for (const input of el.querySelectorAll<HTMLElement>("input, select, textarea")) (input as HTMLInputElement).disabled = !show;
		}
	}
}
/**
 * Multi-step forms (data-steps): one step at a time with Back/Next; Next checks the current step's fields first. Without
 * JavaScript all steps show as one form. The server validates every field either way.
 */
function mountSteps(form: HTMLFormElement): void {
	const steps = [...form.querySelectorAll<HTMLElement>(".form__step[data-step]")];
	if (steps.length < 2) return;
	const progress = form.querySelector<HTMLElement>("[data-form-progress]");
	const tail = [...form.querySelectorAll<HTMLElement>(":scope > .form__notice, :scope > .cf-turnstile, :scope > button[type=submit]")];
	let at = 0;
	const show = (i: number, focus: boolean) => {
		at = i;
		steps.forEach((s, j) => {
			s.hidden = j !== i;
			const nav = s.querySelector<HTMLElement>("[data-form-nav]");
			if (nav) nav.hidden = false;
		});
		for (const t of tail) t.hidden = i !== steps.length - 1;
		if (progress) {
			progress.hidden = false;
			progress.textContent = `Step ${i + 1} of ${steps.length}`;
		}
		if (focus) steps[i]?.querySelector<HTMLElement>("input:not([type=hidden]):not(:disabled), select:not(:disabled), textarea:not(:disabled)")?.focus();
	};
	form.addEventListener("click", (e) => {
		const t = e.target as HTMLElement;
		if (t.closest("[data-step-back]")) show(Math.max(0, at - 1), true);
		else if (t.closest("[data-step-next]")) {
			const invalid = [...(steps[at]?.querySelectorAll<HTMLInputElement>("input, select, textarea") ?? [])].find((i) => !i.disabled && !i.checkValidity());
			if (invalid) invalid.reportValidity();
			else show(Math.min(steps.length - 1, at + 1), true);
		}
	});
	// A server error on a field of an earlier step: go back to that step.
	form.addEventListener("form:invalid", (e) => {
		const name = (e as CustomEvent<string>).detail;
		const i = steps.findIndex((s) => s.querySelector(`[data-field="${CSS.escape(name)}"]`));
		if (i >= 0 && i < at) show(i, true);
	});
	form.addEventListener("form:reset", () => show(0, false));
	show(0, false);
}
/** File fields: size and count checked before sending (the server checks again, with the file's first bytes). */
function checkFiles(form: HTMLFormElement): boolean {
	for (const input of form.querySelectorAll<HTMLInputElement>('input[type="file"]:not(:disabled)')) {
		const max = Number(input.dataset.maxMb ?? 10) * 1024 * 1024;
		const most = Number(input.dataset.maxFiles ?? 1);
		const files = [...(input.files ?? [])];
		const msg = files.length > most ? `Choose at most ${most} file${most > 1 ? "s" : ""}.` : files.some((f) => f.size > max) ? `Each file can be at most ${input.dataset.maxMb ?? 10} MB.` : "";
		input.setCustomValidity(msg);
		if (msg) return input.reportValidity();
	}
	return true;
}
for (const form of document.querySelectorAll<HTMLFormElement>("form[data-form]")) {
	if (form.querySelector("[data-show-if]")) {
		applyConditions(form);
		form.addEventListener("input", () => applyConditions(form));
		form.addEventListener("change", () => applyConditions(form));
	}
	mountSteps(form);
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const status = form.querySelector<HTMLElement>(".form__status");
		if (!checkFiles(form)) return;
		if (!form.checkValidity()) {
			form.reportValidity();
			return;
		}
		const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
		if (button) button.disabled = true;
		for (const el of form.querySelectorAll<HTMLElement>(".field__error")) el.textContent = "";
		for (const el of form.querySelectorAll(".field.is-invalid")) el.classList.remove("is-invalid");
		try {
			const res = await fetch(form.action, { method: "POST", body: new FormData(form), headers: { Accept: "application/json" } });
			const body = (await res.json().catch(() => ({}))) as { message?: string; errors?: Record<string, string> };
			if (status) status.textContent = body.message ?? (res.ok ? "Thank you — we will be in touch." : "Something went wrong. Please try again.");
			for (const [name, msg] of Object.entries(body.errors ?? {})) {
				const field = form.querySelector<HTMLElement>(`[data-field="${CSS.escape(name)}"]`);
				field?.classList.add("is-invalid");
				const err = field?.querySelector<HTMLElement>(".field__error");
				if (err) err.textContent = msg;
				field?.querySelector<HTMLElement>("input:not([type=hidden]), textarea, select")?.setAttribute("aria-invalid", "true");
				form.dispatchEvent(new CustomEvent("form:invalid", { detail: name }));
			}
			if (res.ok) {
				track("lead", form.dataset.form ?? "form");
				form.reset();
				applyConditions(form);
				form.dispatchEvent(new Event("form:reset"));
				// Fluent "Hide Form": only the thank-you message stays.
				if (form.dataset.after === "hide") form.classList.add("is-sent");
			}
		} catch {
			if (status) status.textContent = "Network error. Please try again.";
		} finally {
			if (button) button.disabled = false;
			// Turnstile tokens are single use: get a fresh one for the next attempt.
			(window as { turnstile?: { reset(el?: Element): void } }).turnstile?.reset(form.querySelector(".cf-turnstile") ?? undefined);
		}
	});
}

// FAQ panel (faq--panel): answers open and close with a short height animation (none under prefers-reduced-motion),
// and in a group (data-faq-group) opening one closes the others — also where <details name> is not supported. Without
// JS the details still work natively.
for (const faq of document.querySelectorAll<HTMLElement>(".faq--panel")) {
	const grouped = !!faq.dataset.faqGroup;
	const items = [...faq.querySelectorAll<HTMLDetailsElement>(":scope > details.faq__item")];
	// The script keeps the group itself: native exclusivity would close the others without the animation.
	for (const d of items) d.removeAttribute("name");
	const answer = (d: HTMLDetailsElement) => d.querySelector<HTMLElement>(".faq__a");
	const animate = (d: HTMLDetailsElement, open: boolean) => {
		const a = answer(d);
		if (!a || reduce) {
			d.open = open;
			return;
		}
		if (open) d.open = true;
		const cs = getComputedStyle(a);
		const shown = { height: `${a.offsetHeight}px`, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, opacity: 1 };
		const hidden = { height: "0px", paddingTop: "0px", paddingBottom: "0px", opacity: 0 };
		const anim = a.animate(open ? [hidden, shown] : [shown, hidden], { duration: 260, easing: "cubic-bezier(0.25, 0.8, 0.25, 1)" });
		if (!open) anim.onfinish = () => (d.open = false);
	};
	for (const d of items) {
		d.querySelector("summary")?.addEventListener("click", (e) => {
			e.preventDefault();
			const opening = !d.open;
			if (opening && grouped) for (const o of items) if (o !== d && o.open) animate(o, false);
			animate(d, opening);
		});
	}
}

// Turnstile, rendered explicitly: the normal 300×65 widget, or the compact one where the form is narrower than 300px
// (320px phones). Not full width (data-size="flexible" stretched it across the form).
{
	type TS = { render(el: Element, o: Record<string, unknown>): unknown };
	const boxes = [...document.querySelectorAll<HTMLElement>(".cf-turnstile[data-sitekey]")];
	const renderAll = () => {
		const ts = (window as { turnstile?: TS }).turnstile;
		if (!ts) return;
		const draw = (el: HTMLElement, room: number) => {
			if (el.dataset.rendered) return;
			el.dataset.rendered = "1";
			ts.render(el, { sitekey: el.dataset.sitekey, theme: el.dataset.theme ?? "light", size: room >= 300 ? "normal" : "compact" });
		};
		for (const el of boxes) {
			const parent = el.parentElement;
			if (!parent) continue;
			if (parent.clientWidth > 0) draw(el, parent.clientWidth);
			else {
				// A form in a closed popup has no width yet: draw it once it is shown.
				const ro = new ResizeObserver(() => {
					if (parent.clientWidth > 0) {
						ro.disconnect();
						draw(el, parent.clientWidth);
					}
				});
				ro.observe(parent);
			}
		}
	};
	if (boxes.length) {
		if ((window as { turnstile?: TS }).turnstile) renderAll();
		else document.querySelector('script[src*="challenges.cloudflare.com/turnstile"]')?.addEventListener("load", renderAll);
	}
}

// Background videos: never part of the first load. The section's picture paints first (LCP); the file is attached
// after the load event, when the browser is idle — and not at all on small screens (< 768px), with data saver
// (Save-Data) or reduced motion, where the picture stays. A video without a picture (data-always) is attached
// everywhere, showing its first frame instead of playing under reduced motion. Started even where autoplay was
// deferred (iOS Low Power Mode, a tab opened in the background): retried on the first touch, scroll or return.
const bgVideos = [...document.querySelectorAll<HTMLVideoElement>("video[data-bg-video]")];
if (bgVideos.length) {
	const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true;
	// html.video-phones (performance.phoneVideo): phones play it too, still after load.
	const small = !document.documentElement.classList.contains("video-phones") && window.matchMedia("(max-width: 767.98px)").matches;
	const playing: HTMLVideoElement[] = [];
	const start = () => {
		for (const v of playing) {
			v.muted = true;
			if (v.paused) v.play().catch(() => {});
		}
	};
	const attach = () => {
		for (const v of bgVideos) {
			const src = v.dataset.src;
			const always = v.hasAttribute("data-always");
			if (!src || (!always && (reduce || saveData || small))) continue;
			v.addEventListener(reduce ? "loadeddata" : "playing", () => v.classList.add("is-playing"), { once: true });
			if (reduce) v.preload = "metadata";
			v.src = src;
			v.removeAttribute("data-src");
			if (!reduce) playing.push(v);
		}
		if (!playing.length) return;
		start();
		for (const ev of ["pointerdown", "touchstart", "scroll", "keydown"]) window.addEventListener(ev, start, { once: true, passive: true });
		document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && start());
	};
	const idle = () => (typeof window.requestIdleCallback === "function" ? window.requestIdleCallback(attach, { timeout: 3000 }) : setTimeout(attach, 300));
	if (document.readyState === "complete") idle();
	else window.addEventListener("load", idle, { once: true });
}

// Drifting text columns (Salient column parallax): offset = k × (column centre − viewport centre),
// side-by-side layouts only, nothing under reduced motion.
const drifters = [...document.querySelectorAll<HTMLElement>("[data-drift]")];
if (drifters.length && !reduce && !motionOff("motionParallax")) {
	const wide = window.matchMedia("(min-width: 900px)");
	let queued = false;
	const place = () => {
		queued = false;
		const mid = window.innerHeight / 2;
		for (const el of drifters) {
			if (!wide.matches) {
				el.style.transform = "";
				continue;
			}
			const k = Number(el.dataset.drift) || 0;
			const r = el.getBoundingClientRect();
			const shift = Number.parseFloat(el.dataset.shift ?? "0");
			const centre = r.top - shift + r.height / 2; // where the column sits without the drift
			const next = Math.round(k * (centre - mid) * 10) / 10;
			el.dataset.shift = String(next);
			el.style.transform = `translate3d(0, ${next}px, 0)`;
		}
	};
	const queue = () => {
		if (!queued) {
			queued = true;
			requestAnimationFrame(place);
		}
	};
	place();
	window.addEventListener("scroll", queue, { passive: true });
	window.addEventListener("resize", queue);
}

// Parallax pictures (Salient column parallax_bg, measured on the source): the image is k × viewport height taller
// than its box, starts k × viewport height above it, and moves down k px per scrolled px from the moment the box
// enters the viewport. Nothing under reduced motion: the picture then simply fills its box.
const parallax = [...document.querySelectorAll<HTMLElement>("[data-parallax]")];
if (parallax.length && !reduce && !motionOff("motionParallax")) {
	let queued = false;
	const place = () => {
		queued = false;
		const vh = window.innerHeight;
		for (const box of parallax) {
			const img = box.querySelector<HTMLElement>("img");
			const k = Number(box.dataset.parallax) || 0;
			if (!img || !k) continue;
			const r = box.getBoundingClientRect();
			if (r.bottom < -vh || r.top > 2 * vh) continue;
			const lift = k * vh;
			const y = Math.min(Math.max(k * (vh - r.top), 0), k * (vh + r.height));
			img.style.top = `${-lift}px`;
			img.style.height = `${r.height + lift}px`;
			img.style.transform = `translate3d(0, ${Math.round(y * 10) / 10}px, 0) scale(1.005)`;
		}
	};
	const queue = () => {
		if (!queued) {
			queued = true;
			requestAnimationFrame(place);
		}
	};
	place();
	window.addEventListener("scroll", queue, { passive: true });
	window.addEventListener("resize", queue);
}

// Team members: the card opens a full-screen bio. With a mouse on a wide screen a click anywhere closes it and the
// close ring follows the cursor; otherwise the close button (and Esc) close it.
const pointerClose = window.matchMedia("(min-width: 1000px) and (hover: hover) and (pointer: fine)");
document.addEventListener("click", (e) => {
	const opener = (e.target as HTMLElement).closest<HTMLElement>("[data-person-open]");
	const dialog = opener ? (document.getElementById(opener.dataset.personOpen ?? "") as HTMLDialogElement | null) : null;
	if (dialog && !dialog.open) {
		dialog.showModal();
		dialog.querySelector<HTMLElement>("[data-person-close]")?.focus({ preventScroll: true });
	}
});
for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog.person-modal")) {
	const ring = dialog.querySelector<HTMLElement>(".person-cursor");
	dialog.addEventListener("click", (e) => {
		if (pointerClose.matches || (e.target as HTMLElement).closest("[data-person-close]")) dialog.close();
	});
	dialog.addEventListener("pointermove", (e) => {
		if (!ring || e.pointerType !== "mouse") return;
		ring.style.setProperty("--cx", `${e.clientX}px`);
		ring.style.setProperty("--cy", `${e.clientY}px`);
		ring.classList.add("is-on");
	});
	dialog.addEventListener("pointerleave", () => ring?.classList.remove("is-on"));
	dialog.addEventListener("close", () => {
		ring?.classList.remove("is-on");
		dialog.closest(".person")?.querySelector<HTMLElement>("[data-person-open]")?.focus({ preventScroll: true });
	});
}

/**
 * Page preloading on hover / focus / first touch (utils/prefetch.ts). Off when <html data-prefetch="off">. Browsers with
 * Speculation Rules (Chrome, Edge) preload from the middleware's Speculation-Rules header instead, whose copy the click
 * actually uses: this is the fallback for the others (Safari, Firefox), so no page is fetched twice.
 */
if (document.documentElement.dataset.prefetch !== "off" && !(HTMLScriptElement as { supports?: (type: string) => boolean }).supports?.("speculationrules")) {
	const done = new Set<string>();
	const supportsPrefetch = document.createElement("link").relList?.supports?.("prefetch") ?? false;
	const go = (a: Element | null) => {
		if (!(a instanceof HTMLAnchorElement) || a.target === "_blank" || a.hasAttribute("download") || a.dataset.prefetch === "false") return;
		if (slowConnection((navigator as { connection?: { saveData?: boolean; effectiveType?: string } }).connection)) return;
		const url = prefetchable(a.href, location);
		if (!url || done.has(url) || done.size >= 20) return;
		done.add(url);
		if (supportsPrefetch) {
			const l = document.createElement("link");
			l.rel = "prefetch";
			l.href = url;
			document.head.appendChild(l);
		} else fetch(url, { credentials: "same-origin", priority: "low" } as RequestInit).catch(() => {});
	};
	let timer: number | undefined;
	document.addEventListener("mouseover", (e) => {
		const a = (e.target as Element | null)?.closest?.("a") ?? null;
		clearTimeout(timer);
		if (a) timer = window.setTimeout(() => go(a), 65);
	}, { passive: true });
	document.addEventListener("focusin", (e) => go((e.target as Element | null)?.closest?.("a") ?? null), { passive: true });
	document.addEventListener("touchstart", (e) => go((e.target as Element | null)?.closest?.("a") ?? null), { passive: true });
}
