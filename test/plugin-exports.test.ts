import { describe, expect, it } from "vitest";
import { accessSection, exportsFor, parseServerRules, recognise, regexToPattern, toPath, withAccessSection } from "../src/extract/plugin-exports.js";

const hosts = ["acme.example"];

describe("what to ask the owner for", () => {
	it("picks exports from the detected plugins and form providers", () => {
		const ids = exportsFor(["Fluent Forms", "Rank Math SEO", "gravity-forms", "WPBakery Page Builder"]).map((s) => s.id);
		expect(ids).toEqual(["fluent-forms", "gravity-forms", "rank-math-redirects"]);
	});
	it("writes a marked ACCESS.md section, required for forms without REST, keeping the owner's ticks on rerun", () => {
		const specs = exportsFor(["gravity-forms", "Fluent Forms", "Redirection"]);
		const first = withAccessSection("# Access\n\n## Before audit\n- [x] (required) Backup\n", accessSection(specs, "acme"));
		expect(first).toContain("- [ ] (required) **Gravity Forms**: Forms → Import/Export");
		expect(first).toContain("- [ ] **Fluent Forms**");
		expect(first).toContain("sites/acme/raw/plugin-exports/");
		const ticked = first.replace("- [ ] (required) **Gravity Forms**", "- [x] (required) **Gravity Forms**");
		const again = withAccessSection(ticked, accessSection(specs, "acme", ticked));
		expect(again).toContain("- [x] (required) **Gravity Forms**");
		expect(again.match(/Plugin data \(before extract\)/g)).toHaveLength(1);
		expect(again).toContain("- [x] (required) Backup");
	});
});

