/**
 * `wp2emdash ui` — the local dashboard server (docs/PLAN.md §10b). node:http only.
 *
 * Safety model:
 * - binds 127.0.0.1 only, random free port; the Host header must be 127.0.0.1:<port> or localhost:<port>
 *   (DNS-rebinding guard);
 * - a random token per server run is required on every request: `?t=<token>` on the first load sets an
 *   HttpOnly, SameSite=Strict cookie, every later request must carry the cookie (or the query token);
 * - POSTs also need a same-origin Origin header (when the browser sends one) and a JSON body;
 * - files are served only from inside the site's reports/ and snapshot/screens/ (no traversal, no symlinks out);
 * - POSTs also refuse a cross-site Sec-Fetch-Site;
 * - writes are limited to: visual decisions appended to decisions.md; approving / rejecting proposals in
 *   sites/<slug>/proposals/ (approve applies the proposal's patch to overrides.ts or decisions.md); new proposals from
 *   the section inspector; one allow-listed key at a time in sites/<slug>/.env (values are write-only: never returned,
 *   logged or streamed). After an approval it may start a *preview* run of transform, scaffold or verify — never load,
 *   never cutover, never Cloudflare, routes or DNS.
 */
import { spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, createReadStream, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { KIT_ROOT, SITES_DIR, sitePaths } from "../core/paths.js";
import { isProposalId } from "../core/proposals.js";
import { checklistView, cockpitView } from "./cockpit.js";
import { appendVisualDecision, isRunId, isSiteSlug, listRuns, portfolio, readiness, runFile, runHistory, SERVABLE_ROOTS, siteMeta, siteSummary, UserError, visualReport } from "./data.js";
import { inspectorView, proposeSectionChange } from "./inspector.js";
import { appCss, appJs, indexHtml } from "./page.js";
import { canStartFromDashboard, type DashboardRerun, decideProposal, proposalsView } from "./queue.js";
import { secretsStatus, writeSecret } from "./secrets.js";

export interface UiServerOptions {
	sitesDir?: string;
	token?: string;
	port?: number;
	/** SSE poll interval for run logs (ms). */
	pollMs?: number;
	/** Starts a preview run after an approval (tests inject a stub). Default: a child `wp2emdash run <slug> <phase> --preview`. */
	startRun?: (slug: string, phase: DashboardRerun, sitesDir: string) => Promise<{ runId?: string }>;
}

/** Spawns `wp2emdash run <slug> <phase> --preview` and waits briefly for its run log to appear. */
export async function spawnPreviewRun(slug: string, phase: DashboardRerun, sitesDir: string): Promise<{ runId?: string }> {
	const before = new Set(listRuns(slug, sitesDir));
	const child = spawn(process.execPath, [join(KIT_ROOT, "bin", "wp2emdash.js"), "run", slug, phase, "--preview"], {
		cwd: KIT_ROOT,
		env: { ...process.env, WP2EMDASH_SITES_DIR: sitesDir },
		stdio: "ignore",
	});
	child.on("error", () => {});
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		const fresh = listRuns(slug, sitesDir).find((r) => !before.has(r));
		if (fresh) return { runId: fresh };
		if (child.exitCode !== null) break;
		await new Promise((r) => setTimeout(r, 150));
	}
	return {};
}

export interface UiServer {
	server: Server;
	port: number;
	token: string;
	url: string;
	close(): Promise<void>;
}

const MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
	".webm": "video/webm",
};

const SECURITY_HEADERS = {
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Cross-Origin-Resource-Policy": "same-origin",
	"Cache-Control": "no-store",
};

const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function sameToken(a: string | undefined, b: string): boolean {
	if (!a) return false;
	const x = Buffer.from(a);
	const y = Buffer.from(b);
	return x.length === y.length && timingSafeEqual(x, y);
}

function cookies(req: IncomingMessage): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}

