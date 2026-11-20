/**
 * Comment form (components/comments/Comments.astro): shown once this runs (the form needs JavaScript for the spam check),
 * "Reply" buttons that thread a comment under another, and the submit to EmDash's public comments endpoint (JSON with
 * EmDash's X-EmDash-Request header). Nothing is stored in the browser.
 */
import { commentPayload, submitMessage } from "../utils/comments";

type TS = { reset(el?: Element): void; getResponse?(el?: Element): string | undefined };

function init(form: HTMLFormElement) {
	form.hidden = false;
	const section = form.closest("section");
	const parent = form.querySelector<HTMLInputElement>('input[name="parentId"]');
	const replying = form.querySelector<HTMLElement>("[data-replying]");
	const replyText = form.querySelector<HTMLElement>("[data-replying-text]");
	const status = form.querySelector<HTMLElement>(".form__status");
	const textarea = form.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
	const setReply = (id: string, name: string) => {
		if (parent) parent.value = id;
		if (replying && replyText) {
			replyText.textContent = id ? `Replying to ${name}. ` : "";
			replying.hidden = !id;
		}
	};
	for (const b of section?.querySelectorAll<HTMLButtonElement>("[data-reply-to]") ?? []) {
		b.hidden = false;
		b.addEventListener("click", () => {
			setReply(b.dataset.replyTo ?? "", b.dataset.replyName ?? "");
			textarea?.focus();
		});
	}
	form.querySelector("[data-reply-cancel]")?.addEventListener("click", () => {
		setReply("", "");
		textarea?.focus();
	});
	form.addEventListener("submit", async (e) => {
		e.preventDefault();
		if (!form.reportValidity()) return;
		const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
		const fields: Record<string, string> = {};
		for (const [k, v] of new FormData(form).entries()) if (typeof v === "string") fields[k] = v;
		const ts = (window as { turnstile?: TS }).turnstile;
		const box = form.querySelector(".cf-turnstile");
		const token = fields["cf-turnstile-response"] || (box ? ts?.getResponse?.(box) : undefined);
		if (button) button.disabled = true;
		if (status) status.textContent = "Sending…";
		let ok = false;
		try {
			const res = await fetch(form.dataset.endpoint ?? "", { method: "POST", headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" }, body: JSON.stringify(commentPayload(fields, token)) });
			const payload = (await res.json().catch(() => undefined)) as Parameters<typeof submitMessage>[1];
			ok = res.ok;
			if (status) status.textContent = submitMessage(res.ok, payload);
		} catch {
			if (status) status.textContent = submitMessage(false, undefined);
		} finally {
			if (button) button.disabled = false;
			// Turnstile tokens are single use.
			ts?.reset(box ?? undefined);
		}
		if (ok) {
			if (textarea) textarea.value = "";
			setReply("", "");
		}
	});
}

for (const f of document.querySelectorAll<HTMLFormElement>("form[data-comments-form]")) init(f);
