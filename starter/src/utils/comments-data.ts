/** The site's comments config (site.config.json `comments`; absent on sites without comments). Helpers: utils/comments.ts. */
import site from "../site.config.json";
import type { CommentsConfig } from "./comments";

export const commentsConfig: CommentsConfig | undefined = (site as { comments?: CommentsConfig }).comments;
