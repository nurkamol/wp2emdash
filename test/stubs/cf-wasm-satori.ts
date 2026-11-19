/** Test stand-in for @cf-wasm/satori (installed only in projects with sharing cards): returns a fixed SVG. */
export default async function satori(_tree: unknown, _opts: { width: number; height: number; fonts: unknown[] }): Promise<string> {
	return '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"/>';
}
