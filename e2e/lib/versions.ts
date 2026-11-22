/**
 * Everything the WordPress end-to-end test installs, pinned. Bump deliberately: change the version, the URL and the
 * sha256 together (download the zip and run `shasum -a 256` on it), then run the workflow by hand
 * (Actions → E2E WordPress → Run workflow) before relying on the nightly run.
 *
 * Docker images are pinned in e2e/wordpress/docker-compose.yml; test/e2e-wordpress.test.ts checks that they match
 * IMAGES here, so the two cannot drift apart.
 */

export interface PinnedZip {
	/** WordPress slug (folder name inside the zip). */
	slug: string;
	kind: "plugin" | "theme";
	version: string;
	url: string;
	sha256: string;
	/** Why the kit needs it in the test site. */
	why: string;
}

export const IMAGES = {
	wordpress: "wordpress:7.1.5-php8.3-apache",
	cli: "wordpress:cli-2.12.0-php8.3",
	db: "mariadb:11.8.9",
} as const;

/** Install order matters: WooCommerce before Polylang (product post types exist when languages are configured). */
export const ZIPS: PinnedZip[] = [
	{
		slug: "twentytwentyone",
		kind: "theme",
		version: "2.9",
		url: "https://downloads.wordpress.org/theme/twentytwentyone.2.9.zip",
		sha256: "51d4ac1dcaef18b0e35a1a313bce8115d3aa4ff315bb1143f95c223c38817d8b",
		why: "classic theme with menu locations (primary, footer), custom logo and site icon",
	},
	{
		slug: "woocommerce",
		kind: "plugin",
		version: "11.3.1",
		url: "https://downloads.wordpress.org/plugin/woocommerce.11.3.1.zip",
		sha256: "1502600c738840f7f9ebfa2f11e1aaff087221a5fc5a2006c51be2d874ae2a09",
		why: "catalogue mode (kit.config shop): products collection, shop + category listings, Store API facts",
	},
	{
		slug: "elementor",
		kind: "plugin",
		version: "4.4.1",
		url: "https://downloads.wordpress.org/plugin/elementor.4.4.1.zip",
		sha256: "dbc14b8d91b8ab5636d35421034e5a78698849c05b0489731611bd0033f13e5b",
		why: "Elementor adapter (src/adapters/elementor) on real _elementor_data",
	},
	{
		slug: "polylang",
		kind: "plugin",
		version: "3.9.2",
		url: "https://downloads.wordpress.org/plugin/polylang.3.9.2.zip",
		sha256: "90d695711f642efd942d9b7ce25698827b7332a7b26222dfd21719c300e5f9cb",
		why: "multilingual (src/transform/multilingual.ts): en default unprefixed + /fr/ directory, translated pairs",
	},
	{
		slug: "contact-form-7",
		kind: "plugin",
		version: "6.2.5",
		url: "https://downloads.wordpress.org/plugin/contact-form-7.6.2.5.zip",
		sha256: "0573098bdfed5bdfbd9f2d04185e4c52bf8dd27776e145699ab8f63cbb62927f",
		why: "CF7 form read from a WordPress Tools → Export file (src/extract/plugin-exports.ts parseContactForm7)",
	},
	{
		slug: "fluentform",
		kind: "plugin",
		version: "6.2.17",
		url: "https://downloads.wordpress.org/plugin/fluentform.6.2.17.zip",
		sha256: "e5dda0290afa0232758017ce63c63c76a57c6f000a0861eb43772a88a39909bc",
		why: "Fluent Forms read over its REST API by extract (fluentform/v1/forms)",
	},
	{
		slug: "emdash-exporter",
		kind: "plugin",
		version: "1.2.0",
		url: "https://github.com/emdash-cms/wp-emdash/releases/download/v1.2.0/emdash-exporter.zip",
		sha256: "57fa5d5d249da8abf151f4d050c375c26498430ed4c9a6d65a39ea2d7e2585fc",
		why: "the extract phase's primary source (emdash/v1/probe|analyze|content|media|menus|options); not on wordpress.org",
	},
];

export const zipFileName = (z: PinnedZip) => `${z.slug}-${z.version}.zip`;
