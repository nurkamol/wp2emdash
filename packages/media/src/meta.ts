/** Plugin identity (shared by the Node-side descriptor and the Worker-side plugin; they must match). */
export const MEDIA_PLUGIN = { id: "media-assistant", version: "0.1.0" } as const;

/** Plugin KV key of the scan summary Site health reads (EmDash stores it as the D1 `options` row `plugin:<id>:<key>`). */
export const SUMMARY_KEY = "summary";
export const SUMMARY_OPTION = `plugin:${MEDIA_PLUGIN.id}:${SUMMARY_KEY}`;
