#!/usr/bin/env bash
# Seeds the throwaway WordPress (runs inside the wpcli container: docker compose run --rm wpcli bash /seed/seed.sh).
# Reads /work/seed-plan.json, /work/images/*.png and /work/zips/*.zip (written by `tsx e2e/run.ts prepare`).
# Writes /work/app-password (a local application password for the kit), /work/exports/contact-form-7.xml,
# /work/elementor-options.json and /work/seed-summary.txt. Idempotent only on a fresh database (run.sh starts one).
set -euo pipefail

WP_URL="${E2E_WP_URL:-http://localhost:8080}"
WORK=/work
cd /var/www/html

step() { printf '\n[seed] %s\n' "$*"; }
wp() { command wp --path=/var/www/html "$@"; }

step "waiting for the database"
for i in $(seq 1 60); do
	if wp db check >/dev/null 2>&1; then break; fi
	if [ "$i" -eq 60 ]; then echo "[seed] database not reachable" >&2; exit 1; fi
	sleep 2
done

if wp core is-installed >/dev/null 2>&1; then
	echo "[seed] WordPress is already installed: the seed needs a fresh database (docker compose down -v)" >&2
	exit 1
fi

step "installing WordPress at ${WP_URL}"
ADMIN_PASS="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 24 || true)"
wp core install --url="${WP_URL}" --title="Harbor Lane Pottery" --admin_user=admin \
	--admin_password="${ADMIN_PASS}" --admin_email=admin@example.test --skip-email
unset ADMIN_PASS
wp option update blogdescription "Handmade stoneware by the water"
wp option update timezone_string "UTC"
wp option update permalink_structure "/%postname%/"
# What `wp rewrite flush --hard` writes under Apache (WP-CLI cannot detect mod_rewrite from the CLI container),
# including the Authorization header pass-through that application passwords need.
cat >/var/www/html/.htaccess <<'HTACCESS'
# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
HTACCESS

step "installing pinned themes and plugins"
while read -r kind file slug; do
	[ -n "${kind}" ] || continue
	if [ "${kind}" = "theme" ]; then
		wp theme install "${WORK}/zips/${file}" --activate
	else
		wp plugin install "${WORK}/zips/${file}" --activate
	fi
	echo "[seed] ${kind} ${slug} installed"
done <"${WORK}/zips/order.txt"
# Default plugins of the image are not part of the test site.
wp plugin delete akismet hello >/dev/null 2>&1 || true
wp plugin list --fields=name,status,version

step "languages (Polylang)"
wp eval-file /seed/seed-languages.php "${WORK}/seed-plan.json"

step "seeding content from the plan"
wp eval-file /seed/seed.php "${WORK}/seed-plan.json"

step "rewrite rules, caches"
wp rewrite flush
wp cache flush >/dev/null 2>&1 || true

step "application password for the kit (read-only use: extract)"
umask 077
wp user application-password create admin "wp2emdash-e2e" --porcelain >"${WORK}/app-password"
umask 022
chmod 644 "${WORK}/app-password"

step "plugin exports an owner would send"
mkdir -p "${WORK}/exports"
wp export --post_type=wpcf7_contact_form --dir="${WORK}/exports" --filename_format=contact-form-7.xml
# shellcheck disable=SC2016 # PHP, not shell
wp eval 'echo wp_json_encode(array_combine($k = ["elementor_active_kit", "elementor_cpt_support", "elementor_disable_color_schemes", "elementor_disable_typography_schemes"], array_map(fn($o) => get_option($o, null), $k)));' >"${WORK}/elementor-options.json"

step "summary"
{
	echo "# Seeded WordPress (${WP_URL})"
	wp core version --extra
	echo
	wp plugin list --fields=name,status,version --format=csv
	echo
	wp theme list --status=active --fields=name,version --format=csv
	echo
	wp post list --post_type=page,post,product,product_variation,wpcf7_contact_form --post_status=any --orderby=ID --order=ASC --fields=ID,post_type,post_name,post_status --format=csv
	echo
	# shellcheck disable=SC2016 # PHP, not shell
	wp eval 'if (function_exists("pll_languages_list")) { echo "Polylang languages: " . implode(", ", pll_languages_list()) . "\n"; foreach (get_posts(["post_type" => ["page", "post", "product"], "numberposts" => -1, "lang" => ""]) as $p) { echo "  " . $p->post_type . " " . $p->post_name . " lang=" . (pll_get_post_language($p->ID) ?: "-") . " url=" . get_permalink($p) . "\n"; } }'
	echo
	wp menu list --fields=term_id,name,locations --format=csv
} | tee "${WORK}/seed-summary.txt"

# Files written here belong to uid 33; let the host user read and remove them.
chmod -R a+rwX "${WORK}" 2>/dev/null || true
step "done"
