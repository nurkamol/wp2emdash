/**
 * EmDash's own REST API as the person who clicked (their session cookie or bearer token, plus EmDash's CSRF header),
 * sent through the Worker's SELF binding — nothing leaves the Worker, and EmDash checks that person's permissions
 * (media:edit_own/any, media:delete_own/any) on every call. The plugin media API has no replace, folder or delete-with-
 * check; these routes do (verified in EmDash 1.5.0 source, docs/spikes/media-findings.md).
 */
import type { Replacer } from "./optimize.js";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export type Api = <T = unknown>(method: string, path: string, body?: unknown) => Promise<T>;

export function emdashApi(o: { self: (r: Request) => Promise<Response>; origin: string; cookie?: string | null; authorization?: string | null }): Api {
	return async <T>(method: string, path: string, body?: unknown): Promise<T> => {
		const headers: Record<string, string> = { "X-EmDash-Request": "1", accept: "application/json" };
		if (o.cookie) headers.cookie = o.cookie;
		if (o.authorization) headers.authorization = o.authorization;
		const form = body instanceof FormData;
		if (body !== undefined && !form) headers["content-type"] = "application/json";
		const res = await o.self(new Request(`${o.origin}/_emdash/api${path}`, { method, headers, ...(body !== undefined ? { body: form ? (body as FormData) : JSON.stringify(body) } : {}) }));
		const text = await res.text();
		let json: { data?: T; error?: { code?: string; message?: string } } = {};
		try {
			json = text ? JSON.parse(text) : {};
		} catch {
			throw new ApiError(res.status, "NOT_JSON", `HTTP ${res.status}`);
		}
		if (!res.ok) throw new ApiError(res.status, json.error?.code ?? `HTTP_${res.status}`, `${json.error?.code ?? res.status}${json.error?.message ? `: ${json.error.message.slice(0, 160)}` : ""}`);
		return json.data as T;
	};
}

const enc = encodeURIComponent;

/** Replace original + focal point, through EmDash. */
export function apiReplacer(api: Api): Replacer {
	return {
		async replace(id, f) {
			const form = new FormData();
			form.set("file", new File([f.bytes as Uint8Array<ArrayBuffer>], f.filename, { type: f.type }));
			form.set("width", String(f.width));
			form.set("height", String(f.height));
			await api("PUT", `/media/${enc(id)}/replace`, form);
		},
		async focal(id, x, y) {
			await api("PUT", `/media/${enc(id)}`, { focalX: x, focalY: y });
		},
	};
}

/** The trash folder's id, created when missing. */
export async function ensureFolder(api: Api, name: string): Promise<string> {
	const list = await api<{ items?: { id: string; name: string }[] }>("GET", `/media/folders?q=${enc(name)}&limit=50`);
	const found = list?.items?.find((f) => f.name === name);
	if (found) return found.id;
	const made = await api<{ item?: { id: string }; id?: string }>("POST", "/media/folders", { name });
	const id = made?.item?.id ?? made?.id;
	if (!id) throw new ApiError(500, "NO_FOLDER", "The trash folder could not be created");
	return id;
}

export const moveToFolder = (api: Api, id: string, folderId: string | null) => api("PUT", `/media/${enc(id)}`, { folderId: folderId ?? "unfiled" });
export const deleteMedia = (api: Api, id: string) => api("DELETE", `/media/${enc(id)}`);
