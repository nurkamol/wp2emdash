<?php
/**
 * Creates the synthetic site described by the seed plan (e2e/lib/plan.ts → /work/seed-plan.json).
 * Run by seed.sh: wp eval-file /seed/seed.php /work/seed-plan.json
 *
 * Every step stops the seed on failure (WP_CLI::error) so a broken plugin API shows up here, in the seed log, and not
 * later as a confusing gate failure. Placeholders are documented in e2e/lib/plan.ts.
 */

if ( ! defined( 'WP_CLI' ) || ! WP_CLI ) {
	exit( 1 );
}

$plan_file = isset( $args[0] ) ? $args[0] : '/work/seed-plan.json';
$plan      = json_decode( (string) file_get_contents( $plan_file ), true );
if ( ! is_array( $plan ) || 1 !== ( $plan['version'] ?? 0 ) ) {
	WP_CLI::error( "cannot read seed plan {$plan_file}" );
}

require_once ABSPATH . 'wp-admin/includes/image.php';
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/media.php';
require_once ABSPATH . 'wp-admin/includes/nav-menu.php';

// As the administrator, without kses (block comments and Elementor JSON must reach the database unchanged).
wp_set_current_user( 1 );
kses_remove_filters();

foreach ( array( 'PLL' => 'Polylang', 'WC' => 'WooCommerce', 'WPCF7_ContactForm' => 'Contact Form 7' ) as $symbol => $name ) {
	if ( ! function_exists( $symbol ) && ! class_exists( $symbol ) ) {
		WP_CLI::error( "{$name} is not active" );
	}
}
if ( ! defined( 'ELEMENTOR_VERSION' ) ) {
	WP_CLI::error( 'Elementor is not active' );
}
if ( ! defined( 'FLUENTFORM' ) && ! defined( 'FLUENTFORM_VERSION' ) ) {
	WP_CLI::error( 'Fluent Forms is not active' );
}

function e2e_ok( $result, $what ) {
	if ( is_wp_error( $result ) ) {
		WP_CLI::error( "{$what}: " . $result->get_error_message() );
	}
	if ( ! $result ) {
		WP_CLI::error( "{$what}: failed" );
	}
	return $result;
}

function e2e_log( $message ) {
	WP_CLI::log( '  ' . $message );
}

$ctx = array(
	'site'   => untrailingslashit( home_url() ),
	'image'  => array(),
	'url'    => array(),
	'fluent' => 0,
	'cf7'    => '',
);

/** Resolves {{…}} placeholders; a quoted "{{image:<key>:id}}" becomes a bare number (JSON ids). */
function e2e_resolve( $text, $ctx ) {
	$value = function ( $key ) use ( $ctx ) {
		if ( 'site' === $key ) {
			return $ctx['site'];
		}
		if ( 'form:fluent' === $key ) {
			return (string) $ctx['fluent'];
		}
		if ( 'form:cf7' === $key ) {
			return (string) $ctx['cf7'];
		}
		$parts = explode( ':', $key );
		if ( 3 === count( $parts ) && 'image' === $parts[0] ) {
			if ( ! isset( $ctx['image'][ $parts[1] ] ) ) {
				WP_CLI::error( "unknown image {$parts[1]}" );
			}
			return 'id' === $parts[2] ? (string) $ctx['image'][ $parts[1] ] : $ctx['url'][ $parts[1] ];
		}
		WP_CLI::error( "unknown placeholder {{{$key}}}" );
	};
	$text = preg_replace_callback( '/"\{\{(image:[a-z0-9-]+:id)\}\}"/', function ( $m ) use ( $value ) {
		return $value( $m[1] );
	}, $text );
	return preg_replace_callback( '/\{\{([a-z0-9:-]+)\}\}/', function ( $m ) use ( $value ) {
		return $value( $m[1] );
	}, $text );
}