describe("forms from plugin exports", () => {
	it("Gravity Forms JSON: fields, name inputs, consent, confirmation, recipients", () => {
		const gf = {
			"0": {
				id: 3,
				title: "Contact",
				is_active: "1",
				button: { text: "Send message" },
				fields: [
					{ id: 1, type: "name", label: "Name", isRequired: true, inputs: [{ id: "1.3", label: "First" }, { id: "1.6", label: "Last" }, { id: "1.2", label: "Prefix", isHidden: true }] },
					{ id: 2, type: "email", label: "Email", isRequired: true },
					{ id: 3, type: "select", label: "Topic", choices: [{ text: "Classes" }, { text: "Other" }] },
					{ id: 4, type: "textarea", label: "Message" },
					{ id: 5, type: "consent", label: "Consent", checkboxLabel: "I agree to the terms", isRequired: true },
					{ id: 6, type: "fileupload", label: "CV" },
					{ id: 7, type: "html", label: "" },
				],
				confirmations: { a: { type: "message", isDefault: true, message: "<p>Thanks, we'll reply soon.</p>" } },
				notifications: { n: { to: "owner@acme.example, team@acme.example", isActive: true } },
			},
			version: "2.8.1",
		};
		const r = recognise("forms.json", JSON.stringify(gf), hosts);
		expect(r.kind === "forms" && r.provider).toBe("gravity-forms");
		const f = r.kind === "forms" ? r.forms[0] : undefined;
		expect(f?.definition?.id).toBe("gravity-forms-3");
		expect(f?.definition?.submitLabel).toBe("Send message");
		expect(f?.definition?.successMessage).toBe("Thanks, we'll reply soon.");
		expect(f?.definition?.fields.map((x) => `${x.name}:${x.type}${x.required ? "*" : ""}`)).toEqual(["first_name:text*", "last_name:text*", "email:email*", "topic:select", "message:textarea", "consent:checkbox*", "cv:file"]);
		expect(f?.definition?.fields[4]?.label).toBe("Message");
		expect(f?.definition?.fields[5]?.label).toBe("I agree to the terms");
		expect(f?.definition?.warnings).toEqual([]);
		expect(f?.recipients).toEqual(["owner@acme.example", "team@acme.example"]);
	});

	it("WPForms JSON: first/last name, choices, admin_email warning", () => {
		const wp = [
			{
				id: 12,
				fields: { "0": { id: 0, type: "name", format: "first-last", label: "Name", required: "1" }, "1": { id: 1, type: "email", label: "Email", required: "1" }, "2": { id: 2, type: "radio", label: "Preferred time", choices: { "1": { label: "Morning" }, "2": { label: "Evening" } } }, "3": { id: 3, type: "textarea", label: "Comment or Message" } },
				settings: { form_title: "Simple Contact Form", submit_text: "Submit", confirmations: { "1": { type: "message", message: "Thanks for contacting us!" } }, notifications: { "1": { email: "{admin_email}" } } },
			},
		];
		const r = recognise("wpforms-export.json", JSON.stringify(wp), hosts);
		expect(r.kind === "forms" && r.provider).toBe("wpforms");
		const d = r.kind === "forms" ? r.forms[0]?.definition : undefined;
		expect(d?.fields.map((x) => x.name)).toEqual(["first_name", "last_name", "email", "preferred_time", "comment_or_message"]);
		expect(d?.fields[3]?.options).toEqual(["Morning", "Evening"]);
		expect(d?.warnings.join()).toMatch(/admin_email/);
	});

	it("Contact Form 7 from a WordPress export: label text, placeholders, acceptance, message and recipient", () => {
		const form = `<label> Your name\n    [text* your-name autocomplete:name] </label>\n\n<label> Your email\n    [email* your-email] </label>\n\n<label> Phone [tel your-phone placeholder "555-0100"] </label>\n\n[select topic "Classes" "Private sessions"]\n\n<label> Your message (optional)\n    [textarea your-message] </label>\n\n[acceptance terms]I agree to the privacy policy[/acceptance]\n\n[file cv]\n\n[submit "Book now"]`;
		const mail = 'a:2:{s:9:"recipient";s:21:"studio@acme.example";s:7:"subject";s:4:"Test";}';
		const msgs = 'a:1:{s:12:"mail_sent_ok";s:38:"Thank you for your message. It has been sent.";}';
		const xml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[Contact form 1]]></title><wp:post_id>55</wp:post_id><wp:status><![CDATA[publish]]></wp:status><wp:post_type><![CDATA[wpcf7_contact_form]]></wp:post_type>
<wp:postmeta><wp:meta_key><![CDATA[_form]]></wp:meta_key><wp:meta_value><![CDATA[${form}]]></wp:meta_value></wp:postmeta>
<wp:postmeta><wp:meta_key><![CDATA[_mail]]></wp:meta_key><wp:meta_value><![CDATA[${mail}]]></wp:meta_value></wp:postmeta>
<wp:postmeta><wp:meta_key><![CDATA[_messages]]></wp:meta_key><wp:meta_value><![CDATA[${msgs}]]></wp:meta_value></wp:postmeta></item>
<item><title>Some page</title><wp:post_type>page</wp:post_type></item></channel></rss>`;
		const r = recognise("export.xml", xml, hosts);
		expect(r.kind === "forms" && r.provider).toBe("contact-form-7");
		const f = r.kind === "forms" ? r.forms : [];
		expect(f).toHaveLength(1);
		const d = f[0]?.definition;
		expect(d?.id).toBe("contact-form-7-55");
		expect(d?.submitLabel).toBe("Book now");
		expect(d?.successMessage).toMatch(/^Thank you for your message/);
		expect(d?.fields.map((x) => `${x.name}:${x.type}${x.required ? "*" : ""}:${x.label}`)).toEqual(["your_name:text*:Your name", "your_email:email*:Your email", "your_phone:tel:Phone", "topic:select:topic", "your_message:textarea:Your message (optional)", "terms:checkbox*:I agree to the privacy policy", "cv:file:cv"]);
		expect(d?.fields[2]?.placeholder).toBe("555-0100");
		expect(d?.fields[3]?.options).toEqual(["Classes", "Private sessions"]);
		// File uploads are carried since forms 1.7 (CF7's default limit: 1 MB).
		expect(d?.fields[6]).toMatchObject({ type: "file", maxMb: 1 });
		expect(d?.warnings).toEqual([]);
		expect(f[0]?.recipients).toEqual(["studio@acme.example"]);
	});

	it("Fluent Forms export keeps the REST shape scaffold already converts", () => {
		const ff = [{ id: 4, title: "Contact", status: "published", form_fields: JSON.stringify({ fields: [{ element: "input_email", attributes: { name: "email" }, settings: { label: "Email" } }] }), metas: [{ meta_key: "formSettings", value: JSON.stringify({ confirmation: { messageToShow: "Thanks" } }) }, { meta_key: "notifications", value: JSON.stringify({ sendTo: { email: "a@acme.example" } }) }] }];
		const r = recognise("fluentform-export.json", JSON.stringify(ff), hosts);
		expect(r.kind === "forms" && r.provider).toBe("fluent-forms");
		const f = r.kind === "forms" ? r.forms[0] : undefined;
		expect((f?.raw?.form as { form_fields: { fields: unknown[] } }).form_fields.fields).toHaveLength(1);
		expect((f?.raw?.settings as { formSettings: { value: { confirmation: { messageToShow: string } } }[] }).formSettings[0]?.value.confirmation.messageToShow).toBe("Thanks");
		expect(f?.recipients).toEqual(["a@acme.example"]);
	});
});

describe("redirects from plugin exports", () => {
	it("absolute URLs on this site become paths; other sites are reported", () => {
		expect(toPath("https://www.acme.example/new/?a=1", hosts)).toBe("/new/?a=1");
		expect(toPath("old-page", hosts)).toBe("/old-page");
		expect(toPath("https://elsewhere.example/x", hosts)).toBeUndefined();
	});
	it("only simple regexes become route patterns", () => {
		expect(regexToPattern("^/blog/(.*)$", "/news/$1")).toEqual({ source: "/blog/[...path]", destination: "/news/[...path]" });
		expect(regexToPattern("^/old-page/?$", "/new")).toEqual({ source: "/old-page", destination: "/new" });
		expect(regexToPattern("^/(\\d+)/(.*)$", "/$2")).toBeUndefined();
	});
	it("Redirection JSON: url rules, 410s, regex, conditional rules reported", () => {
		const json = {
			plugin: { version: "5.5" },
			redirects: [
				{ url: "/old", match_type: "url", action_type: "url", action_code: 301, action_data: { url: "https://acme.example/new" }, regex: false, enabled: true },
				{ url: "/gone", match_type: "url", action_type: "error", action_code: 410, regex: false },
				{ url: "^/blog/(.*)$", match_type: "url", action_type: "url", action_code: 302, action_data: { url: "/news/$1" }, regex: true },
				{ url: "/login-only", match_type: "login", action_type: "url", action_data: { logged_in: "/a" } },
				{ url: "/partner", match_type: "url", action_type: "url", action_code: 301, action_data: { url: "https://partner.example/" } },
				{ url: "/off", match_type: "url", action_type: "url", action_data: { url: "/x" }, enabled: false },
			],
		};
		const r = recognise("redirection.json", JSON.stringify(json), hosts);
		expect(r.kind).toBe("redirects");
		if (r.kind !== "redirects") return;
		expect(r.rules).toEqual([
			{ source: "/old", destination: "/new", type: 301, from: "redirection" },
			{ source: "/gone", destination: "", type: 410, from: "redirection" },
			{ source: "/blog/[...path]", destination: "/news/[...path]", type: 302, from: "redirection" },
		]);
		expect(r.unconverted.map((u) => u.reason)).toEqual([expect.stringMatching(/login/), expect.stringMatching(/another site/)]);
	});
	it("Rank Math .htaccess and Nginx exports", () => {
		const ht = `# Created by Rank Math\n<IfModule mod_rewrite.c>\nRewriteEngine On\nRedirect 301 "/about-old" "https://acme.example/about/"\nRewriteRule ^shop/(.*)$ /store/$1 [R=301,L]\nRewriteCond %{QUERY_STRING} id=1\nRewriteRule ^p$ /x [R=301,L]\n</IfModule>`;
		const a = recognise(".htaccess", ht, hosts);
		expect(a.kind === "redirects" && a.rules.map((x) => `${x.source}>${x.destination}`)).toEqual(["/about-old>/about/", "/shop/[...path]>/store/[...path]", "/p>/x"]);
		expect(a.kind === "redirects" && a.unconverted.map((x) => x.reason)).toEqual(["conditional rule (RewriteCond)"]);
		const n = parseServerRules("location = /old { return 301 https://acme.example/new; }\nrewrite ^/a/?$ /b permanent;", hosts, "nginx");
		expect(n.rules.map((x) => `${x.source}>${x.destination}:${x.type}`)).toEqual(["/old>/new:301", "/a>/b:301"]);
	});
	it("Yoast CSV with a header, and a plain from,to,code CSV", () => {
		const y = recognise("yoast-redirects.csv", '"Origin","Target","Type","Format"\n"old-a","new-a","301","plain"\n"^/cat/(.*)$","/c/$1","301","regex"\n"x","","410","plain"', hosts);
		expect(y.kind === "redirects" && y.rules.map((x) => `${x.source}>${x.destination}:${x.type}:${x.from}`)).toEqual(["/old-a>/new-a:301:yoast", "/cat/[...path]>/c/[...path]:301:yoast", "/x>:410:yoast"]);
		const c = recognise("redirects.csv", "/one,/two\n/three,https://acme.example/four,302", hosts);
		expect(c.kind === "redirects" && c.rules.map((x) => `${x.source}>${x.destination}:${x.type}`)).toEqual(["/one>/two:301", "/three>/four:302"]);
	});
	it("says what it cannot read instead of guessing", () => {
		expect(recognise("contact.nff", "{}", hosts)).toMatchObject({ kind: "unknown", reason: expect.stringMatching(/Ninja/) });
		expect(recognise("x.json", '{"hello":1}', hosts)).toMatchObject({ kind: "unknown" });
	});
});
