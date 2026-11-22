-- Synthetic dump for test/acf.test.ts: ACF options page values (options_*), a credential-like option that must be left out. No real site data.
CREATE TABLE `wp_options` (
  `option_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `option_name` varchar(191) NOT NULL DEFAULT '',
  `option_value` longtext NOT NULL,
  `autoload` varchar(20) NOT NULL DEFAULT 'yes',
  PRIMARY KEY (`option_id`)
) ENGINE=InnoDB;
INSERT INTO `wp_options` VALUES (1,'blogname','Example Agency','yes'),(2,'options_phone','+1 555 0100','yes'),(3,'_options_phone','field_o_phone','yes'),(4,'options_footer_text','Made in Example City','yes'),(5,'options_social_links','1','yes'),(6,'options_social_links_0_network','instagram','yes'),(7,'options_social_links_0_url','https://instagram.com/example','yes'),(8,'options_maps_api_key','not-read','yes'),(9,'options_smtp_password','not-read','yes'),(10,'mailserver_pass','not-read','yes');
