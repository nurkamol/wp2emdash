// wp2emdash dashboard — vanilla JS, no dependencies. Every value from the server is inserted as text
// (textContent / DOM nodes), never as HTML. Routes live in the hash: #/, #/site/<slug>[/visual|/runs[/<runId>]].
"use strict";

(function () {
	var app = document.getElementById("app");
	var crumbs = document.getElementById("crumbs");
	var timers = [];
	var sources = [];

	// ── helpers ──────────────────────────────────────────────────────────────────────────────────
	function el(tag, props) {
		var node = document.createElement(tag);
		if (props) {
			for (var k in props) {
				var v = props[k];
				if (v === undefined || v === null || v === false) continue;
				if (k === "class") node.className = v;
				else if (k === "text") node.textContent = String(v);
				else if (k.slice(0, 2) === "on") node.addEventListener(k.slice(2), v);
				else if (k === "style") continue; // CSP: styles only through CSSOM
				else node.setAttribute(k, v === true ? "" : String(v));
			}
		}
		for (var i = 2; i < arguments.length; i++) append(node, arguments[i]);
		return node;
	}
	function append(node, child) {
		if (child === undefined || child === null || child === false) return;
		if (Array.isArray(child)) return child.forEach(function (c) { append(node, c); });
		node.appendChild(typeof child === "object" ? child : document.createTextNode(String(child)));
	}
	function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
	function pct(n) { return n === undefined || n === null ? "—" : (n * 100).toFixed(1) + "%"; }
	function ago(iso) {
		if (!iso) return "—";
		var t = Date.parse(iso);
		if (isNaN(t)) return iso;
		var s = Math.round((Date.now() - t) / 1000);
		if (s < 60) return s + " s ago";
		if (s < 3600) return Math.round(s / 60) + " min ago";
		if (s < 86400) return Math.round(s / 3600) + " h ago";
		return new Date(t).toLocaleString();
	}
	function api(path, opts) {
		return fetch(path, Object.assign({ credentials: "same-origin", headers: { Accept: "application/json" } }, opts || {})).then(function (r) {
			return r.json().catch(function () { return {}; }).then(function (body) {
				if (!r.ok) throw new Error(body && body.error ? body.error : "HTTP " + r.status);
				return body;
			});
		});
	}
	function pill(status, label) { return el("span", { class: "pill " + status, text: label || status }); }
	function scoreRing(score, big) {
		var ring = el("div", { class: "score" + (big ? " lg" : ""), role: "img", "aria-label": "Launch readiness " + score + " of 100" }, el("span", { text: score }));
		ring.style.setProperty("--v", String(score));
		ring.style.setProperty("--c", score >= 90 ? "var(--ok)" : score >= 60 ? "var(--warn)" : "var(--bad)");
		return ring;
	}
	function copyBtn(textValue) {
		return el("button", { type: "button", class: "ghost small", onclick: function (e) {
			var b = e.currentTarget;
			(navigator.clipboard ? navigator.clipboard.writeText(textValue) : Promise.reject()).then(function () { b.textContent = "Copied"; }, function () { b.textContent = "Select and copy"; });
			setTimeout(function () { b.textContent = "Copy"; }, 1600);
		} }, "Copy");
	}
	function fixLine(fix) {
		if (!fix) return null;
		if (fix.charAt(0) === "#") return el("div", { class: "fix" }, el("a", { href: fix, text: "Open in the visual viewer →" }));
		return el("div", { class: "fix" }, el("code", { text: fix }), copyBtn(fix));
	}
	function setCrumbs(items) {
		clear(crumbs);
		items.forEach(function (it, i) {
			if (i) append(crumbs, el("span", { "aria-hidden": "true", text: "/" }));
			append(crumbs, it.href ? el("a", { href: it.href, text: it.text }) : el("span", { text: it.text }));
		});
	}
	function stopAll() {
		timers.forEach(clearInterval); timers = [];
		sources.forEach(function (s) { s.close(); }); sources = [];
	}
	function show(node) { clear(app); append(app, node); }
	function fail(e) { show(el("div", { class: "card" }, el("h2", { text: "Something went wrong" }), el("p", { class: "err", text: e.message || String(e) }))); }

	// ── theme ────────────────────────────────────────────────────────────────────────────────────
	var root = document.documentElement;
	function getTheme() { try { return localStorage.getItem("wp2emdash-theme"); } catch (e) { return null; } }
	function setTheme(t) {
		if (t) root.setAttribute("data-theme", t); else root.removeAttribute("data-theme");
		try { if (t) localStorage.setItem("wp2emdash-theme", t); else localStorage.removeItem("wp2emdash-theme"); } catch (e) { /* storage unavailable */ }
		document.getElementById("theme").textContent = t === "dark" ? "Dark" : t === "light" ? "Light" : "Auto";
	}
	setTheme(getTheme());
	document.getElementById("theme").addEventListener("click", function () {
		var t = getTheme();
		setTheme(t === null ? "light" : t === "light" ? "dark" : null);
	});

	// ── timeline ─────────────────────────────────────────────────────────────────────────────────
	function timeline(phases, next, big) {
		return el("div", { class: "timeline" + (big ? " big" : ""), role: "list", "aria-label": "Phase timeline" }, phases.map(function (p) {
			var label = p.id + ": " + p.status + (p.failing ? ", " + p.failing + " failing" : "") + (p.id === next ? " (next)" : "");
			return el("div", { class: "step " + p.status + (p.id === next ? " next" : ""), role: "listitem", title: label, "aria-label": label },
				el("div", { class: "bar" }),
				el("div", { class: "name", text: p.id }),
				big ? el("div", null, pill(p.status), p.failing ? el("span", { class: "small muted", text: " " + p.failing + " failing" }) : null) : null,
				big && p.acceptedReason ? el("div", { class: "small muted", text: "Accepted: " + p.acceptedReason }) : null,
				big && p.finishedAt ? el("div", { class: "small muted", text: ago(p.finishedAt) }) : null);
		}));
	}
	function runLine(r) {
		if (!r) return el("span", { class: "muted", text: "No runs yet" });
		var st = !r.finished ? pill("running", "running or interrupted") : r.ok ? pill("passed", "passed") : pill("failed", "failed");
		return el("span", { class: "row" }, el("span", { text: (r.phase || "?") + (r.preview ? " (preview)" : "") }), st, el("span", { class: "muted small", text: ago(r.lastEventAt || r.startedAt) }));
	}

	// ── portfolio ────────────────────────────────────────────────────────────────────────────────
	function portfolio() {
		setCrumbs([{ text: "Portfolio" }]);
		var render = function () {
			return api("/api/portfolio").then(function (sites) {
				if (!sites.length) return show(el("div", { class: "card" }, el("h2", { text: "No sites yet" }), el("p", null, "Create one with ", el("code", { text: "pnpm wp2emdash init" }), " or the wizard (", el("code", { text: "pnpm wp2emdash" }), ").")));
				show(el("div", null,
					el("div", { class: "head" }, el("div", null, el("h1", { text: "Portfolio" }), el("p", { class: "muted", text: sites.length + " site" + (sites.length === 1 ? "" : "s") + " · refreshes every 5 s" }))),
					el("div", { class: "grid cards" }, sites.map(siteCard))));
			});
		};
		render().catch(fail);
		timers.push(setInterval(function () { render().catch(function () {}); }, 5000));
	}
	function siteCard(s) {
		var href = "#/site/" + encodeURIComponent(s.slug);
		var blockers = s.readiness.blockers || [];
		return el("article", { class: "card" },
			el("div", { class: "row spread" },
				el("div", null, el("h2", null, el("a", { href: href, text: s.name })), el("div", { class: "muted small", text: s.slug })),
				scoreRing(s.readiness.score)),
			s.error ? el("p", { class: "err", text: s.error }) : timeline(s.phases, s.next, false),
			el("dl", { class: "kv" },
				el("dt", { text: "Next" }), el("dd", null, s.next ? el("span", null, el("b", { text: s.next }), " ", pill(s.current ? s.current.status : "pending")) : pill("passed", "all gates done")),
				el("dt", { text: "Readiness" }), el("dd", { text: s.readiness.passed + " / " + s.readiness.total + " launch checks pass" }),
				el("dt", { text: "Last run" }), el("dd", null, runLine(s.lastRun))),
			blockers.length ? el("details", null, el("summary", { text: blockers.length + " blocker" + (blockers.length === 1 ? "" : "s") }),
				el("ul", { class: "list small" }, blockers.slice(0, 6).map(function (b) { return el("li", null, el("b", { text: b.label }), b.detail ? el("span", { class: "muted", text: " — " + b.detail }) : null); }),
					blockers.length > 6 ? el("li", null, el("a", { href: href, text: "+" + (blockers.length - 6) + " more" })) : null)) : el("p", { class: "small", text: "Nothing blocks launch." }),
			el("div", { class: "row" }, el("a", { href: href, text: "Overview" }), el("a", { href: href + "/visual", text: "Visual diff" }), el("a", { href: href + "/runs", text: "Runs" })));
	}

	// ── site ─────────────────────────────────────────────────────────────────────────────────────
	function tabs(slug, active) {
		var base = "#/site/" + encodeURIComponent(slug);
		var t = [["overview", base, "Overview & readiness"], ["visual", base + "/visual", "Visual diff"], ["runs", base + "/runs", "Runs"]];
		return el("nav", { class: "tabs", "aria-label": "Site sections" }, t.map(function (x) { return el("a", { href: x[1], text: x[2], "aria-current": x[0] === active ? "page" : null }); }));
	}

	function overview(slug) {
		api("/api/sites/" + encodeURIComponent(slug)).then(function (d) {
			var s = d.summary, r = d.readiness;
			setCrumbs([{ text: "Portfolio", href: "#/" }, { text: s.name }]);
			var groups = { gate: "Pipeline gates (init → verify)", verify: "Verify report checks", preflight: "Cutover preflight" };
			var src = r.sources;
			show(el("div", null,
				el("div", { class: "head" }, el("div", null, el("h1", { text: s.name }), el("p", { class: "muted", text: s.slug })), runLine(s.lastRun)),
				tabs(slug, "overview"),
				s.error ? el("p", { class: "err", text: s.error }) : timeline(s.phases, s.next, true),
				el("div", { class: "grid two" },
					el("section", { class: "card", "aria-labelledby": "blk" },
						el("h2", { id: "blk", text: "What blocks launch" }),
						r.blockers.length ? el("ul", { class: "list" }, r.blockers.map(function (b) {
							return el("li", { class: "blocker" }, el("b", { text: b.label }), b.detail ? el("div", { class: "muted small", text: b.detail }) : null, fixLine(b.fix));
						})) : el("p", { class: "notice ok", text: "Every launch check passes. The switch itself is an owner-approved step (cutover/runbook.md)." })),
					el("section", { class: "card", "aria-labelledby": "rd" },
						el("div", { class: "row" }, scoreRing(r.score, true), el("div", null, el("h2", { id: "rd", text: "Launch readiness" }), el("p", { class: "muted", text: r.passed + " of " + r.total + " launch checks pass" }))),
						el("details", null, el("summary", { text: "How the score works" }),
							el("p", { class: "small" }, "Score = launch checks passing ÷ all launch checks × 100. The checks are: every gate before cutover (init → verify) passed or accepted; every check in the latest verify report (", el("code", { text: "reports/verify/verify.json" }), "); and every cutover preflight check (from ", el("code", { text: "state.json" }), ", or the failures the latest preview run logged). A gate the owner accepted with a reason counts as passing. Every failing check is a blocker."),
							el("dl", { class: "kv small" },
								el("dt", { text: "Verify report" }), el("dd", { text: src.verifyRanAt ? src.verifyTarget + " · " + ago(src.verifyRanAt) : "none yet" }),
								el("dt", { text: "Preflight from" }), el("dd", { text: src.preflight === "state" ? "state.json" : src.preflight === "run-log" ? "run log " + src.preflightRunId : "not run yet" }))),
						Object.keys(groups).map(function (g) {
							var list = r.items.filter(function (i) { return i.group === g; });
							if (!list.length) return null;
							var okN = list.filter(function (i) { return i.ok; }).length;
							return el("details", { open: g === "gate" ? true : null }, el("summary", { text: groups[g] + " — " + okN + "/" + list.length }),
								el("ul", { class: "list small" }, list.map(function (i) {
									return el("li", null, pill(i.ok ? (i.accepted ? "accepted" : "passed") : "failed", i.ok ? (i.accepted ? "accepted" : "ok") : "fail"), " ", el("span", { text: i.label }), i.detail ? el("div", { class: "muted", text: i.detail }) : null);
								})));
						}))),
				s.lastRun && !s.lastRun.finished ? el("section", { class: "card", "aria-label": "Live run" }, el("h2", null, el("span", { class: "live", "aria-hidden": "true" }), " Live: " + (s.lastRun.phase || "run") + " " + s.lastRun.runId), liveRun(slug, s.lastRun.runId)) : null));
		}).catch(fail);
		timers.push(setInterval(function () {
			api("/api/sites/" + encodeURIComponent(slug)).then(function (d) {
				// a new run started: re-render so its live log appears
				var cur = document.querySelector("[data-run]");
				if (d.summary.lastRun && !d.summary.lastRun.finished && (!cur || cur.getAttribute("data-run") !== d.summary.lastRun.runId)) route();
			}).catch(function () {});
		}, 5000));
	}

	// ── runs ─────────────────────────────────────────────────────────────────────────────────────
	function runs(slug, runId) {
		api("/api/sites/" + encodeURIComponent(slug) + "/runs").then(function (list) {
			setCrumbs([{ text: "Portfolio", href: "#/" }, { text: slug, href: "#/site/" + encodeURIComponent(slug) }, { text: "Runs" }]);
			var sel = runId || (list[0] && list[0].runId);
			var base = "#/site/" + encodeURIComponent(slug) + "/runs/";
			show(el("div", null,
				el("div", { class: "head" }, el("h1", { text: "Runs" })),
				tabs(slug, "runs"),
				list.length ? el("div", { class: "viewer" },
					el("nav", { class: "card pages", "aria-label": "Runs" }, list.map(function (r) {
						return el("div", { class: "pg" }, el("a", { href: base + encodeURIComponent(r.runId), class: "path", "aria-current": r.runId === sel ? "true" : null, text: (r.phase || "?") + (r.preview ? " (preview)" : "") }),
							el("div", { class: "row small" }, !r.finished ? pill("running", "running") : r.ok ? pill("passed") : pill("failed"), el("span", { class: "muted", text: ago(r.lastEventAt || r.startedAt) })));
					})),
					el("section", { class: "card" }, el("h2", { text: "Run " + sel }), liveRun(slug, sel))) : el("p", { class: "muted", text: "No runs yet." })));
		}).catch(fail);
	}

	function liveRun(slug, runId) {
		var steps = {}, order = [];
		var stepsBox = el("div", { class: "steps" });
		var log = el("div", { class: "log", role: "log", "aria-live": "polite" });
		var status = el("p", { class: "small muted", text: "Connecting…" });
		var box = el("div", { "data-run": runId }, status, stepsBox, el("h3", { text: "Log" }), log);
		function drawSteps() {
			clear(stepsBox);
			order.forEach(function (name) {
				var s = steps[name];
				append(stepsBox, el("div", { class: "st" },
					el("div", { class: "row spread" }, el("b", { text: name }), s.ok === undefined ? pill("running", s.total ? s.done + "/" + s.total : "running") : s.ok ? pill("passed", "done") : pill("failed", "failed")),
					s.ok === undefined && s.total ? el("progress", { max: s.total, value: s.done }) : null,
					s.item && s.ok === undefined ? el("div", { class: "small muted", text: s.item }) : null,
					s.detail ? el("div", { class: "small muted", text: s.detail }) : null));
			});
		}
		var es = new EventSource("/api/sites/" + encodeURIComponent(slug) + "/runs/" + encodeURIComponent(runId) + "/stream");
		sources.push(es);
		es.onopen = function () { status.textContent = "Streaming from runs/" + runId + ".jsonl"; };
		es.onerror = function () { status.textContent = "Stream disconnected (retrying)…"; };
		es.addEventListener("progress", function (msg) {
			var e;
			try { e = JSON.parse(msg.data); } catch (x) { return; }
			var t = e.at ? e.at.slice(11, 19) + "  " : "";
			if (e.type === "step:start") { if (!steps[e.step]) order.push(e.step); steps[e.step] = { done: 0, total: e.total }; drawSteps(); }
			else if (e.type === "step:progress") { var s = steps[e.step] || (order.push(e.step), steps[e.step] = {}); s.done = e.done; s.total = e.total || s.total; s.item = e.item; drawSteps(); }
			else if (e.type === "step:end") { var s2 = steps[e.step] || (order.push(e.step), steps[e.step] = {}); s2.ok = e.ok; s2.detail = e.detail; drawSteps(); append(log, el("div", { class: e.ok ? "" : "error", text: t + (e.ok ? "✔ " : "✖ ") + e.step + (e.detail ? " — " + e.detail : "") })); }
			else if (e.type === "log") append(log, el("div", { class: e.level === "info" ? "" : e.level, text: t + e.message }));
			else if (e.type === "phase:start") append(log, el("div", { text: t + "▶ " + e.phase }));
			else if (e.type === "phase:end") { append(log, el("div", { class: e.ok ? "" : "error", text: t + (e.ok ? "✔ " : "✖ ") + e.phase + (e.ok ? " gate passed" : " gate failed") })); status.textContent = "Finished — " + (e.ok ? "gate passed" : "gate failed"); }
			while (log.childNodes.length > 500) log.removeChild(log.firstChild);
			log.scrollTop = log.scrollHeight;
		});
		return box;
	}

	// ── visual ───────────────────────────────────────────────────────────────────────────────────
	var mode = "slider";
	function visual(slug, pageName, vp) {
		api("/api/sites/" + encodeURIComponent(slug) + "/visual").then(function (v) {
			setCrumbs([{ text: "Portfolio", href: "#/" }, { text: slug, href: "#/site/" + encodeURIComponent(slug) }, { text: "Visual diff" }]);
			if (!v.available) return show(el("div", null, el("div", { class: "head" }, el("h1", { text: "Visual diff" })), tabs(slug, "visual"), el("p", { class: "card", text: "No verify report yet. Run: pnpm wp2emdash run " + slug + " verify" })));
			var page = v.pages.find(function (p) { return p.name === pageName; }) || v.pages.find(function (p) { return p.viewports.some(function (x) { return x.over; }); }) || v.pages[0];
			var view = page && (page.viewports.find(function (x) { return x.viewport === vp; }) || page.viewports.find(function (x) { return x.over; }) || page.viewports[0]);
			var base = "#/site/" + encodeURIComponent(slug) + "/visual/";
			var overCount = 0, total = 0;
			v.pages.forEach(function (p) { p.viewports.forEach(function (x) { total++; if (x.over) overCount++; }); });
			show(el("div", null,
				el("div", { class: "head" },
					el("div", null, el("h1", { text: "Visual diff" }), el("p", { class: "muted", text: "WordPress (audit snapshot) vs " + v.target + " · " + ago(v.ranAt) + " · limit " + pct(v.visualLimit) + " · " + overCount + " of " + total + " page views over" }))),
				tabs(slug, "visual"),
				el("div", { class: "viewer" },
					el("nav", { class: "card pages", "aria-label": "Pages and viewports" }, v.pages.map(function (p) {
						return el("div", { class: "pg" }, el("div", { class: "path", text: p.path }), el("div", { class: "chips" }, p.viewports.map(function (x) {
							var cur = page && p.name === page.name && view && x.viewport === view.viewport;
							return el("a", { class: "chip " + (x.over ? "over" : "within"), href: base + encodeURIComponent(p.name) + "/" + encodeURIComponent(x.viewport), "aria-current": cur ? "true" : null, title: x.decision ? "Decision: " + x.decision.decision : null },
								x.viewport + " " + pct(x.ratio), x.decision ? el("span", { class: "d", "aria-label": x.decision.decision, text: x.decision.decision === "approved" ? "✓" : "✗" }) : null);
						})));
					})),
					page && view ? pageView(slug, v, page, view) : el("p", { class: "card", text: "No pages in the report." }))));
		}).catch(fail);
	}

	function stageFor(view, page) {
		var stage = el("div", { class: "stage " + mode });
		var img = function (src, alt) { return src ? el("img", { src: src, alt: alt, loading: "lazy", decoding: "async" }) : el("div", { class: "missing", text: "Screenshot missing: " + alt }); };
		append(stage, [
			el("div", { class: "pane old" }, el("span", { class: "tag", text: "WordPress" }), img(view.images.source, "WordPress " + page.path + " " + view.viewport)),
			el("div", { class: "pane new" }, el("span", { class: "tag", text: "EmDash" }), img(view.images.target, "EmDash " + page.path + " " + view.viewport)),
			el("div", { class: "pane diffimg" }, img(view.images.diff, "Pixel difference " + page.path + " " + view.viewport)),
			el("div", { class: "handle", "aria-hidden": "true" }),
		]);
		return stage;
	}

	function pageView(slug, v, page, view) {
		var stage = stageFor(view, page);
		var range = el("input", { type: "range", class: "range", min: 0, max: 100, value: 50, "aria-label": "Reveal WordPress / EmDash" });
		range.addEventListener("input", function () { stage.style.setProperty("--pos", range.value + "%"); });
		var modes = [["slider", "Slider"], ["side", "Side by side"], ["diff", "Pixel diff"]];
		var modeBar = el("div", { class: "seg", role: "group", "aria-label": "Comparison mode" }, modes.map(function (m) {
			return el("button", { type: "button", "aria-pressed": m[0] === mode ? "true" : "false", onclick: function (e) {
				mode = m[0];
				stage.className = "stage " + mode;
				range.hidden = mode !== "slider";
				Array.prototype.forEach.call(modeBar.children, function (b) { b.setAttribute("aria-pressed", "false"); });
				e.currentTarget.setAttribute("aria-pressed", "true");
			} }, m[1]);
		}));
		range.hidden = mode !== "slider";
		return el("div", { class: "grid" },
			el("section", { class: "card" },
				el("div", { class: "row spread" },
					el("div", null, el("h2", { text: page.path + " · " + view.viewport }),
						el("div", { class: "small muted" }, "Difference ", el("b", { class: view.over ? "err" : "", text: pct(view.ratio) }), " over " + view.comparedHeight + " px · height " + view.sourceHeight + " → " + view.targetHeight + " px · ",
							el("a", { href: page.sourceUrl, target: "_blank", rel: "noopener noreferrer", text: "WordPress ↗" }), " ", el("a", { href: page.targetUrl, target: "_blank", rel: "noopener noreferrer", text: "EmDash ↗" })),
						view.error ? el("p", { class: "err", text: view.error }) : null),
					modeBar),
				el("div", { class: "spacer" }), stage, range),
			el("div", { class: "grid two" }, sectionsCard(view), decisionCard(slug, v, page, view)));
	}

	function sectionsCard(view) {
		if (!view.sections.length) return el("section", { class: "card" }, el("h2", { text: "Sections" }), el("p", { class: "muted small", text: "No section comparison for this view." }));
		var sorted = view.sections.slice().sort(function (a, b) { return b.ratio - a.ratio; });
		var th = function (t) { return el("th", { scope: "col", text: t }); };
		var thumb = function (src, alt) { return src ? el("a", { href: src, target: "_blank", rel: "noopener" }, el("img", { class: "thumb", src: src, alt: alt, loading: "lazy" })) : "—"; };
		return el("section", { class: "card" },
			el("h2", { text: "Sections (" + sorted.filter(function (s) { return !s.over; }).length + "/" + sorted.length + " within limit)" }),
			el("div", { class: "table-wrap" }, el("table", null,
				el("thead", null, el("tr", null, th("Section"), th("Difference"), th("WordPress"), th("EmDash"), th("Diff"))),
				el("tbody", null, sorted.map(function (s) {
					var imgs = s.images || {};
					return el("tr", null,
						el("th", { scope: "row" }, s.label, el("div", { class: "small muted", text: s.types.join(" + ") + " · " + s.sourceHeight + " → " + s.targetHeight + " px" })),
						el("td", { class: s.over ? "bad" : "ok" }, pct(s.ratio), s.note ? el("div", { class: "small muted", text: s.note }) : null, s.still ? el("div", { class: "small muted", text: "moving photos greyed" }) : null),
						el("td", null, thumb(imgs.source, "WordPress " + s.label)), el("td", null, thumb(imgs.target, "EmDash " + s.label)), el("td", null, thumb(imgs.diff, "Difference " + s.label)));
				})))));
	}

	function decisionCard(slug, v, page, view) {
		var msg = el("p", { class: "small", role: "status" });
		var reason = el("textarea", { id: "reason", required: true, minlength: 10, maxlength: 1000 });
		var by = el("input", { type: "text", id: "by", required: true, maxlength: 120, autocomplete: "name" });
		function submit(decision) {
			msg.className = "small"; msg.textContent = "Saving…";
			api("/api/sites/" + encodeURIComponent(slug) + "/visual-decisions", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ path: page.path, viewport: view.viewport, decision: decision, reason: reason.value, by: by.value }) })
				.then(function () { msg.textContent = "Recorded in decisions.md."; setTimeout(route, 600); })
				.catch(function (e) { msg.className = "err"; msg.textContent = e.message; });
		}
		var d = view.decision;
		return el("section", { class: "card", "aria-labelledby": "dec" },
			el("h2", { id: "dec", text: "Decision for this page view" }),
			d ? el("p", { class: "notice" + (d.decision === "approved" ? " ok" : "") }, el("b", { text: d.decision === "approved" ? "Approved" : "Rejected" }), " on " + d.date + " by " + d.by + ": " + d.reason) : el("p", { class: "muted small", text: "No decision recorded yet." }),
			el("label", { for: "reason", text: "Reason (recorded verbatim, at least 10 characters)" }), reason,
			el("label", { for: "by", text: "Decided by" }), by,
			el("div", { class: "row", }, el("button", { type: "button", class: "primary", onclick: function () { submit("approve"); } }, "Approve difference"), el("button", { type: "button", class: "danger", onclick: function () { submit("reject"); } }, "Reject — must be fixed")),
			msg,
			el("p", { class: "small muted", text: "This appends a dated row to decisions.md. It does not accept the verify gate." }),
			v.verifyGate.acceptCommand ? el("div", null, el("p", { class: "small", text: "The verify gate is failed. Once the owner has decided every difference, the owner accepts the gate in the terminal:" }), fixLine(v.verifyGate.acceptCommand))
				: el("p", { class: "small muted", text: "Verify gate: " + v.verifyGate.status + "." }));
	}

	// ── router ───────────────────────────────────────────────────────────────────────────────────
	function route() {
		stopAll();
		var parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(function (s) { try { return decodeURIComponent(s); } catch (e) { return ""; } });
		if (parts[0] === "site" && parts[1]) {
			if (parts[2] === "visual") return visual(parts[1], parts[3], parts[4]);
			if (parts[2] === "runs") return runs(parts[1], parts[3]);
			return overview(parts[1]);
		}
		return portfolio();
	}
	window.addEventListener("hashchange", function () { route(); app.focus({ preventScroll: true }); });
	route();
})();
