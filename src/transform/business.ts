/**
 * The business behind the site, from the structured data the live home page publishes (Rank Math, Yoast, theme):
 * the LocalBusiness/Organization node, its Place (geo, map) merged in. Only schema.org business fields are kept;
 * images are not (the migrated brand logo is used), and nothing is invented when the source has no such node.
 */
import type { IrSite } from "../ir/schema.js";

type Node = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
const types = (n: Node) => ([] as unknown[]).concat(n["@type"] ?? []).map(String);
/** Organization and its LocalBusiness subtypes (HealthClub, MedicalBusiness, Dentist…): anything but the page/site/media/person nodes. */
const NOT_BUSINESS = /^(WebSite|WebPage|AboutPage|ContactPage|FAQPage|CollectionPage|ItemPage|SearchResultsPage|Article|BlogPosting|NewsArticle|Person|ImageObject|VideoObject|BreadcrumbList|ListItem|Place|PostalAddress|GeoCoordinates|SearchAction|ReadAction|Offer|AggregateRating|Review|Product|Event|HowTo|Recipe|Question|Answer)$/;

export function businessFromJsonLd(blocks: unknown[]): IrSite["business"] {
	const nodes = blocks.flatMap((b) => (b && typeof b === "object" ? (((b as Node)["@graph"] as Node[] | undefined) ?? [b as Node]) : []));
	const byId = new Map(nodes.filter((n) => str(n["@id"])).map((n) => [str(n["@id"]) as string, n]));
	const biz = nodes.find((n) => types(n).some((t) => t === "Organization" || t === "LocalBusiness" || (!NOT_BUSINESS.test(t) && types(n).includes("Organization")))) ?? nodes.find((n) => types(n).length > 0 && types(n).every((t) => !NOT_BUSINESS.test(t)) && str(n.name) && (n.address || n.telephone));
	if (!biz || !str(biz.name)) return undefined;
	const type = types(biz).find((t) => t !== "Organization") ?? "Organization";
	const placeRef = biz.location && typeof biz.location === "object" ? str((biz.location as Node)["@id"]) : undefined;
	const place = (placeRef ? byId.get(placeRef) : undefined) ?? nodes.find((n) => types(n).includes("Place"));
	const addrNode = (biz.address ?? place?.address) as Node | undefined;
	const address = addrNode && typeof addrNode === "object" ? Object.fromEntries((["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"] as const).flatMap((k) => (str(addrNode[k]) ? [[k, str(addrNode[k])]] : []))) : undefined;
	const geoNode = (biz.geo ?? place?.geo) as Node | undefined;
	const geo = geoNode && str(geoNode.latitude) && str(geoNode.longitude) ? { latitude: str(geoNode.latitude) as string, longitude: str(geoNode.longitude) as string } : undefined;
	const list = (v: unknown) => ([] as unknown[]).concat(v ?? []).map(str).filter((x): x is string => !!x);
	const hours = list(biz.openingHours);
	const sameAs = list(biz.sameAs);
	return {
		type,
		name: str(biz.name) as string,
		...(str(biz.description) ? { description: str(biz.description) } : {}),
		...(str(biz.url) ? { url: str(biz.url) } : {}),
		...(str(biz.email) ? { email: str(biz.email) } : {}),
		...(str(biz.telephone) ? { telephone: str(biz.telephone) } : {}),
		...(str(biz.priceRange) ? { priceRange: str(biz.priceRange) } : {}),
		...(address && Object.keys(address).length ? { address } : {}),
		...(geo ? { geo } : {}),
		...(str(biz.hasMap ?? place?.hasMap) ? { hasMap: str(biz.hasMap ?? place?.hasMap) } : {}),
		...(hours.length ? { openingHours: hours } : {}),
		...(sameAs.length ? { sameAs } : {}),
	};
}
