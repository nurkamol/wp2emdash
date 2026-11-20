/**
 * The upload page (Plugins → Change requests → "Add screenshots or PDF files…"), the plugin's only React part:
 * EmDash 1.5's Block Kit has no file input (docs/spikes/change-requests-findings.md). Registered through the
 * descriptor's `adminEntry` for the path `/attach` only; every other page, the widget and the editor panel stay Block
 * Kit. It talks to the plugin's private routes (`uploads`, `upload`) with the editor's session and EmDash's CSRF
 * header; the server checks the role, the request, the limit of 3 files and each file's real type again.
 *
 * Plain `createElement` (no JSX) so the kit's TypeScript and tests need no React build step.
 */
import { createElement as h, useCallback, useEffect, useState } from "react";

const API = "/_emdash/api/plugins/change-requests";

interface Summary {
	id: string;
	number: number;
	title: string;
	attachments: number;
}
interface UploadsData {
	requests: Summary[];
	selected: string | null;
	max: number;
	maxBytes: number;
	back: string;
}
type Line = { name: string; ok: boolean; message: string };

const ACCEPT = "image/png,image/jpeg,image/gif,image/webp,application/pdf";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`${API}/${path}`, { credentials: "same-origin", ...init, headers: { "X-EmDash-Request": "1", ...(init.headers ?? {}) } });
	const body = (await res.json().catch(() => null)) as { data?: T; error?: { message?: string } } | null;
	if (!res.ok || !body || body.data === undefined) throw new Error(body?.error?.message ?? `The site answered ${res.status}.`);
	return body.data;
}

export function AttachPage() {
	const [data, setData] = useState<UploadsData | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [chosen, setChosen] = useState<string>("");
	const [busy, setBusy] = useState(false);
	const [lines, setLines] = useState<Line[]>([]);

	const load = useCallback(async () => {
		try {
			const d = await call<UploadsData>("uploads", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
			setData(d);
			setChosen((c) => c || d.selected || d.requests[0]?.id || "");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not load the requests.");
		}
	}, []);
	useEffect(() => {
		void load();
	}, [load]);

	const send = useCallback(
		async (files: File[]) => {
			if (!data || !chosen || !files.length) return;
			setBusy(true);
			const out: Line[] = [];
			for (const f of files) {
				if (f.size > data.maxBytes) {
					out.push({ name: f.name, ok: false, message: `Larger than ${Math.round(data.maxBytes / 1024 / 1024)} MB.` });
					continue;
				}
				try {
					const r = await call<{ ok: boolean; message: string }>(`upload?request=${encodeURIComponent(chosen)}&name=${encodeURIComponent(f.name || "screenshot.png")}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: f });
					out.push({ name: f.name || "screenshot", ok: r.ok, message: r.message });
				} catch (e) {
					out.push({ name: f.name || "screenshot", ok: false, message: e instanceof Error ? e.message : "Upload failed." });
				}
			}
			setLines((l) => [...out, ...l]);
			setBusy(false);
			await load();
		},
		[data, chosen, load],
	);

	// Screenshots can be pasted straight from the clipboard.
	useEffect(() => {
		const onPaste = (e: ClipboardEvent) => {
			const files = [...(e.clipboardData?.files ?? [])];
			if (files.length) {
				e.preventDefault();
				void send(files);
			}
		};
		window.addEventListener("paste", onPaste);
		return () => window.removeEventListener("paste", onPaste);
	}, [send]);

	const box = { maxWidth: "720px", padding: "24px", display: "grid", gap: "16px" };
	if (error) return h("div", { style: box }, h("h1", { style: { fontSize: "1.5rem" } }, "Add files"), h("p", { role: "alert" }, error));
	if (!data) return h("div", { style: box }, h("p", null, "Loading…"));
	const current = data.requests.find((r: Summary) => r.id === chosen);
	const left = current ? data.max - current.attachments : 0;
	return h(
		"div",
		{ style: box },
		h("h1", { style: { fontSize: "1.5rem", margin: 0 } }, "Add screenshots or PDF files"),
		h("p", { style: { margin: 0, opacity: 0.75 } }, `Up to ${data.max} files per request — PNG, JPEG, GIF, WebP or PDF, up to ${Math.round(data.maxBytes / 1024 / 1024)} MB each. Files are stored privately: only signed-in editors and admins of this site can download them. You can also paste a screenshot (Ctrl/Cmd + V).`),
		data.requests.length
			? h(
					"label",
					{ style: { display: "grid", gap: "4px" } },
					"Request",
					h(
						"select",
						{ value: chosen, onChange: (e: { target: { value: string } }) => setChosen(e.target.value), disabled: busy, style: { padding: "8px" } },
						data.requests.map((r: Summary) => h("option", { key: r.id, value: r.id }, `#${r.number} ${r.title} (${r.attachments}/${data.max} files)`)),
					),
				)
			: h("p", null, "There is no open request that can take more files."),
		current && left > 0
			? h("input", {
					type: "file",
					accept: ACCEPT,
					multiple: left > 1,
					disabled: busy,
					"aria-label": "Choose files",
					onChange: (e: { target: { files: FileList | null; value: string } }) => {
						const files = [...(e.target.files ?? [])].slice(0, left);
						e.target.value = "";
						void send(files);
					},
				})
			: current
				? h("p", null, `This request has ${data.max} files already.`)
				: null,
		busy ? h("p", { "aria-live": "polite" }, "Uploading…") : null,
		lines.length ? h("ul", { "aria-live": "polite", style: { margin: 0, paddingLeft: "20px" } }, lines.map((l: Line, n: number) => h("li", { key: n, style: { color: l.ok ? "inherit" : "#b42318" } }, `${l.name}: ${l.message}`))) : null,
		h("p", { style: { margin: 0 } }, h("a", { href: current ? `${data.back}/${current.id}` : data.back }, current ? `Back to request #${current.number}` : "Back to Change requests")),
	);
}

/** EmDash's admin registry reads `pages` from a plugin's adminEntry module: path → component. */
export const pages = { "/attach": AttachPage };