/** Resolves `rel` (URL path segments under the site root) to a file inside an allowed root, or undefined. */
export function resolveServable(siteRoot: string, rel: string): string | undefined {
	if (!rel || rel.includes("\0") || isAbsolute(rel)) return undefined;
	const target = resolve(siteRoot, rel);
	for (const r of SERVABLE_ROOTS) {
		const base = resolve(siteRoot, r);
		const within = (p: string, b: string) => {
			const d = relative(b, p);
			return !!d && !d.startsWith("..") && !isAbsolute(d);
		};
		if (!within(target, base)) continue;
		if (!existsSync(target)) return undefined;
		// Follow symlinks and check again, so a link inside reports/ cannot point outside it.
		const real = realpathSync(target);
		const realBase = existsSync(base) ? realpathSync(base) : base;
		if (!within(real, realBase) || !statSync(real).isFile()) return undefined;
		return MIME[extname(real).toLowerCase()] ? real : undefined;
	}
	return undefined;
}

export function startUiServer(opts: UiServerOptions = {}): Promise<UiServer> {
	const sitesDir = opts.sitesDir ?? SITES_DIR;
	const token = opts.token ?? randomBytes(24).toString("base64url");
	const pollMs = opts.pollMs ?? 400;
	let port = 0;
	const cookieName = () => `wp2emdash_ui_${port}`;
	const streams = new Set<() => void>();
	const startRun = opts.startRun ?? spawnPreviewRun;
	/** Sites with a dashboard-started run in its first seconds (one at a time per site). */
	const running = new Set<string>();

	const send = (res: ServerResponse, status: number, body: string | Buffer, type: string, extra: Record<string, string> = {}) => {
		res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": type, "Content-Length": Buffer.byteLength(body), ...extra });
		res.end(body);
	};
	const json = (res: ServerResponse, status: number, data: unknown) => send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
	const text = (res: ServerResponse, status: number, msg: string) => send(res, status, msg, "text/plain; charset=utf-8");

	const handler = async (req: IncomingMessage, res: ServerResponse) => {
		const host = req.headers.host ?? "";
		if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return text(res, 421, "Wrong host");
		const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

		// ── Auth ──
		const q = url.searchParams.get("t");
		if (q !== null) {
			if (!sameToken(q, token)) return text(res, 401, "Invalid token. Open the URL printed by `wp2emdash ui`.");
			if (req.method === "GET" && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/files/")) {
				url.searchParams.delete("t");
				res.writeHead(302, {
					...SECURITY_HEADERS,
					"Set-Cookie": `${cookieName()}=${token}; HttpOnly; SameSite=Strict; Path=/`,
					Location: `${url.pathname}${url.search}`,
				});
				return res.end();
			}
		} else if (!sameToken(cookies(req)[cookieName()], token)) {
			return text(res, 401, "Unauthorized. Open the URL printed by `wp2emdash ui` (it carries a one-time token).");
		}

		const parts = url.pathname.split("/").filter(Boolean).map((s) => {
			try {
				return decodeURIComponent(s);
			} catch {
				return "\0";
			}
		});

		if (req.method === "POST") {
			const origin = req.headers.origin;
			if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return text(res, 403, "Cross-origin request refused");
			const fetchSite = req.headers["sec-fetch-site"];
			if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return text(res, 403, "Cross-site request refused");
			if (!(req.headers["content-type"] ?? "").startsWith("application/json")) return text(res, 415, "JSON only");
			if (parts[0] !== "api" || parts[1] !== "sites" || parts[2] === undefined) return text(res, 404, "Not found");
			const slug = parts[2];
			if (!isSiteSlug(slug, sitesDir)) return json(res, 404, { error: "Unknown site" });
			const body = async (limit = 16_384): Promise<Record<string, unknown> | undefined> => {
				try {
					const v = JSON.parse(await readBody(req, limit)) as unknown;
					return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
				} catch {
					return undefined;
				}
			};
			/** Input errors become 400 with their message (never containing a submitted secret). */
			const guarded = async (fn: () => Promise<void> | void) => {
				try {
					await fn();
				} catch (e) {
					if (e instanceof UserError) return json(res, 400, { error: e.message });
					throw e;
				}
			};
			// POST /api/sites/:slug/visual-decisions
			if (parts.length === 4 && parts[3] === "visual-decisions") {
				const b = await body();
				if (!b) return json(res, 400, { error: "Invalid JSON" });
				return guarded(async () => json(res, 200, { ok: true, decision: await appendVisualDecision(slug, b as never, sitesDir) }));
			}
			// POST /api/sites/:slug/secrets — write-only: the answer carries the key, "set" and the fingerprint, never the value.
			if (parts.length === 4 && parts[3] === "secrets") {
				const b = await body(8192);
				if (!b) return json(res, 400, { error: "Invalid JSON" });
				return guarded(() => json(res, 200, { ok: true, ...writeSecret(slug, b, sitesDir) }));
			}
			// POST /api/sites/:slug/proposals/:id/(approve|reject)
			if (parts.length === 6 && parts[3] === "proposals" && (parts[5] === "approve" || parts[5] === "reject")) {
				const id = parts[4] as string;
				if (!isProposalId(id)) return json(res, 404, { error: "Unknown proposal" });
				const b = await body();
				if (!b) return json(res, 400, { error: "Invalid JSON" });
				return guarded(async () => {
					const p = decideProposal(slug, id, parts[5] as "approve" | "reject", b, sitesDir);
					let run: { phase: string; runId?: string } | undefined;
					let runError: string | undefined;
					if (p.status === "approved" && b.rerun === true && canStartFromDashboard(p.rerun)) {
						if (running.has(slug)) runError = "A dashboard run was just started for this site; run this one from the terminal.";
						else {
							running.add(slug);
							setTimeout(() => running.delete(slug), 10_000).unref();
							try {
								run = { phase: p.rerun, ...(await startRun(slug, p.rerun, sitesDir)) };
							} catch (e) {
								runError = `Could not start the preview run: ${(e as Error).message}`;
							}
						}
					}
					json(res, 200, { ok: true, proposal: p, ...(run ? { run } : {}), ...(runError ? { runError } : {}) });
				});
			}
			// POST /api/sites/:slug/inspect/:page/:viewport/proposals
			if (parts.length === 7 && parts[3] === "inspect" && parts[6] === "proposals") {
				const b = await body();
				if (!b) return json(res, 400, { error: "Invalid JSON" });
				return guarded(async () => json(res, 200, { ok: true, proposal: await proposeSectionChange(slug, parts[4] as string, parts[5] as string, b, sitesDir) }));
			}
			return text(res, 404, "Not found");
		}
		if (req.method !== "GET" && req.method !== "HEAD") return text(res, 405, "Method not allowed");

		// ── Static shell ──
		if (url.pathname === "/") return send(res, 200, indexHtml(), "text/html; charset=utf-8", { "Content-Security-Policy": CSP });
		if (url.pathname === "/app.js") return send(res, 200, appJs(), "text/javascript; charset=utf-8");
		if (url.pathname === "/app.css") return send(res, 200, appCss(), "text/css; charset=utf-8");

		// ── API ──
		if (parts[0] === "api") {
			if (parts.length === 2 && parts[1] === "portfolio") return json(res, 200, await portfolio(sitesDir));
			if (parts[1] === "sites" && parts[2] !== undefined) {
				const slug = parts[2];
				if (!isSiteSlug(slug, sitesDir)) return json(res, 404, { error: "Unknown site" });
				if (parts.length === 3) return json(res, 200, { summary: await siteSummary(slug, sitesDir), readiness: readiness(slug, sitesDir) });
				if (parts.length === 4 && parts[3] === "visual") return json(res, 200, await visualReport(slug, sitesDir));
				if (parts.length === 4 && parts[3] === "runs") return json(res, 200, runHistory(slug, sitesDir));
				if (parts.length === 4 && parts[3] === "proposals") return json(res, 200, proposalsView(slug, sitesDir));
				if (parts.length === 4 && parts[3] === "secrets") return json(res, 200, secretsStatus(slug, sitesDir));
				if (parts.length === 4 && parts[3] === "cockpit") return json(res, 200, cockpitView(slug, sitesDir));
				if (parts.length === 4 && parts[3] === "checklist") return json(res, 200, checklistView(slug, sitesDir));
				if (parts.length === 6 && parts[3] === "inspect") {
					const v = await inspectorView(slug, parts[4] as string, parts[5] as string, sitesDir, (await siteMeta(slug, sitesDir)).visualLimit);
					return v ? json(res, 200, v) : json(res, 404, { error: "Unknown page or viewport" });
				}
				if (parts.length === 6 && parts[3] === "runs" && parts[5] === "stream") {
					const runId = parts[4] as string;
					const file = isRunId(runId) ? runFile(slug, runId, sitesDir) : undefined;
					if (!file) return json(res, 404, { error: "Unknown run" });
					return streamRun(req, res, file);
				}
			}
			return json(res, 404, { error: "Not found" });
		}

		// ── Report files ──  /files/<slug>/<path under the site root>
		if (parts[0] === "files" && parts.length >= 3) {
			const slug = parts[1] as string;
			if (!isSiteSlug(slug, sitesDir)) return text(res, 404, "Not found");
			const rel = parts.slice(2);
			if (rel.some((s) => s === ".." || s === "." || s.includes("/") || s.includes("\\") || s.includes("\0"))) return text(res, 403, "Refused");
			const file = resolveServable(sitePaths(slug, sitesDir).root, join(...rel));
			if (!file) return text(res, 404, "Not found");
			const size = statSync(file).size;
			res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": MIME[extname(file).toLowerCase()] as string, "Content-Length": size, "Cache-Control": "private, max-age=60" });
			if (req.method === "HEAD") return res.end();
			createReadStream(file).pipe(res);
			return;
		}

		return text(res, 404, "Not found");
	};

	/** Server-sent events: every complete line of the run log, then new lines as they are appended. */
	const streamRun = (req: IncomingMessage, res: ServerResponse, file: string) => {
		res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive" });
		res.write(": connected\n\n");
		let offset = 0;
		let partial = "";
		let beat = Date.now();
		const pump = () => {
			let size: number;
			try {
				size = statSync(file).size;
			} catch {
				return;
			}
			if (size < offset) {
				offset = 0;
				partial = "";
			}
			if (size > offset) {
				const fd = openSync(file, "r");
				try {
					const buf = Buffer.alloc(size - offset);
					readSync(fd, buf, 0, buf.length, offset);
					offset = size;
					const lines = (partial + buf.toString("utf8")).split("\n");
					partial = lines.pop() ?? "";
					for (const line of lines) {
						if (!line.trim()) continue;
						try {
							JSON.parse(line);
						} catch {
							continue;
						}
						res.write(`event: progress\ndata: ${line}\n\n`);
					}
				} finally {
					closeSync(fd);
				}
			}
			if (Date.now() - beat > 15_000) {
				beat = Date.now();
				res.write(": keep-alive\n\n");
			}
		};
		pump();
		const timer = setInterval(pump, pollMs);
		const stop = () => {
			clearInterval(timer);
			streams.delete(stop);
			if (!res.writableEnded) res.end();
		};
		streams.add(stop);
		req.on("close", stop);
	};

	const server = createServer((req, res) => {
		handler(req, res).catch((e: unknown) => {
			if (!res.headersSent) text(res, 500, "Internal error");
			else res.end();
			console.error(e);
		});
	});

	return new Promise((resolvePromise, reject) => {
		server.once("error", reject);
		server.listen(opts.port ?? 0, "127.0.0.1", () => {
			port = (server.address() as AddressInfo).port;
			resolvePromise({
				server,
				port,
				token,
				url: `http://127.0.0.1:${port}/?t=${token}`,
				close: () =>
					new Promise<void>((r) => {
						for (const stop of [...streams]) stop();
						server.close(() => r());
						server.closeAllConnections?.();
					}),
			});
		});
	});
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
	return new Promise((ok, fail) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > limit) {
				fail(new Error("Body too large"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
		req.on("error", fail);
	});
}

