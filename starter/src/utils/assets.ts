/**
 * The content-hashed URL of one of the site's own scripts or stylesheets (public/scripts, public/styles), written by
 * the migration kit's scaffold into site.config.json `assets` (src/scaffold/perf.ts hashStaticAssets). Browsers keep
 * /scripts/h/* and /styles/h/* for a year (public/_headers) and a changed file gets a new name. A path without an
 * entry (a project built before the map existed, or a file added by hand) is linked as it is.
 */
import site from "../site.config.json";

const map = (site as { assets?: Record<string, string> }).assets ?? {};

export const asset = (path: string): string => map[path] ?? path;
