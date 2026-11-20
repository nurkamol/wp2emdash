/* Motion (Plugins → Motion, @wp2emdash/motion): first-visit preloader and image fade-in. A file, never inline (CSP).
   Loaded in <head> without defer only when the preloader is on, so it decides before the first paint. */
(function () {
	var root = document.documentElement;
	var d = root.dataset;
	var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
	var now = function () {
		return window.performance && performance.now ? performance.now() : 0;
	};
	// Preloader: once per browser session, never for bots, prerendering, background tabs or reduced motion.
	if (d.motionPreloader === "logo" && !reduce) {
		var nav = navigator;
		var bot = nav.webdriver || /bot|crawl|spider|slurp|lighthouse|headless|prerender|preview/i.test(nav.userAgent || "");
		var hiddenTab = document.prerendering || document.visibilityState === "hidden";
		var show = false;
		if (!bot && !hiddenTab) {
			try {
				show = d.motionPreview === "on" || sessionStorage.getItem("motion:preloaded") !== "1";
				if (show && d.motionPreview !== "on") sessionStorage.setItem("motion:preloaded", "1");
			} catch (e) {
				show = false;
			}
		}
		if (show) {
			root.classList.add("motion-preloading");
			var min = Math.min(800, Math.max(0, Number(d.motionPreloaderMin) || 0));
			var done = false;
			var hide = function () {
				if (done) return;
				done = true;
				root.classList.add("motion-preloaded");
				setTimeout(function () {
					root.classList.remove("motion-preloading", "motion-preloaded");
				}, 260);
			};
			var ready = function () {
				setTimeout(hide, Math.max(0, min - now()));
			};
			if (document.readyState === "complete") ready();
			else window.addEventListener("load", ready, { once: true });
			// Hard cap: never longer than 1.2 s from the start of the visit, whatever the page is doing.
			setTimeout(hide, Math.max(0, 1200 - now()));
		}
	}
	// Image fade-in: lazy images still loading get .motion-img and fade in once loaded (or failed).
	if (d.motionImages === "on" && !reduce) {
		var fade = function () {
			var imgs = document.querySelectorAll("main img[loading=lazy]");
			for (var i = 0; i < imgs.length; i++) {
				var img = imgs[i];
				if (img.complete) continue;
				img.classList.add("motion-img");
				var on = function () {
					this.classList.add("is-loaded");
				};
				img.addEventListener("load", on, { once: true });
				img.addEventListener("error", on, { once: true });
			}
		};
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fade, { once: true });
		else fade();
	}
})();
