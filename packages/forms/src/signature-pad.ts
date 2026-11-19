/**
 * Signature pad for a form's signature field — browser code, no dependencies. Expected markup (the kit's starter
 * renders it; see README.md → Signature):
 *
 *   <fieldset data-signature data-required>                 ← data-required when the field is required
 *     <div data-signature-pad hidden>                         ← shown once this script runs
 *       <canvas></canvas> <button type="button" data-signature-clear>Clear</button>
 *     </div>
 *     <input type="hidden" name="signature" data-signature-value>
 *     <input type="text" name="signature_typed" required>    ← the typed-name alternative (and the no-JS fallback)
 *   </fieldset>
 *
 * Drawing works with mouse, touch and pen (pointer events). After each stroke the drawing is cropped to its strokes,
 * scaled to fit 600×200 and written to the hidden input as a PNG data URL (kept under 150 KB). Keyboard users and
 * anyone who cannot draw type their name instead; a drawing or a typed name satisfies a required field. The form's
 * `reset` clears the pad.
 */
const MAX_W = 600;
const MAX_H = 200;
const MAX_DATA_URL = Math.ceil(150_000 / 3) * 4 + 22;
const PEN = "#1a1a1a";

type Point = [number, number];

export function mountSignaturePads(root: ParentNode = document): void {
	for (const field of root.querySelectorAll<HTMLElement>("[data-signature]")) mount(field);
}

function mount(field: HTMLElement): void {
	if (field.dataset.signatureReady) return;
	const pad = field.querySelector<HTMLElement>("[data-signature-pad]");
	const canvas = pad?.querySelector("canvas");
	const hidden = field.querySelector<HTMLInputElement>("input[data-signature-value]");
	const typed = field.querySelector<HTMLInputElement>('input[type="text"]');
	const ctx = canvas?.getContext("2d");
	if (!pad || !canvas || !hidden || !ctx) return;
	field.dataset.signatureReady = "1";
	const required = field.hasAttribute("data-required");
	pad.hidden = false;
	field.classList.add("has-pad");

	const strokes: Point[][] = [];
	let current: Point[] | null = null;
	let width = 0;
	const lineWidth = () => Math.max(1.5, Math.min(3, width / 220));

	const draw = (c: CanvasRenderingContext2D, list: Point[][], scale: number, dx: number, dy: number, lw: number) => {
		c.strokeStyle = PEN;
		c.fillStyle = PEN;
		c.lineWidth = lw;
		c.lineCap = "round";
		c.lineJoin = "round";
		for (const s of list) {
			const [first] = s;
			if (!first) continue;
			if (s.length === 1) {
				c.beginPath();
				c.arc((first[0] - dx) * scale, (first[1] - dy) * scale, lw / 2, 0, Math.PI * 2);
				c.fill();
				continue;
			}
			c.beginPath();
			c.moveTo((first[0] - dx) * scale, (first[1] - dy) * scale);
			for (let i = 1; i < s.length; i++) {
				const p = s[i] as Point;
				c.lineTo((p[0] - dx) * scale, (p[1] - dy) * scale);
			}
			c.stroke();
		}
	};

	const resize = () => {
		const rect = canvas.getBoundingClientRect();
		if (!rect.width) return;
		const ratio = window.devicePixelRatio || 1;
		width = rect.width;
		canvas.width = Math.round(rect.width * ratio);
		canvas.height = Math.round(rect.height * ratio);
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, rect.width, rect.height);
		draw(ctx, strokes, 1, 0, 0, lineWidth());
	};

	/** The strokes, cropped and scaled to fit 600×200, on white, as a PNG data URL under the size cap. */
	const exportPng = (): string => {
		const pts = strokes.flat();
		if (!pts.length) return "";
		const pad = lineWidth() + 4;
		const minX = Math.min(...pts.map((p) => p[0])) - pad;
		const minY = Math.min(...pts.map((p) => p[1])) - pad;
		const w = Math.max(...pts.map((p) => p[0])) + pad - minX;
		const h = Math.max(...pts.map((p) => p[1])) + pad - minY;
		let scale = Math.min(1.5, MAX_W / w, MAX_H / h);
		for (let attempt = 0; attempt < 5; attempt++) {
			const out = document.createElement("canvas");
			out.width = Math.max(1, Math.min(MAX_W, Math.ceil(w * scale)));
			out.height = Math.max(1, Math.min(MAX_H, Math.ceil(h * scale)));
			const c = out.getContext("2d");
			if (!c) return "";
			c.fillStyle = "#fff";
			c.fillRect(0, 0, out.width, out.height);
			draw(c, strokes, scale, minX, minY, Math.max(1.5, lineWidth() * scale));
			const url = out.toDataURL("image/png");
			if (url.length <= MAX_DATA_URL) return url;
			scale *= 0.7;
		}
		return "";
	};

	const update = () => {
		hidden.value = exportPng();
		const signed = !!hidden.value;
		field.classList.toggle("is-signed", signed);
		if (typed) typed.required = required && !signed;
		if (signed) {
			field.classList.remove("is-invalid");
			const err = field.querySelector<HTMLElement>(".field__error");
			if (err) err.textContent = "";
		}
	};

	const clear = () => {
		strokes.length = 0;
		current = null;
		resize();
		hidden.value = "";
		field.classList.remove("is-signed");
		if (typed) typed.required = required && !typed.value.trim();
	};

	const point = (e: PointerEvent): Point => {
		const r = canvas.getBoundingClientRect();
		return [Math.round((e.clientX - r.left) * 10) / 10, Math.round((e.clientY - r.top) * 10) / 10];
	};
	canvas.addEventListener("pointerdown", (e) => {
		if (e.button !== 0 && e.pointerType === "mouse") return;
		e.preventDefault();
		canvas.setPointerCapture(e.pointerId);
		current = [point(e)];
		strokes.push(current);
		draw(ctx, [current], 1, 0, 0, lineWidth());
	});
	canvas.addEventListener("pointermove", (e) => {
		if (!current) return;
		e.preventDefault();
		const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [];
		for (const ev of events.length ? events : [e]) {
			const last = current[current.length - 1] as Point;
			const p = point(ev);
			if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 0.5) continue;
			current.push(p);
			draw(ctx, [[last, p]], 1, 0, 0, lineWidth());
		}
	});
	const end = () => {
		if (!current) return;
		current = null;
		update();
	};
	canvas.addEventListener("pointerup", end);
	canvas.addEventListener("pointercancel", end);
	canvas.addEventListener("lostpointercapture", end);
	pad.querySelector<HTMLButtonElement>("[data-signature-clear]")?.addEventListener("click", () => {
		clear();
		typed?.focus();
	});
	typed?.addEventListener("input", () => {
		if (!strokes.length) typed.required = required && !typed.value.trim();
	});
	field.closest("form")?.addEventListener("reset", () => setTimeout(clear, 0));
	// The pad's pixel size follows its CSS size (and the screen's density); strokes are kept and redrawn.
	if (typeof ResizeObserver === "function") new ResizeObserver(resize).observe(canvas);
	else window.addEventListener("resize", resize);
	resize();
}