// ── Defaults out ─────────────────────────────────────────────────────────────────────────────────────────────
WP_CLI::log( 'Removing the default post, page and comment' );
foreach ( get_posts( array( 'post_type' => array( 'post', 'page' ), 'post_status' => 'any', 'numberposts' => -1, 'name__in' => array( 'hello-world', 'sample-page', 'privacy-policy' ) ) ) as $p ) {
	wp_delete_post( $p->ID, true );
}
foreach ( get_comments( array( 'fields' => 'ids', 'status' => 'all' ) ) as $comment_id ) {
	wp_delete_comment( $comment_id, true );
}

// ── WooCommerce settings ─────────────────────────────────────────────────────────────────────────────────────
WP_CLI::log( 'WooCommerce: pages, currency, store visible (no "coming soon")' );
if ( class_exists( 'WC_Install' ) ) {
	WC_Install::create_pages();
}
update_option( 'woocommerce_currency', $plan['site']['currency'] );
update_option( 'woocommerce_coming_soon', 'no' );
update_option( 'woocommerce_store_pages_only', 'no' );
update_option( 'woocommerce_onboarding_profile', array( 'skipped' => true ) );
update_option( 'woocommerce_task_list_hidden', 'yes' );
update_option( 'woocommerce_show_marketplace_suggestions', 'no' );
update_option( 'woocommerce_allow_tracking', 'no' );

// ── Elementor settings ───────────────────────────────────────────────────────────────────────────────────────
WP_CLI::log( 'Elementor: containers on, default kit' );
update_option( 'elementor_experiment-container', 'active' );
update_option( 'elementor_cpt_support', array( 'page', 'post' ) );
update_option( 'elementor_onboarded', true );
if ( ! get_option( 'elementor_active_kit' ) && class_exists( '\Elementor\Core\Kits\Manager' ) ) {
	\Elementor\Core\Kits\Manager::create_default_kit();
}
e2e_log( 'active kit ' . get_option( 'elementor_active_kit' ) );

// ── Polylang (languages and URL settings were set by seed-languages.php, in its own process) ─────────────────
$pll_model   = PLL()->model;
$pll_options = $pll_model->options;
$pll_set     = function ( $key, $value ) use ( $pll_options ) {
	if ( is_object( $pll_options ) && method_exists( $pll_options, 'set' ) ) {
		$errors = $pll_options->set( $key, $value );
		if ( is_wp_error( $errors ) && $errors->has_errors() ) {
			WP_CLI::warning( "Polylang option {$key}: " . $errors->get_error_message() );
		}
		return;
	}
	$o         = (array) get_option( 'polylang', array() );
	$o[ $key ] = $value;
	update_option( 'polylang', $o );
};
$pll_save    = function () use ( $pll_options ) {
	if ( is_object( $pll_options ) && method_exists( $pll_options, 'save' ) ) {
		$pll_options->save();
	}
};
$default_lang = 'en';
foreach ( $plan['languages'] as $l ) {
	if ( $l['default'] ) {
		$default_lang = $l['slug'];
	}
	if ( ! $pll_model->get_language( $l['slug'] ) ) {
		WP_CLI::error( "Polylang language {$l['slug']} missing (seed-languages.php runs first)" );
	}
}
if ( ! $pll_model->is_translated_post_type( 'product' ) ) {
	WP_CLI::warning( 'Polylang does not translate products (post_types option): products will have no language' );
}

// ── Media ────────────────────────────────────────────────────────────────────────────────────────────────────
WP_CLI::log( 'Media library' );
foreach ( $plan['images'] as $img ) {
	$src = '/work/images/' . $img['file'];
	if ( ! file_exists( $src ) ) {
		WP_CLI::error( "missing image {$src} (run: tsx e2e/run.ts prepare)" );
	}
	$tmp = wp_tempnam( $img['file'] );
	copy( $src, $tmp );
	$id = e2e_ok( media_handle_sideload( array( 'name' => $img['file'], 'tmp_name' => $tmp ), 0, $img['title'] ), "image {$img['key']}" );
	update_post_meta( $id, '_wp_attachment_image_alt', $img['alt'] );
	$ctx['image'][ $img['key'] ] = (int) $id;
	$ctx['url'][ $img['key'] ]   = wp_get_attachment_url( $id );
}
e2e_log( count( $ctx['image'] ) . ' images' );
set_theme_mod( 'custom_logo', $ctx['image'][ $plan['site']['logo'] ] );
update_option( 'site_icon', $ctx['image'][ $plan['site']['icon'] ] );

