/** Files linked from content and media metadata (src/targets/emdash/documents.ts, the EmDash client's upload fields). */
import { afterEach, describe, expect, it, vi } from "vitest";
import { findMediaRefs } from "../src/extract/refs.js";
import type { MediaEntry } from "../src/phases/extract.js";
import { EmDashApi } from "../src/targets/emdash/api.js";
import { DOCUMENT_FIELD, globallyAllowed, isDocument, lostMetadata, manifestIndex, uploadLinks, uploadsPath } from "../src/targets/emdash/documents.js";

const site = (u: string) => u.startsWith("/") || /^https?:\/\/(www\.)?studio\.example\//.test(u);

describe("upload links in content", () => {
	it("finds href values and href/src inside raw HTML, only for this site's uploads", () => {
		const docs = [
			[{ fields: { body: [{ markDefs: [{ _type: "link", href: "https://studio.example/wp-content/uploads/2024/05/Price-List.pdf" }, { href: "https://other.example/wp-content/uploads/2024/05/x.pdf" }, { href: "/contact/" }] }] } }],
			[{ fields: { html: '<a href="/wp-content/uploads/2023/01/timetable.docx">Timetable</a><img src="https://www.studio.example/wp-content/uploads/2023/01/map.png">' } }],
		];
		expect(uploadLinks(docs, site)).toEqual(["https://studio.example/wp-content/uploads/2024/05/Price-List.pdf", "/wp-content/uploads/2023/01/timetable.docx", "https://www.studio.example/wp-content/uploads/2023/01/map.png"]);
	});
	it("maps an address to the file extract downloaded (library or not), case-insensitive, image sizes folded", () => {
		const manifest: MediaEntry[] = [
			{ id: 40, url: "https://studio.example/wp-content/uploads/2024/05/Price-List.pdf", file: "2024/05/Price-List.pdf", inLibrary: true, referencedBy: [], status: "cached" },
			{ url: "https://studio.example/wp-content/uploads/2023/01/timetable.docx", file: "2023/01/timetable.docx", inLibrary: false, referencedBy: [], status: "downloaded" },
			{ id: 7, url: "https://studio.example/wp-content/uploads/2023/01/map.png", file: "2023/01/map.png", inLibrary: true, referencedBy: [], status: "cached" },
			{ id: 8, url: "https://studio.example/wp-content/uploads/2023/01/gone.pdf", inLibrary: true, referencedBy: [], status: "failed" },
		];
		const find = manifestIndex(manifest);
		expect(find("https://studio.example/wp-content/uploads/2024/05/price-list.pdf")?.id).toBe(40);
		expect(find("https://studio.example/wp-content/uploads/2023/01/timetable.docx")?.inLibrary).toBe(false);
		expect(find("https://studio.example/wp-content/uploads/2023/01/map-300x200.png")?.id).toBe(7);
		expect(find("https://studio.example/wp-content/uploads/2023/01/gone.pdf")).toBeUndefined();
		expect(uploadsPath("/storage/2023/01/A%20B-1024x768.jpg")).toBe("2023/01/a b.jpg");
	});
});

describe("extract finds linked documents", () => {
	it("PDF/Office links anywhere; OpenDocument, text and archives only under the uploads folder", () => {
		const refs = findMediaRefs('<a href="https://studio.example/wp-content/uploads/2024/05/menu.pdf">Menu</a> <a href="/wp-content/uploads/2024/05/rules.odt">Rules</a> <a href="https://other.example/notes.txt">x</a> <a href="https://studio.example/wp-content/uploads/2024/05/list.csv?v=2">csv</a>').map((r) => r.value);
		expect(refs).toEqual(["https://studio.example/wp-content/uploads/2024/05/menu.pdf", "/wp-content/uploads/2024/05/rules.odt", "https://studio.example/wp-content/uploads/2024/05/list.csv"]);
	});
});

describe("what the media library takes", () => {
	it("PDF, pictures, audio and video globally; other documents only through the documents field", () => {
		expect(["application/pdf", "image/png", "audio/mpeg", "video/mp4"].every(globallyAllowed)).toBe(true);
		expect(globallyAllowed("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe(false);
		expect(DOCUMENT_FIELD.validation.allowedMimeTypes).toContain("application/zip");
		expect(DOCUMENT_FIELD.validation.allowedMimeTypes).not.toContain("application/pdf");
		expect(DOCUMENT_FIELD.validation.allowedMimeTypes.length).toBeLessThanOrEqual(64); // EmDash's limit
		expect([isDocument("a.PDF"), isDocument("b.xlsx"), isDocument("c.jpg")]).toEqual([true, true, false]);
	});
	it("reports titles that say more than the file name, and descriptions", () => {
		const e = (file: string, title: string, description = "", caption = "") => ({ url: `https://studio.example/wp-content/uploads/${file}`, file, title, description, caption, inLibrary: true, referencedBy: [], status: "cached" as const });
		const lost = lostMetadata([e("2024/05/price-list.pdf", "Price list"), e("2024/05/img_1.jpg", "Our reception desk"), e("2024/05/team.jpg", "team", "<p>The whole team in 2024</p>"), e("2024/05/x.jpg", "Sunset", "", "Sunset")]);
		expect(lost).toEqual({ titles: ["2024/05/img_1.jpg"], descriptions: ["2024/05/team.jpg"] });
	});
});

describe("EmDash client: uploads with caption and a field's allowlist", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("sends alt, caption and fieldId as form values; lists a collection's fields", async () => {
		const seen: { url: string; body?: unknown }[] = [];
		const api = new EmDashApi("https://site.example", { token: "t" }, async (u, i) => {
			seen.push({ url: String(u), body: i?.body });
			return new Response(JSON.stringify({ data: String(u).endsWith("/fields") ? { items: [{ id: "f1", slug: "wp_documents", type: "file" }] } : { item: { id: "m1" } } }), { status: 200 });
		});
		await api.mediaUpload(new Uint8Array([1]), "plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Plan", { caption: "Floor plan", fieldId: "f1" });
		const form = seen[0]?.body as FormData;
		expect([form.get("alt"), form.get("caption"), form.get("fieldId"), (form.get("file") as File).name]).toEqual(["Plan", "Floor plan", "f1", "plan.docx"]);
		expect(await api.fields("pages")).toEqual([{ id: "f1", slug: "wp_documents", type: "file" }]);
		expect(seen[1]?.url).toBe("https://site.example/_emdash/api/schema/collections/pages/fields");
	});
});
