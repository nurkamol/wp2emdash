/** Satori (layout → SVG) + resvg (SVG → PNG), both WebAssembly modules imported at build time as Workers require. */
import satori from "@cf-wasm/satori";
import { Resvg } from "@cf-wasm/resvg";
import type { Node } from "./card.js";

export async function renderPng(tree: Node, fonts: { display: ArrayBuffer; body: ArrayBuffer; displayWeight?: number }): Promise<Uint8Array> {
	const svg = await satori(tree as never, {
		width: 1200,
		height: 630,
		fonts: [
			{ name: "Display", data: fonts.display, weight: (fonts.displayWeight ?? 500) as 500, style: "normal" },
			{ name: "Body", data: fonts.body, weight: 500, style: "normal" },
		],
	});
	return new Resvg(svg, { fitTo: { mode: "width", value: 1200 } }).render().asPng();
}