// ── Forms ────────────────────────────────────────────────────────────────────────────────────────────────────
WP_CLI::log( 'Fluent Forms form' );
global $wpdb;
$ff_forms = $wpdb->prefix . 'fluentform_forms';
$ff_meta  = $wpdb->prefix . 'fluentform_form_meta';
if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $ff_forms ) ) !== $ff_forms ) {
	WP_CLI::error( 'Fluent Forms tables missing (activation did not run its migrations)' );
}
// The demo form Fluent Forms creates on activation is not part of the plan.
$wpdb->query( "DELETE FROM {$ff_meta}" );   // phpcs:ignore
$wpdb->query( "DELETE FROM {$ff_forms}" );  // phpcs:ignore
$ff     = $plan['forms']['fluent'];
$fields = array();
foreach ( $ff['fields'] as $i => $f ) {
	$required = ! empty( $f['required'] );
	$rules    = array( 'required' => array( 'value' => $required, 'message' => 'This field is required' ) );
	$settings = array( 'container_class' => '', 'label' => $f['label'], 'label_placement' => '', 'admin_field_label' => '', 'help_message' => '', 'validation_rules' => $rules, 'conditional_logics' => array() );
	$options  = array_map( function ( $o ) {
		return array( 'label' => $o, 'value' => $o, 'calc_value' => '' );
	}, isset( $f['options'] ) ? $f['options'] : array() );
	switch ( $f['element'] ) {
		case 'input_email':
			$settings['validation_rules']['email'] = array( 'value' => true, 'message' => 'This field must contain a valid email' );
			$field = array( 'element' => 'input_email', 'attributes' => array( 'type' => 'email', 'name' => $f['name'], 'value' => '', 'id' => '', 'class' => '', 'placeholder' => isset( $f['placeholder'] ) ? $f['placeholder'] : '' ), 'settings' => $settings, 'editor_options' => array( 'title' => 'Email Address', 'icon_class' => 'ff-edit-email', 'template' => 'inputText' ) );
			break;
		case 'textarea':
			$field = array( 'element' => 'textarea', 'attributes' => array( 'name' => $f['name'], 'value' => '', 'id' => '', 'class' => '', 'placeholder' => isset( $f['placeholder'] ) ? $f['placeholder'] : '', 'rows' => 4, 'cols' => 2 ), 'settings' => $settings, 'editor_options' => array( 'title' => 'Text Area', 'icon_class' => 'ff-edit-textarea', 'template' => 'inputTextarea' ) );
			break;
		case 'select':
			$settings += array( 'placeholder' => '- Select -', 'advanced_options' => $options, 'calc_value_status' => false, 'enable_image_input' => false, 'randomize_options' => 'no' );
			$field = array( 'element' => 'select', 'attributes' => array( 'name' => $f['name'], 'value' => '', 'id' => '', 'class' => '' ), 'settings' => $settings, 'editor_options' => array( 'title' => 'Dropdown', 'icon_class' => 'ff-edit-dropdown', 'element' => 'select', 'template' => 'select' ) );
			break;
		case 'input_checkbox':
			$settings += array( 'advanced_options' => $options, 'layout_class' => '', 'calc_value_status' => false, 'enable_image_input' => false, 'randomize_options' => 'no' );
			$field = array( 'element' => 'input_checkbox', 'attributes' => array( 'type' => 'checkbox', 'name' => $f['name'], 'value' => array() ), 'settings' => $settings, 'editor_options' => array( 'title' => 'Check Box', 'icon_class' => 'ff-edit-checkbox-1', 'template' => 'inputCheckable' ) );
			break;
		default:
			$field = array( 'element' => 'input_text', 'attributes' => array( 'type' => 'text', 'name' => $f['name'], 'value' => '', 'class' => '', 'placeholder' => isset( $f['placeholder'] ) ? $f['placeholder'] : '' ), 'settings' => $settings, 'editor_options' => array( 'title' => 'Simple Text', 'icon_class' => 'ff-edit-text', 'template' => 'inputText' ) );
	}
	$field['index']     = $i;
	$field['uniqElKey'] = 'el_' . ( 1767225600000 + $i );
	$fields[]           = $field;
}
$submit = array( 'uniqElKey' => 'el_1767225600999', 'element' => 'button', 'attributes' => array( 'type' => 'submit', 'class' => '' ), 'settings' => array( 'align' => 'left', 'button_style' => 'default', 'container_class' => '', 'help_message' => '', 'background_color' => '#1a7efb', 'button_size' => 'md', 'color' => '#ffffff', 'button_ui' => array( 'type' => 'default', 'text' => $ff['submit'], 'img_url' => '' ) ), 'editor_options' => array( 'title' => 'Submit Button' ) );
$now    = current_time( 'mysql' );
e2e_ok( $wpdb->insert( $ff_forms, array( 'title' => $ff['title'], 'status' => 'published', 'form_fields' => wp_json_encode( array( 'fields' => $fields, 'submitButton' => $submit ) ), 'has_payment' => 0, 'type' => 'form', 'created_by' => 1, 'created_at' => $now, 'updated_at' => $now ) ), 'Fluent Forms form' );
$ctx['fluent'] = (int) $wpdb->insert_id;
$ff_metas      = array(
	'formSettings'  => array(
		'confirmation' => array( 'redirectTo' => 'samePage', 'messageToShow' => $ff['confirmation'], 'customPage' => null, 'samePageFormBehavior' => 'hide_form', 'customUrl' => null ),
		'restrictions' => array(),
		'layout'       => array( 'labelPlacement' => 'top', 'helpMessagePlacement' => 'with_label', 'errorMessagePlacement' => 'inline', 'cssClassName' => '', 'asteriskPlacement' => 'asterisk-right' ),
		'delete_entry_on_submission' => 'no',
	),
	'notifications' => array( 'name' => 'Admin Notification Email', 'sendTo' => array( 'type' => 'email', 'email' => $ff['recipient'], 'field' => '', 'routing' => array() ), 'fromName' => '', 'fromEmail' => '', 'replyTo' => '{inputs.email}', 'bcc' => '', 'subject' => 'New message: {inputs.full_name}', 'message' => '<p>{all_data}</p>', 'conditionals' => array( 'status' => false, 'type' => 'all', 'conditions' => array() ), 'enabled' => true, 'email_template' => '' ),
);
foreach ( $ff_metas as $meta_key => $meta_value ) {
	e2e_ok( $wpdb->insert( $ff_meta, array( 'form_id' => $ctx['fluent'], 'meta_key' => $meta_key, 'value' => wp_json_encode( $meta_value ) ) ), "Fluent Forms meta {$meta_key}" ); // phpcs:ignore
}
e2e_log( "Fluent Forms form #{$ctx['fluent']}" );

