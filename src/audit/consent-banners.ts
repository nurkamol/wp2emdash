/**
 * Cookie and consent banners that sit over a page: hidden before menu captures and screenshots on both the old site
 * and the migrated one, so comparisons see the page, not the banner. The kit's own banner (starter
 * public/scripts/site-consent.js renders `div.consent.consent--bar|card`) and common WordPress cookie plugins.
 */
export const CONSENT_BANNERS = ["div.consent[class*=\"consent--\"]", "#consent-panel", "#cookie-law-info-bar", ".cky-consent-container", "#cmplz-cookiebanner-container", ".cmplz-cookiebanner", "#cookie-notice", "#moove_gdpr_cookie_info_bar", "#CybotCookiebotDialog", "#onetrust-banner-sdk", ".iubenda-cs-container", "#BorlabsCookieBox"].join(", ");

