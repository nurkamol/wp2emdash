/** Test stand-in for @cf-wasm/resvg: "renders" to the PNG signature bytes. */
export class Resvg {
	constructor(_svg: string, _opts?: unknown) {}
	render() {
		return { asPng: () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) };
	}
}
