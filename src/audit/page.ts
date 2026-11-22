import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { isInternal, normalizeUrl, type SiteHosts } from "./urls.js";

export interface FormField {
	name: string;
	type: string;
	label?: string;
	required: boolean;
	options?: string[];
	placeholder?: string;
}

export interface FormSnapshot {
	/** Stable id: provider + provider form id, or a hash of the field list. */
	id: string;
	provider: string;
	providerFormId?: string;
	action?: string;
	method?: string;
	fields: FormField[];
	hasCaptcha: string[];
	submitLabel?: string;
	/** True when the form sits inside a popup/modal (e.g. Popup Maker). */
	inPopup: boolean;
}

export interface PageSnapshot {
	url: string;
	finalUrl: string;
	status: number;
	redirects: { url: string; status: number }[];
	contentType: string;
	ms: number;
	error?: string;
	seo: {
		title?: string;
		description?: string;
		canonical?: string;
		robots?: string;
		xRobotsTag?: string;
		og: Record<string, string>;
		twitter: Record<string, string>;
		/** Site-ownership meta tags (Search Console, Bing, Pinterest, Facebook, Yandex): they must survive the move. */
		verification?: Record<string, string>;
		jsonLdTypes: string[];
		jsonLd: unknown[];
		hreflang: { lang: string; href: string }[];
		lang?: string;
	};
	headings: { level: number; text: string }[];
	text: string;
	textHash: string;
	wordCount: number;
	links: { href: string; text: string; internal: boolean; rel?: string; target?: string }[];
	images: { src: string; alt?: string; width?: string; height?: string; srcset?: boolean; lazy?: boolean }[];
	backgroundImages: string[];
	forms: FormSnapshot[];
	iframes: string[];
	scripts: { src?: string; inlineSample?: string }[];
	stylesheets: string[];
	bodyClasses: string[];
	builders: string[];
	/** Builder buttons in the page (header and footer ones included); pages above the site minimum have content buttons. */
	buttonCount?: number;
	shortcodeLeftovers: string[];
	/** Analytics/ads ids found anywhere in the raw HTML (incl. <noscript>). */
	trackingIds: string[];
	/** WordPress post id from body class (page-id-12 / postid-12). */
	wpId?: number;
	wpType?: string;
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

export function hashText(text: string): string {
	return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** Content buttons of the common builders: Salient, WPBakery, Gutenberg, Elementor. */
const CONTENT_BUTTON = /class="(?:[^"]*\s)?(?:nectar-button|vc_btn3|wp-block-button__link|elementor-button)(?=[\s"])/g;

/** Builder markers in rendered HTML. */
export function detectBuilders(html: string, bodyClasses: string[]): string[] {
	const found = new Set<string>();
	if (/\bvc_row\b|\bwpb_(row|column|wrapper|content_element)\b|js_composer/.test(html)) found.add("wpbakery");
	if (/\bnectar-|salient/i.test(html)) found.add("salient");
	if (/\belementor-(section|element|widget)\b|data-elementor-type/.test(html)) found.add("elementor");
	if (/\bbrxe-|bricks-/.test(html)) found.add("bricks");
	if (/\bet_pb_(section|row|module)\b/.test(html)) found.add("divi");
	if (/\bwp-block-(?!library)[a-z-]+/.test(html)) found.add("gutenberg");
	if (bodyClasses.some((c) => c.startsWith("elementor-page"))) found.add("elementor");
	return [...found];
}

function formProvider($form: cheerio.Cheerio<never>, html: string): { provider: string; id?: string } {
	const cls = $form.attr("class") ?? "";
	const dataId = $form.attr("data-form_id") ?? $form.attr("data-formid");
	if (/fluent_form|frm-fluent-form/.test(cls) || $form.find('[name^="_fluentform_"]').length) return { provider: "fluent-forms", id: dataId ?? $form.attr("id")?.match(/\d+/)?.[0] };
	// CF7 wraps the form in <div class="wpcf7" id="wpcf7-f<post id>-p<page>-o<n>">: the post id is the form's id.
	if (/wpcf7-form/.test(cls)) {
		const wrap = $form.closest(".wpcf7").attr("id") ?? "";
		return { provider: "contact-form-7", id: /^wpcf7-f(\d+)/.exec(wrap)?.[1] ?? (wrap || undefined) };
	}
	if (/wpforms-form/.test(cls)) return { provider: "wpforms", id: $form.attr("data-formid") };
	if ($form.closest(".gform_wrapper").length || /gform/.test($form.attr("id") ?? "")) return { provider: "gravity-forms", id: $form.attr("id")?.match(/\d+/)?.[0] };
	if (/nf-form|ninja/.test(cls) || $form.closest("[id^=nf-form-]").length) return { provider: "ninja-forms", id: /nf-form-(\d+)/.exec($form.closest("[id^=nf-form-]").attr("id") ?? "")?.[1] };
	if (/frm-show-form/.test(cls)) return { provider: "formidable", id: $form.find('input[name="form_id"]').attr("value") ?? /form_(?:\w+_)?(\d+)/.exec($form.attr("id") ?? "")?.[1] };
	if (/\bwsf-form\b/.test(cls)) return { provider: "ws-form", id: $form.attr("data-id") ?? $form.find('input[name="wsf_form_id"]').attr("value") };
	if (/forminator-custom-form|forminator-ui/.test(cls)) return { provider: "forminator", id: $form.attr("data-form-id") ?? $form.find('input[name="form_id"]').attr("value") };
	if (/elementor-form/.test(cls)) return { provider: "elementor-forms" };
	// WooCommerce's own shop forms (add to cart, variations, sorting, cart, checkout, account, product search): catalogue
	// mode replaces them with the Buy button, so they are not content forms to rebuild (WordPress e2e test, 2026-11-22).
	if (/\b(cart|variations_form|woocommerce-ordering|woocommerce-cart-form|checkout|woocommerce-checkout|woocommerce-form-login|woocommerce-form-register|woocommerce-form-coupon|woocommerce-product-search|lost_reset_password|woocommerce-ResetPassword|woocommerce-EditAccountForm)\b/.test(cls) || $form.find('[name="add-to-cart"], [name="woocommerce-cart-nonce"], [name="woocommerce-process-checkout-nonce"]').length) return { provider: "woocommerce" };
	if (/search-form|searchform/.test(cls) || $form.find('input[name="s"]').length) return { provider: "wp-search" };
	if (/mc4wp|mailchimp/.test(cls + ($form.attr("action") ?? ""))) return { provider: "mailchimp" };
	if (/hs-form|hubspot/.test(cls)) return { provider: "hubspot" };
	void html;
	return { provider: "html" };
}

/** Forms that are part of WordPress or the shop rather than site content: never rebuilt, never counted as live forms. */
export const NON_CONTENT_FORMS: ReadonlySet<string> = new Set(["wp-search", "woocommerce"]);
export const isContentForm = (provider: string): boolean => !NON_CONTENT_FORMS.has(provider);

const fid2 = (f: { attribs?: Record<string, string> }) => f.attribs?.id;

export function extractForms($: cheerio.CheerioAPI, html: string): FormSnapshot[] {
	const forms: FormSnapshot[] = [];
	$("form").each((_, el) => {
		const $form = $(el) as unknown as cheerio.Cheerio<never>;
		const { provider, id } = formProvider($form, html);
		const fields: FormField[] = [];
		const seen = new Set<string>();
		$(el)
			.find("input, select, textarea")
			.each((__, f) => {
				const $f = $(f);
				const raw = (f.tagName === "input" ? ($f.attr("type") ?? "text") : f.tagName).toLowerCase();
				// Date pickers are text inputs a script turns into a calendar (Fluent `data-type-datepicker`, flatpickr);
				// a native date/time input is the same field.
				const picker = raw === "text" && ($f.is("[data-type-datepicker]") || /\b(flatpickr-input|datepicker|ff-el-datepicker)\b/.test($f.attr("class") ?? ""));
				const type = picker || raw === "datetime-local" ? "date" : raw;
				const name = $f.attr("name") ?? "";
				if (!name || ["hidden", "submit", "button", "image", "reset"].includes(type)) return;
				if (/^(_|__)|nonce|honeypot|g-recaptcha|cf-turnstile|ak_|_wp_http_referer/i.test(name)) return;
				const key = `${name}:${type}`;
				if (seen.has(key)) {
					// More radio buttons / checkboxes of the same group: their labels are the options.
					if (type === "radio" || type === "checkbox") {
						const prev = fields.find((x) => x.name === name && x.type === type);
						const optLabel = clean($f.closest("label").text() || (fid2(f) ? $(el).find(`label[for="${fid2(f)}"]`).first().text() : "") || $f.attr("value"));
						if (prev && optLabel) prev.options = [...(prev.options ?? []), optLabel];
					}
					return;
				}
				seen.add(key);
				const fid = $f.attr("id");
				const label = clean(
					((type === "radio" || type === "checkbox") && $f.closest("fieldset").length ? $f.closest("fieldset").find("legend").first().text() : "") ||
						(fid ? $(el).find(`label[for="${fid}"]`).first().text() : "") ||
						$f.closest("label").text() ||
						$f.closest(".ff-el-group, .wpforms-field, .gfield, .form-group, p").find("label").first().text() ||
						$f.attr("aria-label"),
				);
				const options =
					type === "select"
						? $f
								.find("option")
								.map((___, o) => clean($(o).text()))
								.get()
								.filter(Boolean)
						: type === "radio" || type === "checkbox"
							? [clean($f.closest("label").text() || (fid ? $(el).find(`label[for="${fid}"]`).first().text() : "") || $f.attr("value"))].filter(Boolean)
							: undefined;
				fields.push({
					name,
					type,
					label: label || undefined,
					required: $f.is("[required]") || $f.attr("aria-required") === "true" || /required/.test($f.closest(".ff-el-group, .gfield, .wpforms-field").attr("class") ?? ""),
					options: options?.length ? options : undefined,
					placeholder: $f.attr("placeholder") || undefined,
				});
			});
		const captcha: string[] = [];
		const inner = $.html(el);
		if (/g-recaptcha|recaptcha/i.test(inner)) captcha.push("recaptcha");
		if (/h-captcha|hcaptcha/i.test(inner)) captcha.push("hcaptcha");
		if (/cf-turnstile/i.test(inner)) captcha.push("turnstile");
		if (/honeypot|ff_hp|_hp_|ak_hp/i.test(inner)) captcha.push("honeypot");
		const submit = clean($(el).find('button[type="submit"], input[type="submit"], button:not([type])').first().text() || $(el).find('input[type="submit"]').attr("value"));
		const fingerprint = hashText(fields.map((f) => `${f.name}:${f.type}`).join("|"));
		forms.push({
			id: id ? `${provider}:${id}` : `${provider}:${fingerprint}`,
			provider,
			providerFormId: id,
			action: $(el).attr("action") || undefined,
			method: ($(el).attr("method") || "get").toLowerCase(),
			fields,
			hasCaptcha: captcha,
			submitLabel: submit || undefined,
			inPopup: $(el).closest(".pum, .pum-container, .popmake, [class*='modal'], [class*='popup']").length > 0,
		});
	});
	return forms;
}

/** Visible text of the main content area, normalised for comparisons. */
function visibleText($: cheerio.CheerioAPI): string {
	const $body = $("body").clone();
	$body.find("script, style, noscript, template, svg, iframe, link, meta").remove();
	$body.find("[hidden], [aria-hidden='true'], .screen-reader-text, .sr-only").remove();
	return clean($body.text());
}

/** Cloudflare Email Address Obfuscation: hex string, first byte is the XOR key. */
export function decodeCfEmail(hex: string): string {
	const key = Number.parseInt(hex.slice(0, 2), 16);
	let out = "";
	for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16) ^ key);
	return out;
}

