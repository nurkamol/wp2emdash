/**
 * Files linked from content (PDFs, Word, Excel, ZIP… under /wp-content/uploads/) and what EmDash 1.5's media library
 * takes (verified in the installed source, docs/spikes/content-forms-findings.md):
 *
 * - The global upload allowlist is images, audio, video and PDF (api/handlers/media-allowlist.ts GLOBAL_UPLOAD_ALLOWLIST).
 *   Any other type is accepted only when the upload names a `file` field whose `validation.allowedMimeTypes` lists it
 *   (`fieldId` form value, resolveFieldAllowlist): load creates one such field on `pages` when a site links documents.
 * - Media keeps `alt` and `caption` (mediaUploadMetadataForm); a WordPress attachment's title and description have no
 *   column: reported, never silently dropped.
 * - Files are served at /_emdash/api/media/file/<storage key>; everything but plain images/audio/video is sent as an
 *   attachment (a PDF downloads instead of opening in the browser tab), with the original file name.
 * - The starter's middleware sends an old upload address to the file with the same name (legacyUpload), so old links
 *   from outside keep working once the file is in the library.
 */
import type { MediaEntry } from "../../phases/extract.js";

/** Content types load sends for document extensions (EmDash's own extension table where it has one). */
export const DOC_MIME: Record<string, string> = {
	".pdf": "application/pdf",
	".doc": "application/msword",
	".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	".dot": "application/msword",
	".dotx": "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
	".xls": "application/vnd.ms-excel",
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".ppt": "application/vnd.ms-powerpoint",
	".pps": "application/vnd.ms-powerpoint",
	".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	".ppsx": "application/vnd.openxmlformats-officedocument.presentationml.slideshow",
	".odt": "application/vnd.oasis.opendocument.text",
	".ods": "application/vnd.oasis.opendocument.spreadsheet",
	".odp": "application/vnd.oasis.opendocument.presentation",
	".rtf": "application/rtf",
	".txt": "text/plain",
	".csv": "text/csv",
	".zip": "application/zip",
	".rar": "application/vnd.rar",
	".7z": "application/x-7z-compressed",
	".gz": "application/gzip",
	".tar": "application/x-tar",
	".epub": "application/epub+zip",
	".kml": "application/vnd.google-earth.kml+xml",
	".kmz": "application/vnd.google-earth.kmz",
	".json": "application/json",
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".wav": "audio/wav",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".opus": "audio/ogg",
	".aac": "audio/aac",
	".flac": "audio/flac",
};

/** EmDash 1.5's global upload allowlist (prefixes ending in / match a whole family). */
const GLOBAL = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp", "image/jxl", "video/", "audio/", "application/pdf"];
export const globallyAllowed = (mime: string) => GLOBAL.some((g) => (g.endsWith("/") ? mime.startsWith(g) : mime === g));

/** The file field load creates on `pages` so document types get in (its allowlist). */
export const DOCUMENT_FIELD = {
	slug: "wp_documents",
	label: "Documents (file types allowed for the migration; not shown on the page)",
	type: "file",
	validation: { allowedMimeTypes: [...new Set(Object.values(DOC_MIME).filter((m) => !globallyAllowed(m)))] },
};

/** Not pictures or video: files a visitor downloads (documents, archives, audio). */
export const isDocument = (file: string) => !!DOC_MIME[(/\.[a-z0-9]+$/i.exec(file)?.[0] ?? "").toLowerCase()];

/** `…/wp-content/uploads/2024/05/Price-List.pdf` → `2024/05/price-list.pdf` (an image's -300x200 size suffix removed). */
export function uploadsPath(url: string): string | undefined {
	const m = /\/(?:wp-content\/uploads|storage)\/(.+)$/i.exec(url.split(/[?#]/)[0] ?? "");
	if (!m?.[1]) return undefined;
	let p: string;
	try {
		p = decodeURIComponent(m[1]);
	} catch {
		p = m[1];
	}
	return p.replace(/-(?:\d+x\d+|scaled)(?=\.(?:jpe?g|png|gif|webp|avif)$)/i, "").toLowerCase();
}

/** Every site-hosted upload address linked from content: `href` values and href/src attributes inside `html` strings. */
export function uploadLinks(values: unknown[], isSiteUrl: (u: string) => boolean): string[] {
	const out = new Set<string>();
	const consider = (u: string) => {
		if (/\/(?:wp-content\/uploads|storage)\/\d{4}\/\d{2}\//i.test(u) && isSiteUrl(u)) out.add(u);
	};
	const walk = (v: unknown, key = ""): void => {
		if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
		if (v && typeof v === "object") {
			for (const [k, x] of Object.entries(v)) walk(x, k);
			return;
		}
		if (typeof v !== "string") return;
		if (key === "href") consider(v);
		else if (key === "html") for (const m of v.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)) consider(m[1] ?? "");
	};
	walk(values);
	return [...out];
}

/** The manifest entry (a file extract downloaded) behind an upload address. */
export function manifestIndex(manifest: MediaEntry[]): (url: string) => MediaEntry | undefined {
	const byPath = new Map<string, MediaEntry>();
	for (const m of manifest) {
		if (!m.file || m.status === "failed") continue;
		const p = uploadsPath(m.url) ?? m.file.toLowerCase();
		if (!byPath.has(p) || m.id) byPath.set(p, m);
	}
	return (url) => {
		const p = uploadsPath(url);
		return p ? byPath.get(p) : undefined;
	};
}

/** Plain text of a WordPress caption (it may hold HTML). */
export const plainCaption = (s: string | undefined) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/**
 * What the media library cannot keep of the WordPress attachments load uploads: titles that say more than the file name,
 * and descriptions. Counted for the load report.
 */
export function lostMetadata(entries: (MediaEntry & { description?: string })[]): { titles: string[]; descriptions: string[] } {
	const base = (f: string) => f.replace(/^.*\//, "").replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " ").trim().toLowerCase();
	const titles = entries.filter((m) => m.title && m.file && m.title.trim().toLowerCase() !== base(m.file) && plainCaption(m.title) !== plainCaption(m.caption)).map((m) => m.file as string);
	const descriptions = entries.filter((m) => plainCaption(m.description) && m.file).map((m) => m.file as string);
	return { titles, descriptions };
}
