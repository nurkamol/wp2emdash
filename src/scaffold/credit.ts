/**
 * Footer credit (kit.config `credit`, default "Website by PixelKraft" → pixelkraft.net): written into site.config.json
 * only when the migrated footer carries no credit of its own, so a site never shows two.
 */
export interface Credit {
	text: string;
	name: string;
	url: string;
}

const HAS_CREDIT = /\b(website|site|designed|developed|built|made|powered|crafted|created)\s+(by|with)\b/i;

export function footerCredit(credit: Credit | false | undefined, footerText: string): Credit | undefined {
	if (!credit) return undefined;
	if (HAS_CREDIT.test(footerText) || footerText.toLowerCase().includes(credit.name.toLowerCase())) return undefined;
	return credit;
}
