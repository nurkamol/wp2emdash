/** KML for /locations.kml (Rank Math Local SEO file), from the carried LocalBusiness data. */
export interface Business {
	name?: string;
	telephone?: string;
	address?: { streetAddress?: string; addressLocality?: string; addressRegion?: string; postalCode?: string; addressCountry?: string };
	geo?: { latitude?: string | number; longitude?: string | number };
}

const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
const num = (v: unknown) => (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v)) ? String(v) : undefined);

export function locationsKml(b: Business, origin: string, siteName: string): string | undefined {
	const lat = num(b.geo?.latitude);
	const lng = num(b.geo?.longitude);
	if (!lat || !lng) return undefined;
	const a = b.address ?? {};
	const address = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry].filter(Boolean).join(", ");
	const name = b.name || siteName;
	return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:atom="http://www.w3.org/2005/Atom">
	<Document>
		<name>${cdata(`Locations for ${name}`)}</name>
		<open>1</open>
		<Folder>
			<atom:link href="${origin}" />
			<Placemark>
				<name>${cdata(name)}</name>
				${address ? `<address>${cdata(address)}</address>` : ""}
				${b.telephone ? `<phoneNumber>${cdata(b.telephone)}</phoneNumber>` : ""}
				<atom:link href="${origin}"/>
				<LookAt>
					<latitude>${lat}</latitude>
					<longitude>${lng}</longitude>
					<altitude>0</altitude>
					<tilt>0</tilt>
				</LookAt>
				<Point>
					<coordinates>${lng},${lat}</coordinates>
				</Point>
			</Placemark>
		</Folder>
	</Document>
</kml>
`;
}

