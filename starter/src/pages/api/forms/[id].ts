/** Form submissions: POST /api/forms/<form id>. The endpoint lives in @wp2emdash/forms (packages/forms). */
import { createFormEndpoint } from "@wp2emdash/forms/endpoint";
import { getForm } from "../../../forms";

export const prerender = false;
export const POST = createFormEndpoint({ getForm });
