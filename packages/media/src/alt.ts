/**
 * Alt text suggestions. Nothing is ever written without a person: suggestions are stored, an editor accepts (as is or
 * edited), rejects, or leaves each one, and only the accepted ones are saved to the media library
 * (`media.updateMetadata`, capability `media:metadata:write` — the same call the SEO suite's Images tab uses).
 *
 * Sources: Workers AI (the `AI` binding, a vision model; image bytes go to the model — off by default on sites with
 * sensitive data) or, without it, the file name and the heading of the section the image sits in.
 */
import type { ImagesBinding } from "./optimize.js";
import { bytesOf, streamOf } from "./optimize.js";
import type { MediaRow, Ref } from "./scan.js";

export type Source = "ai" | "filename" | "page";

export interface Suggestion {
	id: string;
	filename: string;
	text: string;
	source: Source;
	at: string;
	/** Where the image is used (labels), for the reviewer. */
	used: string[];
}

export const MAX_ALT = 150;

const NOISE = new Set(["img", "image", "photo", "pic", "picture", "dsc", "dscn", "dcim", "pxl", "screenshot", "screen", "shot", "copy", "final", "edited", "edit", "min", "web", "scaled", "large", "small", "thumb", "thumbnail", "rotated", "new", "old", "v", "jpeg", "jpg", "png", "webp", "untitled", "whatsapp", "mvimg", "ig", "insta", "export", "hd", "hq", "lr", "unsplash", "pexels", "shutterstock", "istock", "adobestock", "stock", "bg", "background", "hero", "banner", "featured"]);

/** Words a file name says about its picture, or none. Pure. */
export function filenameWords(filename: string): string[] {
	const base = filename
		.replace(/\.[a-z0-9]{2,5}$/i, "")
		.replace(/-\d{2,5}x\d{2,5}$/i, "")
		.replace(/-e\d{9,}$/i, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2");
	return base
		.split(/[\s_\-.+,()[\]]+/)
		.map((w) => w.trim())
		.filter((w) => w.length > 1 && /[a-z]/i.test(w) && !/\d{3,}/.test(w) && !/^[0-9a-f]{8,}$/i.test(w) && !/^\d+$/.test(w) && !NOISE.has(w.toLowerCase()));
}

/** A suggestion from the file name, else the page heading above the image. Pure. */
export function heuristicAlt(filename: string, refs: Ref[]): { text: string; source: Source } | undefined {
	const words = filenameWords(filename);
	if (words.length >= 2 || (words.length === 1 && (words[0]?.length ?? 0) >= 5)) {
		const s = words.join(" ").toLowerCase();
		return { text: cleanAlt(s.charAt(0).toUpperCase() + s.slice(1)), source: "filename" };
	}
	const heading = refs.find((r) => r.heading)?.heading;
	if (heading) return { text: cleanAlt(heading), source: "page" };
	return undefined;
}

/** Plain, short alt text: no quotes, no "image of", one sentence, at most MAX_ALT characters. Pure. */
export function cleanAlt(s: string): string {
	let t = (s.trim().split(/\n/)[0] ?? "")
		.replace(/^\s*(?:alt(?:\s*text)?|description|caption)\s*[:\-–]\s*/i, "")
		.replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
		.trim();
	t = t.replace(/^(?:an?\s+)?(?:image|photo|picture|photograph)\s+(?:of|showing)\s+/i, "").replace(/^this\s+(?:image|photo|picture)\s+(?:shows|depicts)\s+/i, "");
	t = t.charAt(0).toUpperCase() + t.slice(1);
	if (t.length > MAX_ALT) t = `${t.slice(0, MAX_ALT).replace(/\s+\S*$/, "")}`;
	return t.replace(/\s+/g, " ").trim();
}

export interface AiBinding {
	run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

export class AiLicenseError extends Error {}

/** The prompt sent with the picture (no personal data: the site name and the page titles only). */
export function altPrompt(site: string, pages: string[]): string {
	return `Write the alt text for this picture on the website "${site}"${pages.length ? `, used on: ${pages.slice(0, 3).join("; ")}` : ""}. One plain sentence under 125 characters describing what the picture shows, for someone who cannot see it. Do not start with "Image of" or "Picture of". Do not guess names of people. Reply with the sentence only.`;
}

/** One AI suggestion: a small JPEG copy (512 px) goes to the model, never the original. */
export async function aiAlt(ai: AiBinding, images: ImagesBinding | undefined, model: string, original: Uint8Array, prompt: string): Promise<string | undefined> {
	let input = original;
	if (images) {
		try {
			const out = await images.input(streamOf(original)).transform({ width: 512, height: 512, fit: "scale-down" }).output({ format: "image/jpeg", quality: 70 });
			input = await bytesOf(out.image());
		} catch {}
	}
	if (input.byteLength > 2 * 1024 * 1024) return undefined;
	let r: unknown;
	try {
		r = await ai.run(model, { prompt, image: [...input], max_tokens: 80 });
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		if (/agree|licen[cs]e|acceptable use/i.test(msg)) throw new AiLicenseError(msg);
		throw e;
	}
	const text = typeof r === "object" && r ? ((r as { response?: unknown; description?: unknown }).response ?? (r as { description?: unknown }).description) : r;
	const clean = typeof text === "string" ? cleanAlt(text) : "";
	return clean.length >= 3 ? clean : undefined;
}

export type Decision = "later" | "save" | "reject";

export interface Review {
	saved: { id: string; text: string }[];
	rejected: string[];
	kept: Suggestion[];
	errors: string[];
}

/**
 * Applies an editor's review form: only rows marked "save" are written (with the text as edited), "reject" drops the
 * suggestion, anything else stays for later. Pure — the caller writes `saved` to the library.
 */
export function review(suggestions: Suggestion[], values: Record<string, unknown>): Review {
	const out: Review = { saved: [], rejected: [], kept: [], errors: [] };
	for (const s of suggestions) {
		const decision = values[`do:${s.id}`];
		const raw = values[`text:${s.id}`];
		const text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 300) : s.text;
		if (decision === "save") {
			if (text.length < 3) {
				out.errors.push(`${s.filename}: the description is empty.`);
				out.kept.push(s);
			} else out.saved.push({ id: s.id, text });
		} else if (decision === "reject") out.rejected.push(s.id);
		else out.kept.push(text && text !== s.text ? { ...s, text } : s);
	}
	return out;
}

/** Images that should get a suggestion next: no alt, no pending suggestion, used ones first. Pure. */
export function needsSuggestion(missing: { m: MediaRow; refs: Ref[] }[], pending: Suggestion[], rejected: string[], max: number): { m: MediaRow; refs: Ref[] }[] {
	const skip = new Set([...pending.map((s) => s.id), ...rejected]);
	return missing.filter((x) => x.m.mimeType !== "image/svg+xml" && !skip.has(x.m.id)).slice(0, max);
}
