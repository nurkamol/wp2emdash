/** Client docs for the Media Assistant (@wp2emdash/media): the editor guide's section and docs/media.md. */

export interface MediaDocInput {
	aiAlt: boolean;
	autoOptimize: boolean;
	maxDimension: number;
}

/** The editor guide's Media section (the full guide is docs/media.md). */
export const mediaGuide = (m: MediaDocInput | undefined) =>
	m
		? `
## Media (pictures and files)

**Plugins → Media** (editors and administrators) checks the media library: pictures that are too big, pictures without
a description (alt text) and where each one is used, files nothing uses, duplicates and broken pictures. It can make
big pictures smaller in place, suggest descriptions for you to review, and move unused files to a trash you can undo
for 30 days. See [Media](media.md).
`
		: "";

/** docs/media.md: how to use the Media page. */
export function mediaDoc(m: MediaDocInput, o: { sensitiveData: boolean }): string {
	return `
# Media

Open **Plugins → Media** in the admin (editors and administrators). The page scans the media library when it opens
(and once a day on its own) and shows what needs a look. Nothing on this page changes a file without you confirming it
first.

## Overview

How many files the site holds and how much space they take, by type, and four numbers: **oversized originals**,
**images without alt text**, **unused files** and what is in the **trash**. **Scan again** after a lot of changes.

"Used" means a page (published, draft or in the trash), a site setting such as the logo, a menu, a widget, a saved
section or another part of the site names the file.

## Make big pictures smaller (Optimize)

Pictures wider or taller than ${m.maxDimension} pixels, or larger than 500 KB, are listed with what Optimize would do.

- **Optimize** on a row (or **Optimize all listed**, up to 10 at a time) shows what will happen; **Optimize** on that
  screen replaces the file with a smaller version — same address, so every page keeps showing it.
- The old file is kept for **30 days**: **Put the old file back** under *Recently optimized* undoes it.
- Visitors already get a resized copy of each picture for their screen; Optimize makes the original itself smaller
  (uploads, downloads, and the fallback when the monthly allowance of resized copies is used up).
- A different format (a photo saved as PNG → JPEG) is not possible in place: upload the new file and choose it on the
  pages that use the old one.
${m.autoOptimize ? "- New uploads are queued for optimizing; the Optimize tab shows them with one button.\n" : ""}
## Alt text (descriptions)

Alt text describes a picture for people who cannot see it, and for search engines. It is kept in the media library, so
every page using the picture gets it.

1. **Alt text** lists the pictures without one and where each is used (the pages first).
2. **Suggest descriptions** prepares suggestions — ${m.aiAlt ? "from Cloudflare's AI (a small copy of each picture is sent to the model; nothing is stored there), or" : ""} from the file name and the heading above the picture.
3. Under **Review suggestions**, correct the text, then choose **Save this description** or **Reject** for each one and
   click **Save reviewed**. Only the ones you marked Save are saved; the rest wait.
${o.sensitiveData ? "\nThis site handles sensitive information, so AI suggestions start switched off: they would send each picture to an AI model. An administrator can switch them on under **Media → Settings** if the pictures show nothing sensitive.\n" : ""}
**Details** on any picture lets you type its description directly and pick its **focal point** — the part that stays
in view when a layout crops the picture (top, centre, bottom left…).

## Unused files and the trash

**Unused** lists files nothing on the site uses. Logos, icons and files uploaded in the last 24 hours are never
offered. Tick files and click **Review the chosen files…**, check the list, then **Move to trash**.

The files go to the **Trash (Media Assistant)** folder of the media library — nothing is deleted. **Trash → Put back**
returns a file any time within 30 days. After 30 days you may delete them for good (the page checks once more that
nothing uses them; your developer keeps a copy for another 30 days).

## Duplicates and broken pictures

**Duplicates** shows files uploaded more than once. **Broken** shows pages pointing at a picture that no longer exists —
**Open** the page and choose the picture again.

## Settings (administrators)

AI descriptions on or off, queueing new uploads for optimizing, and the largest picture size (${m.maxDimension} px).
`;
}
