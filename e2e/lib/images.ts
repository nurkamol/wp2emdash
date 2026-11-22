/** Solid-colour PNGs for the seeded media library: generated locally, deterministic, no stock photos. */
import { PNG } from "pngjs";
import type { PlanImage } from "./plan.js";

export function hexToRgb(hex: string): [number, number, number] {
	const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
	if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
	return [Number.parseInt(m[1] as string, 16), Number.parseInt(m[2] as string, 16), Number.parseInt(m[3] as string, 16)];
}

/** A PNG of one colour with a lighter band across the middle (so each picture is distinguishable in screenshots). */
export function solidPng(img: Pick<PlanImage, "width" | "height" | "color">): Buffer {
	const png = new PNG({ width: img.width, height: img.height });
	const [r, g, b] = hexToRgb(img.color);
	const band0 = Math.floor(img.height * 0.45);
	const band1 = Math.ceil(img.height * 0.55);
	for (let y = 0; y < img.height; y++) {
		const light = y >= band0 && y < band1;
		for (let x = 0; x < img.width; x++) {
			const i = (img.width * y + x) << 2;
			png.data[i] = light ? Math.min(255, r + 40) : r;
			png.data[i + 1] = light ? Math.min(255, g + 40) : g;
			png.data[i + 2] = light ? Math.min(255, b + 40) : b;
			png.data[i + 3] = 255;
		}
	}
	return PNG.sync.write(png, { colorType: 2 });
}
