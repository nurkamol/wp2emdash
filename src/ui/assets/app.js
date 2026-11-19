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
				el("dt", { text: "Last run" }), el("dd", null, runLine(s.lastRun)),
				el("dt", { text: "Approvals" }), el("dd", null, s.pendingProposals ? el("a", { href: href + "/approvals", text: s.pendingProposals + " waiting" }) : el("span", { class: "muted", text: "none waiting" }))),
			blockers.length ? el("details", null, el("summary", { text: blockers.length + " blocker" + (blockers.length === 1 ? "" : "s") }),
				el("ul", { class: "list small" }, blockers.slice(0, 6).map(function (b) { return el("li", null, el("b", { text: b.label }), b.detail ? el("span", { class: "muted", text: " — " + b.detail }) : null); }),
					blockers.length > 6 ? el("li", null, el("a", { href: href, text: "+" + (blockers.length - 6) + " more" })) : null)) : el("p", { class: "small", text: "Nothing blocks launch." }),
			el("div", { class: "row" }, el("a", { href: href, text: "Overview" }), el("a", { href: href + "/visual", text: "Visual diff" }), el("a", { href: href + "/runs", text: "Runs" })));
	}

	// ── site ─────────────────────────────────────────────────────────────────────────────────────
	function tabs(slug, active) {
		var base = "#/site/" + encodeURIComponent(slug);
		var t = [["overview", base, "Overview"], ["visual", base + "/visual", "Visual diff"], ["inspect", base + "/inspect", "Inspector"], ["approvals", base + "/approvals", "Approvals"], ["secrets", base + "/secrets", "Secrets"], ["checklist", base + "/checklist", "Checklist"], ["cockpit", base + "/cockpit", "Launch"], ["runs", base + "/runs", "Runs"]];
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
							el("a", { href: page.sourceUrl, target: "_blank", rel: "noopener noreferrer", text: "WordPress ↗" }), " ", el("a", { href: page.targetUrl, target: "_blank", rel: "noopener noreferrer", text: "EmDash ↗" }), " · ",
							el("a", { href: "#/site/" + encodeURIComponent(slug) + "/inspect/" + encodeURIComponent(page.name) + "/" + encodeURIComponent(view.viewport), text: "Inspect sections →" })),
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

	// ── shared bits for v2 views ─────────────────────────────────────────────────────────────────
	function siteHead(slug, title, tab, sub) {
		setCrumbs([{ text: "Portfolio", href: "#/" }, { text: slug, href: "#/site/" + encodeURIComponent(slug) }, { text: title }]);
		return [el("div", { class: "head" }, el("div", null, el("h1", { text: title }), sub ? el("p", { class: "muted", text: sub }) : null)), tabs(slug, tab)];
	}
	function postJson(path, body) {
		return api(path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) });
	}
	/** A unified diff as text lines (never HTML), coloured by line kind. */
	function diffView(patch) {
		return el("pre", { class: "diff", tabindex: "0", "aria-label": "Proposed change (unified diff)" }, String(patch || "").split("\n").map(function (l) {
			var k = l.slice(0, 3) === "+++" || l.slice(0, 3) === "---" ? "file" : l.charAt(0) === "+" ? "add" : l.charAt(0) === "-" ? "del" : l.slice(0, 2) === "@@" ? "hunk" : "";
			return el("span", { class: k, text: l + "\n" });
		}));
	}
	var lastName = "";
	function nameInput(id) {
		var i = el("input", { type: "text", id: id, required: true, maxlength: 120, autocomplete: "name", value: lastName || null });
		i.addEventListener("input", function () { lastName = i.value; });
		return i;
	}
	function statusPill(s) { return pill(s === "approved" ? "passed" : s === "rejected" || s === "failed" ? "failed" : "running", s); }

	// ── approvals ────────────────────────────────────────────────────────────────────────────────
	function approvals(slug) {
		api("/api/sites/" + encodeURIComponent(slug) + "/proposals").then(function (list) {
			var pending = list.filter(function (p) { return p.status === "pending"; });
			show(el("div", null, siteHead(slug, "Approval queue", "approvals", pending.length + " waiting · " + list.length + " in sites/" + slug + "/proposals/"),
				el("p", { class: "notice" }, "Claude proposes changes to ", el("code", { text: "overrides.ts" }), " or ", el("code", { text: "decisions.md" }), "; nothing changes until you approve. Approving applies the diff exactly as shown. It never accepts a gate."),
				list.length ? el("div", { class: "grid" }, list.map(function (p) { return proposalCard(slug, p); })) : el("p", { class: "card muted", text: "No proposals yet." })));
		}).catch(fail);
	}
	function proposalCard(slug, p) {
		var id = "p-" + p.id;
		var msg = el("p", { class: "small", role: "status" });
		var by = nameInput(id + "-by");
		var note = el("input", { type: "text", id: id + "-note", maxlength: 1000 });
		var rerun = p.previewable ? el("input", { type: "checkbox", id: id + "-rerun", checked: true }) : null;
		var after = el("div");
		function decide(kind) {
			msg.className = "small"; msg.textContent = "Saving…";
			postJson("/api/sites/" + encodeURIComponent(slug) + "/proposals/" + encodeURIComponent(p.id) + "/" + kind, { by: by.value, note: note.value, rerun: !!(rerun && rerun.checked) }).then(function (r) {
				var q = r.proposal;
				msg.textContent = q.status === "approved" ? "Approved: the change is in " + q.file + "." : q.status === "failed" ? "The patch no longer applies; marked failed. " + (q.note || "") : "Rejected.";
				if (q.status === "failed") msg.className = "err";
				clear(after);
				if (r.run && r.run.runId) append(after, el("h3", { text: "Preview run: " + r.run.phase }), liveRun(slug, r.run.runId));
				else if (r.run) append(after, el("p", { class: "small" }, "Preview run of " + r.run.phase + " started; it appears under ", el("a", { href: "#/site/" + encodeURIComponent(slug) + "/runs", text: "Runs" }), "."));
				if (r.runError) append(after, el("p", { class: "err", text: r.runError }));
				if (q.status === "approved" && q.command) append(after, el("p", { class: "small", text: "To record the gate, run in the terminal:" }), fixLine(q.command));
			}).catch(function (e) { msg.className = "err"; msg.textContent = e.message; });
		}
		return el("article", { class: "card proposal" },
			el("div", { class: "row spread" }, el("h2", { text: p.summary }), statusPill(p.status)),
			el("dl", { class: "kv small" },
				el("dt", { text: "File" }), el("dd", null, el("code", { text: p.file })),
				el("dt", { text: "Proposed by" }), el("dd", { text: p.by + " · " + ago(p.createdAt) }),
				el("dt", { text: "Rerun" }), el("dd", { text: p.rerun ? p.rerun + (p.previewable ? " (the dashboard can start a preview run)" : " (from the terminal)") : "none needed" }),
				p.decidedBy ? [el("dt", { text: "Decided" }), el("dd", { text: p.status + " by " + p.decidedBy + " · " + ago(p.decidedAt) + (p.note ? " — " + p.note : "") })] : null),
			el("details", { open: p.status === "pending" ? true : null }, el("summary", { text: "Change (" + p.file + ")" }), diffView(p.patch)),
			p.status === "pending" ? el("div", { class: "decide" },
				el("div", { class: "grid two" }, el("div", null, el("label", { for: id + "-by", text: "Decided by" }), by), el("div", null, el("label", { for: id + "-note", text: "Note (optional)" }), note)),
				rerun ? el("label", { class: "check", for: id + "-rerun" }, rerun, " After approving, start a preview run of " + p.rerun + " (gate not recorded)") : p.command ? el("p", { class: "small muted", text: "After approving, rerun from the terminal: " + p.command }) : null,
				el("div", { class: "row" }, el("button", { type: "button", class: "primary", onclick: function () { decide("approve"); } }, "Approve and apply"), el("button", { type: "button", class: "danger", onclick: function () { decide("reject"); } }, "Reject")),
				msg, after) : (p.status === "approved" && p.command ? el("div", null, el("p", { class: "small muted", text: "Rerun to record the gate:" }), fixLine(p.command)) : null));
	}

	// ── secrets ──────────────────────────────────────────────────────────────────────────────────
	var GROUPS = { wordpress: "WordPress (extract)", emdash: "EmDash", email: "Email", production: "Production", "go-live": "Go-live (cutover only)" };
	function secrets(slug) {
		api("/api/sites/" + encodeURIComponent(slug) + "/secrets").then(function (s) {
			show(el("div", null, siteHead(slug, "Secrets", "secrets", "Written to " + s.file + " (gitignored, mode 600)"),
				el("p", { class: "notice" }, "Values are write-only: they are saved to ", el("code", { text: s.file }), " and never shown again, logged, streamed or sent to Claude. The page shows only whether a key is set and a short fingerprint (first 8 hex of its SHA-256), so you can tell two values apart."),
				s.reminders.length ? el("div", { class: "notice warn-box", role: "note" }, el("b", { text: "Revocation reminders" }), el("ul", { class: "list small" }, s.reminders.map(function (r) { return el("li", { text: r }); }))) : null,
				Object.keys(GROUPS).map(function (g) {
					var keys = s.keys.filter(function (k) { return k.group === g; });
					if (!keys.length) return null;
					return el("section", { class: "card secrets", "aria-label": GROUPS[g] }, el("h2", { text: GROUPS[g] }), keys.map(function (k) { return secretRow(slug, k); }));
				})));
		}).catch(fail);
	}
	function secretRow(slug, k) {
		var id = "s-" + k.key;
		var input = el("input", { type: "password", id: id, autocomplete: "off", spellcheck: "false", maxlength: 4096, "aria-describedby": id + "-help" });
		var state = el("span", null, k.set ? pill("passed", "set") : pill("pending", "not set"), k.fingerprint ? el("code", { class: "fp", title: "First 8 hex of SHA-256", text: k.fingerprint }) : null);
		var msg = el("span", { class: "small", role: "status" });
		function save() {
			if (/[\r\n]/.test(input.value)) { msg.className = "err"; msg.textContent = "Line breaks are not allowed."; return; }
			msg.className = "small"; msg.textContent = "Saving…";
			var value = input.value;
			input.value = "";
			postJson("/api/sites/" + encodeURIComponent(slug) + "/secrets", { key: k.key, value: value }).then(function (r) {
				value = "";
				clear(state); append(state, [pill("passed", "set"), el("code", { class: "fp", text: r.fingerprint })]);
				msg.textContent = "Saved.";
			}).catch(function (e) { value = ""; msg.className = "err"; msg.textContent = e.message; });
		}
		input.addEventListener("keydown", function (e) { if (e.key === "Enter") { e.preventDefault(); save(); } });
		return el("div", { class: "secret" },
			el("div", { class: "row spread" }, el("label", { for: id }, el("b", { text: k.label }), " ", el("code", { text: k.key })), state),
			el("p", { class: "small muted", id: id + "-help", text: k.help + (k.format ? " Format: " + k.format + "." : "") }),
			el("div", { class: "row" }, input, el("button", { type: "button", class: "primary", onclick: save }, k.set ? "Replace" : "Save"), msg));
	}

	// ── section inspector ────────────────────────────────────────────────────────────────────────
	function inspector(slug, pageName, vp) {
		if (!pageName) {
			return api("/api/sites/" + encodeURIComponent(slug) + "/visual").then(function (v) {
				var first = v.pages && v.pages[0];
				if (first && first.viewports[0]) { location.replace("#/site/" + encodeURIComponent(slug) + "/inspect/" + encodeURIComponent(first.name) + "/" + encodeURIComponent(first.viewports[0].viewport)); return; }
				show(el("div", null, siteHead(slug, "Section inspector", "inspect"), el("p", { class: "card", text: "No verify report yet. Run: pnpm wp2emdash run " + slug + " verify" })));
			}).catch(fail);
		}
		Promise.all([api("/api/sites/" + encodeURIComponent(slug) + "/inspect/" + encodeURIComponent(pageName) + "/" + encodeURIComponent(vp)), api("/api/sites/" + encodeURIComponent(slug) + "/visual")]).then(function (res) {
			var d = res[0], v = res[1];
			var base = "#/site/" + encodeURIComponent(slug) + "/inspect/";
			var detail = el("section", { class: "card", "aria-live": "polite" }, el("p", { class: "muted", text: "Click a row on the WordPress screenshot (or pick one below) to see what it became." }));
			var canvas = el("div", { class: "shot" });
			var img = d.sourceImage ? el("img", { src: d.sourceImage, alt: "WordPress " + d.page.path + " " + d.viewport }) : el("div", { class: "missing", text: "Audit screenshot missing" });
			append(canvas, img);
			var buttons = [];
			function select(i) {
				buttons.forEach(function (b, k) { b.setAttribute("aria-pressed", k === i ? "true" : "false"); });
				clear(detail); append(detail, regionDetail(slug, d, d.regions[i]));
			}
			function place() {
				var h = d.pageHeight || img.naturalHeight || 1;
				d.regions.forEach(function (r, i) {
					var b = buttons[i];
					b.style.setProperty("top", (100 * r.y / h) + "%");
					b.style.setProperty("height", Math.max(0.4, 100 * r.height / h) + "%");
				});
			}
			d.regions.forEach(function (r, i) {
				var cls = "region" + (r.verify ? (r.verify.over ? " over" : " within") : "");
				var b = el("button", { type: "button", class: cls, "aria-pressed": "false", "aria-label": r.label + (r.verify ? ", difference " + pct(r.verify.ratio) : ""), onclick: function () { select(i); } }, el("span", { text: r.label + (r.verify ? " · " + pct(r.verify.ratio) : "") }));
				buttons.push(b); append(canvas, b);
			});
			if (img.tagName === "IMG") { if (img.complete) place(); else img.addEventListener("load", place); }
			place();
			var inRegion = {};
			d.regions.forEach(function (r) { r.sections.forEach(function (k) { inRegion[k] = true; }); });
			var others = d.sections.map(function (s, k) { return k; }).filter(function (k) { return !inRegion[k]; });
			show(el("div", null, siteHead(slug, "Section inspector", "inspect", d.page.path + " · " + d.viewport + (d.page.irFile ? " · " + d.page.irFile : "")),
				el("div", { class: "row pickers" },
					el("label", { for: "ins-page", class: "inline", text: "Page" }),
					el("select", { id: "ins-page", onchange: function (e) { var p = v.pages.find(function (x) { return x.name === e.target.value; }); location.hash = base + encodeURIComponent(p.name) + "/" + encodeURIComponent((p.viewports.find(function (x) { return x.viewport === d.viewport; }) || p.viewports[0]).viewport); } },
						v.pages.map(function (p) { return el("option", { value: p.name, selected: p.name === d.page.name ? true : null, text: p.path }); })),
					el("div", { class: "seg", role: "group", "aria-label": "Viewport" }, d.viewports.map(function (x) { return el("a", { class: "chip", href: base + encodeURIComponent(d.page.name) + "/" + encodeURIComponent(x), "aria-current": x === d.viewport ? "true" : null, text: x }); }))),
				d.notes.length ? el("ul", { class: "notice list small" }, d.notes.map(function (n) { return el("li", { text: n }); })) : null,
				el("div", { class: "inspect" },
					el("section", { class: "card" }, el("h2", { text: "WordPress (audit screenshot)" }), canvas),
					el("div", { class: "grid" }, detail,
						others.length ? el("section", { class: "card" }, el("h2", { text: "Sections without a row box" }), el("p", { class: "small muted", text: "Footer rows or pages the audit could not measure row by row (e.g. Gutenberg)." }),
							el("div", { class: "grid" }, others.map(function (k) { return sectionCard(slug, d, d.sections[k]); }))) : null))));
		}).catch(fail);
	}
	function regionDetail(slug, d, r) {
		var imgs = (r.verify && r.verify.images) || {};
		var crop = function (src, alt) { return src ? el("a", { href: src, target: "_blank", rel: "noopener" }, el("img", { class: "crop", src: src, alt: alt, loading: "lazy" })) : el("div", { class: "missing small", text: "no crop" }); };
		return el("div", null,
			el("div", { class: "row spread" }, el("h2", { text: (r.footer ? "Footer " : "") + "row " + (r.index + 1) }), r.verify ? pill(r.verify.over ? "failed" : "passed", pct(r.verify.ratio)) : pill("pending", "not compared")),
			r.verify && r.verify.note ? el("p", { class: "small muted", text: r.verify.note }) : null,
			r.verify ? el("div", { class: "crops" }, el("figure", null, crop(imgs.source, "WordPress crop " + r.label), el("figcaption", { text: "WordPress" })), el("figure", null, crop(imgs.target, "Staging crop " + r.label), el("figcaption", { text: "EmDash (" + r.verify.types.join(" + ") + ")" })), el("figure", null, crop(imgs.diff, "Difference " + r.label), el("figcaption", { text: "Difference" }))) : null,
			r.sections.length ? el("div", { class: "grid" }, r.sections.map(function (k) { return sectionCard(slug, d, d.sections[k]); })) : el("p", { class: "muted small", text: "No IR section came from this row (dropped, decorative, or not paired)." }));
	}
	function sectionCard(slug, d, s) {
		var id = "sec-" + (s.footer ? "f" : "p") + s.index;
		var sel = el("select", { id: id + "-type" }, d.sectionTypes.map(function (t) { return el("option", { value: t, selected: t === s.type ? true : null, text: t }); }));
		var by = nameInput(id + "-by");
		var note = el("input", { type: "text", id: id + "-note", maxlength: 500 });
		var msg = el("p", { class: "small", role: "status" });
		function propose(action) {
			msg.className = "small"; msg.textContent = "Creating proposal…";
			postJson("/api/sites/" + encodeURIComponent(slug) + "/inspect/" + encodeURIComponent(d.page.name) + "/" + encodeURIComponent(d.viewport) + "/proposals", { section: s.index, footer: s.footer, action: action, type: sel.value, by: by.value, note: note.value })
				.then(function () { clear(msg); append(msg, "Proposal created. Review and approve it in ", el("a", { href: "#/site/" + encodeURIComponent(slug) + "/approvals", text: "Approvals" }), "; transform reruns after approval."); })
				.catch(function (e) { msg.className = "err"; msg.textContent = e.message; });
		}
		return el("article", { class: "sec" },
			el("div", { class: "row spread" }, el("b", { text: (s.footer ? "Footer · " : "") + "#" + (s.index + 1) + " " + s.type }), el("code", { class: "small", text: s.path || "(no source path)" })),
			el("p", { class: "small muted" }, "overrides.ts key ", el("code", { text: s.overrideKey }), s.override ? el("span", null, " · currently forced to ", el("b", { text: s.override })) : null),
			el("details", null, el("summary", { text: "WordPress source" }), s.raw ? [el("p", { class: "small muted", text: s.raw.note }), s.raw.text ? el("pre", { class: "code", tabindex: "0", text: s.raw.text }) : null] : el("p", { class: "small muted", text: "Raw source not available for this row." })),
			el("details", null, el("summary", { text: "IR section (JSON)" }), el("pre", { class: "code", tabindex: "0", text: JSON.stringify(s.json, null, 2) })),
			el("details", null, el("summary", { text: "Change this section (creates a proposal)" }),
				el("div", { class: "grid two" }, el("div", null, el("label", { for: id + "-type", text: "Section type" }), sel), el("div", null, el("label", { for: id + "-by", text: "Proposed by" }), by)),
				el("label", { for: id + "-note", text: "Why (optional, goes into the summary)" }), note,
				el("div", { class: "row spacer-t" }, el("button", { type: "button", class: "primary", onclick: function () { propose("type"); } }, "Propose type change"), el("button", { type: "button", class: "danger", onclick: function () { propose("drop"); } }, "Propose dropping the row")),
				el("p", { class: "small muted", text: "Applies to the whole WordPress row (" + s.overrideKey + "). Nothing changes until the proposal is approved." }), msg));
	}

	// ── launch cockpit ───────────────────────────────────────────────────────────────────────────
	function checkList(items) {
		return el("ul", { class: "list small" }, items.map(function (c) { return el("li", null, pill(c.ok ? "passed" : "failed", c.ok ? "ok" : "fail"), " ", el("span", { text: c.label }), c.detail ? el("div", { class: "muted", text: c.detail }) : null); }));
	}
	function cockpit(slug) {
		api("/api/sites/" + encodeURIComponent(slug) + "/cockpit").then(function (c) {
			var pf = c.preflight;
			show(el("div", null, siteHead(slug, "Launch cockpit", "cockpit", "Read-only"),
				el("p", { class: "notice warn-box", role: "note" }, el("b", { text: "No switch here. " }), c.note),
				el("div", { class: "grid two" },
					el("section", { class: "card" }, el("h2", { text: "Go-live prerequisites" }), checkList(c.prerequisites)),
					el("section", { class: "card" },
						el("div", { class: "row spread" }, el("h2", { text: "Last cutover preflight" }), pf.source === "none" ? pill("pending", "not run") : pill(pf.ok ? "passed" : "failed", pf.ok ? "passed" : "failed")),
						el("p", { class: "small muted", text: pf.source === "state" ? "Recorded gate (state.json)" + (pf.ranAt ? " · " + ago(pf.ranAt) : "") : pf.source === "run-log" ? "Run " + pf.runId + (pf.ranAt ? " · " + ago(pf.ranAt) : "") : "" }),
						pf.note ? el("p", { class: "small", text: pf.note }) : null,
						pf.checks.length ? checkList(pf.checks) : null)),
				el("section", { class: "card" }, el("h2", { text: "Commands (run them in the terminal)" }), el("ul", { class: "list" }, c.commands.map(function (x) { return el("li", null, el("div", { class: "small", text: x.label }), fixLine(x.command)); }))),
				el("section", { class: "card" }, el("h2", { text: "Runbook" }),
					c.runbook ? [el("p", { class: "small muted", text: c.runbook.path + " · generated " + ago(c.runbook.modifiedAt) + (c.runbook.truncated ? " · truncated" : "") }), el("pre", { class: "code runbook", tabindex: "0", text: c.runbook.text })]
						: el("p", { class: "muted", text: "No runbook yet: run the cutover preflight (pnpm wp2emdash run " + slug + " cutover --preview)." }))));
		}).catch(fail);
	}

	// ── owner checklist ──────────────────────────────────────────────────────────────────────────
	function checklist(slug) {
		api("/api/sites/" + encodeURIComponent(slug) + "/checklist").then(function (c) {
			if (!c.available) return show(el("div", null, siteHead(slug, "Owner checklist", "checklist"), el("p", { class: "card muted", text: "No " + c.file + " yet (created by wp2emdash init)." })));
			show(el("div", null, siteHead(slug, "Owner checklist", "checklist", c.counts.done + " of " + c.counts.total + " done · " + c.counts.requiredOpen + " required open"),
				el("p", { class: "notice" }, "Read-only view of ", el("code", { text: c.file }), ". Tick items in the file (", el("code", { text: "- [x]" }), "); items marked required block the pipeline. Never write passwords in it — use the Secrets tab."),
				el("div", { class: "grid cards" }, c.sections.filter(function (s) { return s.items.length || s.notes.length; }).map(function (s) {
					var open = s.items.filter(function (i) { return !i.done; }).length;
					return el("section", { class: "card" + (s.pluginData ? " plugin" : "") },
						el("div", { class: "row spread" }, el("h2", { text: s.heading || "Notes" }), s.items.length ? pill(open ? "pending" : "passed", s.items.length - open + "/" + s.items.length) : null),
						s.notes.map(function (n) { return el("p", { class: "small muted", text: n }); }),
						s.items.length ? el("ul", { class: "checks" }, s.items.map(function (i) {
							return el("li", { class: i.done ? "done" : "" }, el("span", { class: "box", "aria-hidden": "true", text: i.done ? "✓" : "" }), el("span", { class: "sr", text: i.done ? "Done: " : "Open: " }), el("span", { text: i.text }), i.required ? el("span", { class: "req", text: "required" }) : null);
						})) : null);
				}))));
		}).catch(fail);
	}

	// ── router ───────────────────────────────────────────────────────────────────────────────────
	function route() {
		stopAll();
		var parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(function (s) { try { return decodeURIComponent(s); } catch (e) { return ""; } });
		if (parts[0] === "site" && parts[1]) {
			if (parts[2] === "visual") return visual(parts[1], parts[3], parts[4]);
			if (parts[2] === "runs") return runs(parts[1], parts[3]);
			if (parts[2] === "approvals") return approvals(parts[1]);
			if (parts[2] === "secrets") return secrets(parts[1]);
			if (parts[2] === "inspect") return inspector(parts[1], parts[3], parts[4]);
			if (parts[2] === "cockpit") return cockpit(parts[1]);
			if (parts[2] === "checklist") return checklist(parts[1]);
			return overview(parts[1]);
		}
		return portfolio();
	}
	window.addEventListener("hashchange", function () { route(); app.focus({ preventScroll: true }); });
	route();
})();
