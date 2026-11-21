// WebMCP declarative form attributes (@wp2emdash/forms/webmcp; kit docs/spikes/webmcp-findings.md). Not in Astro's
// HTML types yet, so `astro check` would reject them on <form>, <input>, <select> and <textarea> without this.
declare namespace astroHTML.JSX {
	interface HTMLAttributes {
		toolname?: string | undefined | null;
		tooldescription?: string | undefined | null;
		toolautosubmit?: boolean | undefined | null;
		toolparamdescription?: string | undefined | null;
	}
}
