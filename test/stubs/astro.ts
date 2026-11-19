/** Test stand-in for `astro` types (installed only in generated projects): the APIRoute shape the forms endpoint uses. */
export type APIRoute = (context: { params: Record<string, string | undefined>; request: Request; locals: unknown }) => Response | Promise<Response>;
