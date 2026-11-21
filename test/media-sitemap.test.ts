import { describe, expect, it } from "vitest";
import { entryMedia, MAX_IMAGES_PER_PAGE, mediaSitemapXml, ownUrl, vimeoId, youtubeId } from "../starter/src/utils/media-sitemap.js";

const origin = "https://acme.example";
const img = (key: string, extra: Record<string, unknown> = {}) => ({ provider: "local", id: `01ID${key}`, mimeType: "image/jpeg", meta: { storageKey: `${key}.jpg` }, ...extra });
const vid = (key: string) => ({ provider: "local", id: `01ID${key}`, mimeType: "video/mp4", meta: { storageKey: `${key}.mp4` } });
const page = { title: "Our studio", description: "A small studio in town." };

describe("media sitemap: pictures inside sections", () => {
	it("lists every picture of every section (backgrounds, columns, repeaters, galleries), deduped, on the site's address", () => {
		const data = {
			title: "Our studio",
			featured_image: img("feature"),
			blocks: [
				{ _type: "section_hero", _key: "a", bg_image: img("hero-bg"), media: img("hero-side"), bg_video: vid("loop") },
				{ _type: "section_media_text", _key: "b", media: img("room"), media_2: img("room-2") },
				{ _type: "section_columns", _key: "c", col_1_image: img("col1"), col_2_bg_image: img("col2-bg") },
				{ _type: "section_feature_grid", _key: "d", items: [{ title: "One", image: img("card-1") }, { title: "Two", image: img("card-1") }] },
				{ _type: "section_gallery", _key: "e", images: [{ image: img("g1") }, { image: img("g2") }] },
				{ _type: "section_team", _key: "f", members: [{ name: "A", photo: img("person") }] },
				{ _type: "section_logo_strip", _key: "g", logos: [{ image: img("logo"), url: "https://partner.example" }] },
				{ _type: "section_embed", _key: "h", provider: "calendly", html: "<iframe src=\"https://calendly.com/x\"></iframe>" },
			],
		};
		const { images, videos } = entryMedia(data, origin, page);
		const keys = images.map((u) => u.replace(`${origin}/_emdash/api/media/file/`, ""));
		expect(keys).toEqual(["feature.jpg", "hero-bg.jpg", "hero-side.jpg", "room.jpg", "room-2.jpg", "col1.jpg", "col2-bg.jpg", "card-1.jpg", "g1.jpg", "g2.jpg", "person.jpg", "logo.jpg"]);
		// The background video is decoration: neither an image nor a video entry.
		expect(images.some((u) => u.endsWith(".mp4"))).toBe(false);
		expect(videos).toEqual([]);
	});

	it("leaves out pictures on other hosts, bare media ids (they answer 404) and non-image files", () => {
		const data = {
			blocks: [
				{ _type: "section_media_text", _key: "a", media: { provider: "external", id: "", src: "https://cdn.other.example/x.jpg" } },
				{ _type: "section_media_text", _key: "b", media: { provider: "local", id: "01BAREID" } },
				{ _type: "section_media_text", _key: "c", media: img("doc", { mimeType: "application/pdf" }) },
				{ _type: "section_media_text", _key: "d", media: { provider: "external", id: "", src: `${origin}/images/own.png` } },
			],
		};
		expect(entryMedia(data, origin, page).images).toEqual([`${origin}/images/own.png`]);
	});

	it("reads Portable Text images (post bodies) by their file URL", () => {
		const data = { content: [{ _type: "block", _key: "p", children: [] }, { _type: "image", _key: "i", asset: { _type: "reference", _ref: "01X", url: "/_emdash/api/media/file/body.webp" } }, { _type: "image", _key: "j", asset: { _ref: "01Y" } }] };
		expect(entryMedia(data, origin, page).images).toEqual([`${origin}/_emdash/api/media/file/body.webp`]);
	});

	it("stops at 1,000 pictures per page (the spec's limit)", () => {
		const data = { blocks: [{ _type: "section_gallery", _key: "g", images: Array.from({ length: 1200 }, (_, i) => ({ image: img(`p${i}`) })) }] };
		expect(entryMedia(data, origin, page).images).toHaveLength(MAX_IMAGES_PER_PAGE);
	});

	it("keeps only addresses on the site's own origin", () => {
		expect(ownUrl("/a.jpg", origin)).toBe(`${origin}/a.jpg`);
		expect(ownUrl(`${origin}/a.jpg`, origin)).toBe(`${origin}/a.jpg`);
		expect(ownUrl("https://www.acme.example/a.jpg", origin)).toBeUndefined();
		expect(ownUrl("//cdn.example/a.jpg", origin)).toBeUndefined();
		expect(ownUrl("data:image/png;base64,AAA", origin)).toBeUndefined();
		expect(ownUrl(undefined, origin)).toBeUndefined();
	});
});

