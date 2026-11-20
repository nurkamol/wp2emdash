/** One-time download links for files sent with a form (file upload fields): GET shows a Download button, POST sends the file once. */
import { env } from "cloudflare:workers";
import { createDownloadHandlers, type UploadEnv } from "@wp2emdash/forms/uploads";

export const prerender = false;
const h = createDownloadHandlers(() => env as unknown as UploadEnv);
export const GET = h.GET;
export const POST = h.POST;
