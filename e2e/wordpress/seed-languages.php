<?php
/**
 * Polylang languages and URL settings, in a process of their own (seed.sh runs this before seed.php) so that
 * seed.php boots with the languages and translated post types already in place.
 * Run: wp eval-file /seed/seed-languages.php /work/seed-plan.json
 *
 * URL mode: directory, default language unprefixed (/about/, /fr/a-propos/) — the mode the kit migrates as is
 * (docs/spikes/multilingual-findings.md). Products and product categories are translatable so they get a language.
 */

if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) {
	exit( 1 );
}
$plan_file = isset( $args[0] ) ? $args[0] : '/work/seed-plan.json';
$plan      = json_decode( (string) file_get_contents( $plan_file ), true );
if ( ! is_array( $plan ) ) {
	WP_CLI::error( "cannot read seed plan {$plan_file}" );
}
if ( ! function_exists( 'PLL' ) ) {
	WP_CLI::error( 'Polylang is not active' );
}
wp_set_current_user( 1 );

$model = PLL()->model;
$default_lang = 'en';
foreach ( $plan['languages'] as $i => $l ) {
	if ( $l['default'] ) {
		$default_lang = $l['slug'];
	}
	if ( $model->get_language( $l['slug'] ) ) {
		continue;
	}
	$lang_args = array( 'name' => $l['name'], 'slug' => $l['slug'], 'locale' => $l['locale'], 'rtl' => false, 'term_group' => $i, 'no_default_cat' => ! $l['default'] );
	$added     = ( isset( $model->languages ) && is_object( $model->languages ) && method_exists( $model->languages, 'add' ) ) ? $model->languages->add( $lang_args ) : $model->add_language( $lang_args );
	if ( is_wp_error( $added ) ) {
		WP_CLI::error( "language {$l['slug']}: " . $added->get_error_message() );
	}
	WP_CLI::log( "  language {$l['slug']} ({$l['locale']})" );
}
if ( method_exists( $model, 'clean_languages_cache' ) ) {
	$model->clean_languages_cache();
}

$options = $model->options;
$settings = array(
	'default_lang'  => $default_lang,
	'force_lang'    => 1,        // Language from the directory name in pretty permalinks.
	'hide_default'  => true,     // Default language without a prefix.
	'rewrite'       => true,     // /fr/ rather than /language/fr/.
	'redirect_lang' => false,
	'browser'       => false,    // No redirect by Accept-Language: crawls must see what they ask for.
	'post_types'    => array( 'product' ),
	'taxonomies'    => array( 'product_cat', 'product_tag' ),
);
foreach ( $settings as $key => $value ) {
	if ( is_object( $options ) && method_exists( $options, 'set' ) ) {
		$errors = $options->set( $key, $value );
		if ( is_wp_error( $errors ) && $errors->has_errors() ) {
			WP_CLI::warning( "Polylang option {$key}: " . $errors->get_error_message() );
		}
	} else {
		$o         = (array) get_option( 'polylang', array() );
		$o[ $key ] = $value;
		update_option( 'polylang', $o );
	}
}
if ( is_object( $options ) && method_exists( $options, 'save' ) ) {
	$options->save();
}
$saved = (array) get_option( 'polylang', array() );
WP_CLI::success( sprintf( 'Polylang: %s; default %s, force_lang %s, hide_default %s, post types %s', implode( ', ', wp_list_pluck( get_terms( array( 'taxonomy' => 'language', 'hide_empty' => false ) ), 'slug' ) ), $saved['default_lang'] ?? '?', wp_json_encode( $saved['force_lang'] ?? null ), wp_json_encode( $saved['hide_default'] ?? null ), wp_json_encode( $saved['post_types'] ?? null ) ) );
