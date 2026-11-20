/**
 * Verify's `comments` check: every published entry with migrated comments shows them. The starter's comments section
 * (components/comments/Comments.astro) carries `data-comment-count` = EmDash's count of approved comments for the entry.
 */
export function commentCountProblem(html: string, expected: number): string | undefined {
	const m = /<section\b[^>]*\bdata-comment-count="(\d+)"/.exec(html) ?? /\bdata-comment-count="(\d+)"[^>]*>/.exec(html);
	if (!m) return `no comments section (expected ${expected})`;
	const shown = Number(m[1]);
	return shown === expected ? undefined : `${shown} comments shown, expected ${expected}`;
}
