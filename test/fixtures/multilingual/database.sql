-- Synthetic dump for test/multilingual.test.ts: WPML settings (with a site key that must be dropped) and WPML's translations table. No real site data.
CREATE TABLE `wp_options` (
  `option_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `option_name` varchar(191) NOT NULL DEFAULT '',
  `option_value` longtext NOT NULL,
  `autoload` varchar(20) NOT NULL DEFAULT 'yes',
  PRIMARY KEY (`option_id`)
) ENGINE=InnoDB;
INSERT INTO `wp_options` VALUES (1,'blogname','Atelier','yes'),(2,'icl_sitepress_settings','a:4:{s:16:"default_language";s:2:"en";s:25:"language_negotiation_type";i:1;s:4:"urls";a:1:{s:30:"directory_for_default_language";i:0;}s:8:"site_key";s:12:"SECRET-12345";}','yes'),(3,'mailserver_pass','not-read','yes');
CREATE TABLE `wp_icl_translations` (
  `translation_id` bigint(20) NOT NULL AUTO_INCREMENT,
  `element_type` varchar(60) NOT NULL DEFAULT 'post_post',
  `element_id` bigint(20) DEFAULT NULL,
  `trid` bigint(20) NOT NULL,
  `language_code` varchar(7) NOT NULL,
  `source_language_code` varchar(7) DEFAULT NULL,
  PRIMARY KEY (`translation_id`)
) ENGINE=InnoDB;
INSERT INTO `wp_icl_translations` VALUES (1,'post_page',3,20,'en',NULL),(2,'post_page',13,20,'fr','en'),(3,'tax_nav_menu',2,900,'fr','en');
