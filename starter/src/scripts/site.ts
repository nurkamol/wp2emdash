/**
 * Site behaviour, no framework: header scroll states, burger menu (motion from motion.css),
 * popups (<dialog>), tabs, reveal-on-scroll, form submission.
 */
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

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
	for (const el of [main, footer]) if (el) el.inert = open;
	if (open) {
		panel.hidden = false;
		overlay.hidden = false;
		requestAnimationFrame(() => {
			panel.classList.add("is-open");
			overlay.classList.add("is-open");
		});
		panel.querySelector<HTMLElement>("a, button")?.focus({ preventScroll: true });
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
	if ((e.target as HTMLElement).closest("a")) setMenu(false);
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
		if (sel && t.closest(sel)) {
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
if (!reduce && "IntersectionObserver" in window) {
	const io = new IntersectionObserver(
		(entries) => {
			for (const e of entries) if (e.isIntersecting) {
				e.target.classList.add("is-visible");
				io.unobserve(e.target);
			}
		},
		{ rootMargin: "0px 0px -10% 0px" },
	);
	for (const el of document.querySelectorAll("[data-reveal]")) io.observe(el);
	document.documentElement.classList.add("js-reveal");
}

// ── Forms ──────────────────────────────────────────────────────────────────────
for (const form of document.querySelectorAll<HTMLFormElement>("form[data-form]")) {
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		const status = form.querySelector<HTMLElement>(".form__status");
		if (!form.checkValidity()) {
			form.reportValidity();
			return;
		}
		const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
		if (button) button.disabled = true;
		try {
			const res = await fetch(form.action, { method: "POST", body: new FormData(form), headers: { Accept: "application/json" } });
			const body = (await res.json().catch(() => ({}))) as { message?: string };
			if (status) status.textContent = body.message ?? (res.ok ? "Thank you — we will be in touch." : "Something went wrong. Please try again.");
			if (res.ok) form.reset();
		} catch {
			if (status) status.textContent = "Network error. Please try again.";
		} finally {
			if (button) button.disabled = false;
		}
	});
}

// Background videos: start them even where autoplay was deferred (iOS Low Power Mode, data saver
// or a tab opened in the background); retry on the first touch, scroll or return to the tab.
const bgVideos = [...document.querySelectorAll<HTMLVideoElement>("video[data-bg-video]")];
if (bgVideos.length) {
	const start = () => {
		for (const v of bgVideos) {
			v.muted = true;
			if (v.paused) v.play().catch(() => {});
		}
	};
	start();
	for (const ev of ["pointerdown", "touchstart", "scroll", "keydown"]) window.addEventListener(ev, start, { once: true, passive: true });
	document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && start());
}