describe("media sitemap: video sections", () => {
	it("an uploaded video with a poster: content_loc, the poster as thumbnail, heading and caption", () => {
		const data = { blocks: [{ _type: "section_video", _key: "v", heading: "Tour", caption: "Walk through the studio", video: vid("tour"), poster: img("tour-poster") }] };
		const { images, videos } = entryMedia(data, origin, page);
		expect(videos).toEqual([{ thumbnail: `${origin}/_emdash/api/media/file/tour-poster.jpg`, title: "Tour", description: "Walk through the studio", content: `${origin}/_emdash/api/media/file/tour.mp4` }]);
		expect(images).toEqual([`${origin}/_emdash/api/media/file/tour-poster.jpg`]);
	});

	it("an uploaded video without a poster is left out (Google requires a thumbnail)", () => {
		expect(entryMedia({ blocks: [{ _type: "section_video", _key: "v", video: vid("tour") }] }, origin, page).videos).toEqual([]);
	});

	it("YouTube links: the player URL and YouTube's thumbnail; the page's title and description when the section has none", () => {
		const data = { blocks: [{ _type: "section_video", _key: "v", embed_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10" }, { _type: "section_video", _key: "w", embed_url: "https://youtu.be/dQw4w9WgXcQ" }] };
		expect(entryMedia(data, origin, page).videos).toEqual([{ thumbnail: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg", title: "Our studio", description: "A small studio in town.", player: "https://www.youtube.com/embed/dQw4w9WgXcQ" }]);
	});

	it("Vimeo links need a poster image", () => {
		const bare = { blocks: [{ _type: "section_video", _key: "v", embed_url: "https://vimeo.com/123456" }] };
		expect(entryMedia(bare, origin, page).videos).toEqual([]);
		const withPoster = { blocks: [{ _type: "section_video", _key: "v", heading: "Class", embed_url: "https://vimeo.com/video/123456", poster: img("p") }] };
		expect(entryMedia(withPoster, origin, page).videos[0]).toMatchObject({ player: "https://player.vimeo.com/video/123456", thumbnail: `${origin}/_emdash/api/media/file/p.jpg`, title: "Class" });
	});

	it("recognises the usual YouTube and Vimeo address forms", () => {
		expect(youtubeId("https://www.youtube-nocookie.com/embed/abcdEFG_123")).toBe("abcdEFG_123");
		expect(youtubeId("https://www.youtube.com/shorts/abcdEFG_123")).toBe("abcdEFG_123");
		expect(youtubeId("https://example.com/watch?v=abcdEFG_123")).toBeUndefined();
		expect(vimeoId("https://player.vimeo.com/video/987654")).toBe("987654");
	});
});

describe("media sitemap XML", () => {
	it("one <url> per page with media, image and video namespaces, escaped; pages without media left out", () => {
		const xml = mediaSitemapXml([
			{ loc: `${origin}/`, images: [`${origin}/_emdash/api/media/file/a.jpg?x=1&y=2`], videos: [{ thumbnail: "https://i.ytimg.com/vi/abc123/hqdefault.jpg", title: "Tom & Jerry <live>", description: "It's \"fun\"", player: "https://www.youtube.com/embed/abc123" }] },
			{ loc: `${origin}/empty/`, images: [], videos: [] },
			{ loc: `${origin}/`, images: [`${origin}/dupe.jpg`], videos: [] },
		]);
		expect(xml).toContain('xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"');
		expect(xml).toContain('xmlns:video="http://www.google.com/schemas/sitemap-video/1.1"');
		expect(xml.match(/<url>/g)).toHaveLength(1);
		expect(xml).toContain("<image:loc>https://acme.example/_emdash/api/media/file/a.jpg?x=1&amp;y=2</image:loc>");
		expect(xml).toContain("<video:title>Tom &amp; Jerry &lt;live&gt;</video:title>");
		expect(xml).toContain("<video:description>It&apos;s &quot;fun&quot;</video:description>");
		expect(xml).toContain("<video:player_loc>https://www.youtube.com/embed/abc123</video:player_loc>");
		expect(xml).not.toContain("/empty/");
	});

	it("the warm-up and verify <loc> pattern reads page addresses only, never image or video locations", () => {
		const xml = mediaSitemapXml([{ loc: `${origin}/about/`, images: [`${origin}/_emdash/api/media/file/a.jpg`], videos: [{ thumbnail: `${origin}/t.jpg`, title: "T", description: "D", content: `${origin}/v.mp4` }] }]);
		const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1]);
		expect(locs).toEqual([`${origin}/about/`]);
	});

	it("an empty sitemap is still a valid urlset", () => {
		expect(mediaSitemapXml([])).toMatch(/<urlset [^>]+>\n<\/urlset>\n$/);
	});
});
