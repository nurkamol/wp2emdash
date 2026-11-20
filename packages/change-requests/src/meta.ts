/** Plugin identity (shared by the Node-side descriptor and the Worker-side plugin; they must match). */
export const CR_PLUGIN = { id: "change-requests", version: "0.1.0" } as const;

/** Plugin KV prefix of the requests themselves (EmDash stores each as the D1 `options` row `plugin:<id>:req:<id>`). */
export const REQUEST_PREFIX = "req:";
/** The `options` rows Backups copies: the requests only — never grants, tickets or other rows of this plugin. */
export const REQUEST_OPTION_PREFIX = `plugin:${CR_PLUGIN.id}:${REQUEST_PREFIX}`;
/** R2 prefix of attachments: under `backups/`, which EmDash's public media route never serves. */
export const ATTACHMENT_PREFIX = "backups/change-requests/";
/** Admin page paths. `/requests/<id>` deep-links one request (emails link there). */
export const PAGE = "/requests";
export const ATTACH_PAGE = "/attach";
export const WIDGET = "change-requests";
/** Worker secret that signs the webhook (never in kit.config, never logged). */
export const WEBHOOK_SECRET = "CHANGE_REQUESTS_WEBHOOK_SECRET";