WP_CLI::log( 'Contact Form 7 form' );
foreach ( get_posts( array( 'post_type' => 'wpcf7_contact_form', 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids' ) ) as $id ) {
	wp_delete_post( $id, true );   // The "Contact form 1" CF7 creates on activation.
}
$c7    = $plan['forms']['cf7'];
$cf    = WPCF7_ContactForm::get_template( array( 'title' => $c7['title'], 'locale' => 'en_US' ) );
$props = $cf->get_properties();
$props['form']                       = $c7['template'];
$props['mail']['recipient']          = $c7['recipient'];
$props['mail']['subject']            = $c7['subject'];
$props['mail']['body']               = "From: [your-name] <[your-email]>\nPhone: [your-phone]\nPiece: [piece]\n\n[your-message]";
$props['mail']['additional_headers'] = 'Reply-To: [your-email]';
$cf->set_properties( $props );
$cf7_id   = (int) e2e_ok( $cf->save(), 'Contact Form 7 form' );
$cf_saved = wpcf7_contact_form( $cf7_id );
$hash     = $cf_saved && method_exists( $cf_saved, 'hash' ) ? (string) $cf_saved->hash() : '';
$ctx['cf7'] = '' !== $hash ? $hash : (string) $cf7_id;
e2e_log( "Contact Form 7 form #{$cf7_id} (embedded as {$ctx['cf7']})" );

// ── Terms ────────────────────────────────────────────────────────────────────────────────────────────────────
WP_CLI::log( 'Categories, tags, product categories' );
$term_ids = array( 'category' => array(), 'post_tag' => array(), 'product_cat' => array() );
foreach ( array( 'category' => $plan['categories'], 'post_tag' => $plan['tags'] ) as $taxonomy => $terms ) {
	foreach ( $terms as $t ) {
		$r = e2e_ok( wp_insert_term( $t['name'], $taxonomy, array( 'slug' => $t['slug'] ) ), "{$taxonomy} {$t['slug']}" );
		pll_set_term_language( (int) $r['term_id'], $t['lang'] );
		$term_ids[ $taxonomy ][ $t['key'] ] = (int) $r['term_id'];
	}
	foreach ( $terms as $t ) {
		if ( ! empty( $t['translationOf'] ) ) {
			pll_save_term_translations( array( 'en' => $term_ids[ $taxonomy ][ $t['translationOf'] ], $t['lang'] => $term_ids[ $taxonomy ][ $t['key'] ] ) );
		}
	}
}
foreach ( $plan['productCategories'] as $t ) {
	$r = e2e_ok( wp_insert_term( $t['name'], 'product_cat', array( 'slug' => $t['slug'] ) ), "product_cat {$t['slug']}" );
	pll_set_term_language( (int) $r['term_id'], $default_lang );
	$term_ids['product_cat'][ $t['key'] ] = (int) $r['term_id'];
}

// ── Pages ────────────────────────────────────────────────────────────────────────────────────────────────────
WP_CLI::log( 'Pages' );
$page_ids = array();
foreach ( $plan['pages'] as $p ) {
	$id = e2e_ok( wp_insert_post( array( 'post_type' => 'page', 'post_status' => 'publish', 'post_title' => $p['title'], 'post_name' => $p['slug'], 'menu_order' => $p['menuOrder'], 'post_content' => '' ), true ), "page {$p['key']}" );
	pll_set_post_language( $id, $p['lang'] );
	$page_ids[ $p['key'] ] = (int) $id;
}
foreach ( $plan['pages'] as $p ) {
	if ( ! empty( $p['translationOf'] ) ) {
		pll_save_post_translations( array( 'en' => $page_ids[ $p['translationOf'] ], $p['lang'] => $page_ids[ $p['key'] ] ) );
	}
}
foreach ( $plan['pages'] as $p ) {
	$id = $page_ids[ $p['key'] ];
	if ( 'elementor' === $p['builder'] ) {
		$json = e2e_resolve( wp_json_encode( $p['elementor'], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES ), $ctx );
		if ( null === json_decode( $json, true ) ) {
			WP_CLI::error( "page {$p['key']}: Elementor data is not valid JSON after placeholders" );
		}
		update_post_meta( $id, '_elementor_data', wp_slash( $json ) );
		update_post_meta( $id, '_elementor_edit_mode', 'builder' );
		update_post_meta( $id, '_elementor_template_type', 'wp-page' );
		update_post_meta( $id, '_elementor_version', ELEMENTOR_VERSION );
		update_post_meta( $id, '_wp_page_template', 'elementor_header_footer' );
	} else {
		e2e_ok( wp_update_post( array( 'ID' => $id, 'post_content' => wp_slash( e2e_resolve( $p['content'], $ctx ) ) ), true ), "page {$p['key']} content" );
	}
	if ( ! empty( $p['front'] ) ) {
		update_option( 'show_on_front', 'page' );
		update_option( 'page_on_front', $id );
	}
	if ( ! empty( $p['postsPage'] ) ) {
		update_option( 'page_for_posts', $id );
	}
	e2e_log( "{$p['lang']} {$p['builder']} page {$p['slug']} #{$id}" );
}
// Polylang caches each language's front page in its language list (transient pll_languages_list), built when the
// languages were created — before page_on_front was set. Without a refresh it keeps no French front page and answers
// /fr/ with a 301 to /fr/accueil/ (first CI runs, 2026-11-22).
delete_transient( 'pll_languages_list' );
if ( function_exists( 'PLL' ) && isset( PLL()->model ) && method_exists( PLL()->model, 'clean_languages_cache' ) ) {
	PLL()->model->clean_languages_cache();
}

// ── Posts ────────────────────────────────────────────────────────────────────────────────────────────────────
WP_CLI::log( 'Posts' );
$post_ids = array();
foreach ( $plan['posts'] as $p ) {
	$id = e2e_ok( wp_insert_post( array( 'post_type' => 'post', 'post_status' => 'publish', 'post_title' => $p['title'], 'post_name' => $p['slug'], 'post_date' => $p['date'], 'post_content' => wp_slash( e2e_resolve( $p['content'], $ctx ) ), 'post_excerpt' => wp_slash( $p['excerpt'] ) ), true ), "post {$p['key']}" );
	// Language first: Polylang keeps a post's terms in the post's language.
	pll_set_post_language( $id, $p['lang'] );
	wp_set_post_categories( $id, array_map( function ( $k ) use ( $term_ids ) {
		return $term_ids['category'][ $k ];
	}, $p['categories'] ) );
	wp_set_object_terms( $id, array_map( function ( $k ) use ( $term_ids ) {
		return $term_ids['post_tag'][ $k ];
	}, $p['tags'] ), 'post_tag' );
	set_post_thumbnail( $id, $ctx['image'][ $p['featuredImage'] ] );
	$post_ids[ $p['key'] ] = (int) $id;
}
foreach ( $plan['posts'] as $p ) {
	if ( ! empty( $p['translationOf'] ) ) {
		pll_save_post_translations( array( 'en' => $post_ids[ $p['translationOf'] ], $p['lang'] => $post_ids[ $p['key'] ] ) );
	}
}
e2e_log( count( $post_ids ) . ' posts' );

// ── Products ─────────────────────────────────────────────────────────────────────────────────────────────────
WP_CLI::log( 'Products' );
foreach ( $plan['products'] as $p ) {
	$product = 'variable' === $p['type'] ? new WC_Product_Variable() : new WC_Product_Simple();
	$product->set_name( $p['name'] );
	$product->set_slug( $p['slug'] );
	$product->set_status( 'publish' );
	$product->set_sku( $p['sku'] );
	$product->set_short_description( $p['short'] );
	$product->set_description( $p['description'] );
	$product->set_image_id( $ctx['image'][ $p['image'] ] );
	if ( 'simple' === $p['type'] ) {
		$product->set_regular_price( $p['regularPrice'] );
		if ( ! empty( $p['salePrice'] ) ) {
			$product->set_sale_price( $p['salePrice'] );
		}
	} else {
		$attribute = new WC_Product_Attribute();
		$attribute->set_id( 0 );
		$attribute->set_name( $p['attribute']['name'] );
		$attribute->set_options( $p['attribute']['options'] );
		$attribute->set_position( 0 );
		$attribute->set_visible( true );
		$attribute->set_variation( true );
		$product->set_attributes( array( $attribute ) );
	}
	$product_id = (int) e2e_ok( $product->save(), "product {$p['key']}" );
	pll_set_post_language( $product_id, $default_lang );
	$product = wc_get_product( $product_id );
	$product->set_category_ids( array_map( function ( $k ) use ( $term_ids ) {
		return $term_ids['product_cat'][ $k ];
	}, $p['categories'] ) );
	$product->save();
	if ( 'variable' === $p['type'] ) {
		$attr_key = sanitize_title( $p['attribute']['name'] );
		foreach ( $p['variations'] as $v ) {
			$variation = new WC_Product_Variation();
			$variation->set_parent_id( $product_id );
			$variation->set_attributes( array( $attr_key => $v['option'] ) );
			$variation->set_sku( $v['sku'] );
			$variation->set_regular_price( $v['regularPrice'] );
			if ( ! empty( $v['salePrice'] ) ) {
				$variation->set_sale_price( $v['salePrice'] );
			}
			$variation->set_status( 'publish' );
			e2e_ok( $variation->save(), "variation {$v['sku']}" );
		}
		WC_Product_Variable::sync( $product_id );
	}
	e2e_log( "{$p['type']} product {$p['slug']} #{$product_id}" );
}

// ── Anything WooCommerce or WordPress created without a language gets the default one ───────────────────────
foreach ( get_posts( array( 'post_type' => array( 'page', 'post', 'product' ), 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids', 'lang' => '' ) ) as $id ) {
	if ( ! pll_get_post_language( $id ) ) {
		pll_set_post_language( $id, $default_lang );
		e2e_log( 'language ' . $default_lang . ' given to ' . get_post_type( $id ) . ' ' . get_post_field( 'post_name', $id ) );
	}
}
foreach ( array( 'category', 'post_tag', 'product_cat', 'product_tag' ) as $taxonomy ) {
	foreach ( get_terms( array( 'taxonomy' => $taxonomy, 'hide_empty' => false, 'fields' => 'ids', 'lang' => '' ) ) as $term_id ) {
		if ( ! pll_get_term_language( $term_id ) ) {
			pll_set_term_language( $term_id, $default_lang );
		}
	}
}

// ── Menus ────────────────────────────────────────────────────────────────────────────────────────────────────
WP_CLI::log( 'Menus' );
$locations = array();
$pll_menus = array();
foreach ( $plan['menus'] as $m ) {
	$menu_id = (int) e2e_ok( wp_create_nav_menu( $m['name'] ), "menu {$m['key']}" );
	foreach ( $m['items'] as $pos => $item ) {
		if ( ! empty( $item['page'] ) ) {
			$object_id = 'woo:shop' === $item['page'] ? wc_get_page_id( 'shop' ) : $page_ids[ $item['page'] ];
			$data      = array( 'menu-item-title' => $item['label'], 'menu-item-object' => 'page', 'menu-item-object-id' => $object_id, 'menu-item-type' => 'post_type', 'menu-item-status' => 'publish', 'menu-item-position' => $pos + 1 );
		} else {
			$data = array( 'menu-item-title' => $item['label'], 'menu-item-url' => e2e_resolve( $item['url'], $ctx ), 'menu-item-type' => 'custom', 'menu-item-status' => 'publish', 'menu-item-position' => $pos + 1 );
		}
		e2e_ok( wp_update_nav_menu_item( $menu_id, 0, $data ), "menu {$m['key']} item {$item['label']}" );
	}
	if ( $m['lang'] === $default_lang ) {
		$locations[ $m['location'] ] = $menu_id;
	}
	$pll_menus[ $m['location'] ][ $m['lang'] ] = $menu_id;
	e2e_log( "menu {$m['name']} ({$m['lang']}, {$m['location']}) #{$menu_id}" );
}
set_theme_mod( 'nav_menu_locations', $locations );
$pll_set( 'nav_menus', array( get_stylesheet() => $pll_menus ) );
$pll_save();

// ── Checks ───────────────────────────────────────────────────────────────────────────────────────────────────
WP_CLI::log( 'Checks' );
$home_translations = pll_get_post_translations( $page_ids['home'] );
if ( empty( $home_translations['fr'] ) ) {
	WP_CLI::error( 'Polylang: the home page has no French translation' );
}
if ( 'no' !== get_option( 'woocommerce_coming_soon' ) ) {
	WP_CLI::error( 'WooCommerce is still in "coming soon" mode' );
}
$products = wc_get_products( array( 'status' => 'publish', 'limit' => -1, 'return' => 'ids' ) );
if ( count( $products ) !== count( $plan['products'] ) ) {
	WP_CLI::error( 'expected ' . count( $plan['products'] ) . ' products, found ' . count( $products ) );
}
WP_CLI::success( sprintf( 'seeded %d pages, %d posts, %d products, %d images, Fluent form #%d, CF7 form #%d', count( $page_ids ), count( $post_ids ), count( $products ), count( $ctx['image'] ), $ctx['fluent'], $cf7_id ) );