/** Undo Cloudflare email obfuscation so links and visible text show the real addresses. */
export function restoreCfEmails($: cheerio.CheerioAPI): void {
	$("a[href*='/cdn-cgi/l/email-protection']").each((_, a) => {
		const hex = ($(a).attr("href") ?? "").split("#")[1];
		if (hex && /^[0-9a-f]+$/i.test(hex)) $(a).attr("href", `mailto:${decodeCfEmail(hex)}`);
	});
	$("[data-cfemail]").each((_, el) => {
		const hex = $(el).attr("data-cfemail");
		if (hex && /^[0-9a-f]+$/i.test(hex)) $(el).replaceWith(decodeCfEmail(hex));
	});
}

export function parsePage(html: string, meta: Pick<PageSnapshot, "url" | "finalUrl" | "status" | "redirects" | "contentType" | "ms"> & { xRobotsTag?: string }, site: SiteHosts): PageSnapshot {
	const $ = cheerio.load(html);
	restoreCfEmails($);
	const bodyClasses = ($("body").attr("class") ?? "").split(/\s+/).filter(Boolean);

	const metaContent = (sel: string) => $(sel).attr("content") || undefined;
	const og: Record<string, string> = {};
	const twitter: Record<string, string> = {};
	$('meta[property^="og:"], meta[property^="article:"]').each((_, m) => {
		const k = $(m).attr("property");
		if (k) og[k] = $(m).attr("content") ?? "";
	});
	$('meta[name^="twitter:"]').each((_, m) => {
		const k = $(m).attr("name");
		if (k) twitter[k] = $(m).attr("content") ?? "";
	});

	const jsonLd: unknown[] = [];
	const jsonLdTypes = new Set<string>();
	$('script[type="application/ld+json"]').each((_, s) => {
		try {
			const data = JSON.parse($(s).text());
			jsonLd.push(data);
			const visit = (n: unknown) => {
				if (Array.isArray(n)) return n.forEach(visit);
				if (n && typeof n === "object") {
					const t = (n as Record<string, unknown>)["@type"];
					for (const x of Array.isArray(t) ? t : [t]) if (typeof x === "string") jsonLdTypes.add(x);
					const graph = (n as Record<string, unknown>)["@graph"];
					if (graph) visit(graph);
				}
			};
			visit(data);
		} catch {
			/* invalid JSON-LD is itself a finding, but not fatal */
		}
	});

	const links: PageSnapshot["links"] = [];
	$("a[href]").each((_, a) => {
		const raw = ($(a).attr("href") ?? "").trim();
		if (!raw || raw.startsWith("#") || raw.startsWith("javascript:")) return;
		let href = raw;
		let internal = false;
		if (/^(mailto|tel|sms|whatsapp):/i.test(raw)) {
			href = raw;
		} else {
			try {
				const abs = new URL(raw, meta.finalUrl).href;
				internal = isInternal(abs, site);
				href = internal ? normalizeUrl(abs, site) : abs;
			} catch {
				return;
			}
		}
		links.push({ href, text: clean($(a).text()) || clean($(a).attr("aria-label")) || clean($(a).find("img").attr("alt")), internal, rel: $(a).attr("rel") || undefined, target: $(a).attr("target") || undefined });
	});

	const images: PageSnapshot["images"] = [];
	$("img").each((_, img) => {
		const $i = $(img);
		const src = $i.attr("data-src") || $i.attr("data-lazy-src") || $i.attr("src") || "";
		if (!src || src.startsWith("data:")) return;
		try {
			images.push({
				src: new URL(src, meta.finalUrl).href,
				alt: $i.attr("alt"),
				width: $i.attr("width"),
				height: $i.attr("height"),
				srcset: !!($i.attr("srcset") || $i.attr("data-srcset")),
				lazy: $i.attr("loading") === "lazy" || !!$i.attr("data-src"),
			});
		} catch {
			/* skip malformed */
		}
	});

	const backgroundImages = new Set<string>();
	const bgAttrs = $("[style*='background'], [data-bg-image], [data-bg], [data-nectar-img-src]");
	bgAttrs.each((_, el) => {
		const style = $(el).attr("style") ?? "";
		for (const m of style.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)) if (m[1] && !m[1].startsWith("data:")) backgroundImages.add(new URL(m[1], meta.finalUrl).href);
		for (const attr of ["data-bg-image", "data-bg", "data-nectar-img-src"]) {
			const v = $(el).attr(attr);
			if (v && /^(https?:)?\/\/|^\//.test(v)) backgroundImages.add(new URL(v, meta.finalUrl).href);
		}
	});

	const text = visibleText($);
	const idClass = bodyClasses.find((c) => /^(page-id|postid)-\d+$/.test(c));
	const typeClass = bodyClasses.find((c) => /^single-[a-z0-9_-]+$/.test(c))?.replace("single-", "") ?? (bodyClasses.includes("page") ? "page" : undefined);

	return {
		...meta,
		seo: {
			title: clean($("head > title").first().text()) || undefined,
			description: metaContent('meta[name="description"]'),
			canonical: $('link[rel="canonical"]').attr("href") || undefined,
			robots: metaContent('meta[name="robots"]'),
			xRobotsTag: meta.xRobotsTag,
			og,
			twitter,
			verification: Object.fromEntries(
				$('meta[name="google-site-verification"], meta[name="msvalidate.01"], meta[name="p:domain_verify"], meta[name="facebook-domain-verification"], meta[name="yandex-verification"]')
					.map((_, m) => [[$(m).attr("name") ?? "", $(m).attr("content") ?? ""]])
					.get()
					.filter(([k, v]: string[]) => k && v),
			),
			jsonLdTypes: [...jsonLdTypes].sort(),
			jsonLd,
			hreflang: $('link[rel="alternate"][hreflang]')
				.map((_, l) => ({ lang: $(l).attr("hreflang") ?? "", href: $(l).attr("href") ?? "" }))
				.get(),
			lang: $("html").attr("lang") || undefined,
		},
		headings: $("h1, h2, h3, h4")
			.map((_, h) => ({ level: Number(h.tagName.slice(1)), text: clean($(h).text()) }))
			.get()
			.filter((h) => h.text),
		text,
		textHash: hashText(text),
		wordCount: text ? text.split(" ").length : 0,
		links,
		images,
		backgroundImages: [...backgroundImages],
		forms: extractForms($, html),
		iframes: $("iframe")
			.map((_, f) => $(f).attr("src") || $(f).attr("data-src") || "")
			.get()
			.filter(Boolean),
		scripts: $("script:not([type='application/ld+json'])")
			.map((_, s) => {
				const src = $(s).attr("src");
				const inline = src ? undefined : $(s).text().trim().slice(0, 300);
				return { src: src || undefined, inlineSample: inline || undefined };
			})
			.get(),
		stylesheets: $('link[rel="stylesheet"]')
			.map((_, l) => $(l).attr("href") ?? "")
			.get()
			.filter(Boolean),
		bodyClasses,
		builders: detectBuilders(html, bodyClasses),
		buttonCount: html.match(CONTENT_BUTTON)?.length ?? 0,
		shortcodeLeftovers: [...new Set([...text.matchAll(/\[\/?([a-z][a-z0-9_-]{2,})(?:\s[^\]]*)?\]/g)].map((m) => m[1] as string))],
		trackingIds: [...new Set([...html.matchAll(/\b(GT-[A-Z0-9]{6,12}|G-[A-Z0-9]{8,12}|GTM-[A-Z0-9]{5,9}|AW-\d{8,12}|UA-\d{4,10}-\d{1,4})\b/g)].map((m) => m[1] as string))].sort(),
		wpId: idClass ? Number(idClass.split("-").pop()) : undefined,
		wpType: typeClass,
	};
}
