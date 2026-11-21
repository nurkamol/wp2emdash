-- Synthetic dump for test/term-seo.test.ts: Yoast options (wpseo_titles, wpseo_taxonomy_meta) and Rank Math term meta. No real site data.
CREATE TABLE `wp_options` (
  `option_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `option_name` varchar(191) NOT NULL DEFAULT '',
  `option_value` longtext NOT NULL,
  `autoload` varchar(20) NOT NULL DEFAULT 'yes',
  PRIMARY KEY (`option_id`)
) ENGINE=InnoDB;
INSERT INTO `wp_options` VALUES (1,'blogname','Example Journal','yes'),(2,'wpseo_titles','a:2:{s:9:"separator";s:7:"sc-pipe";s:14:"title-category";s:53:"%%term_title%% Archives %%page%% %%sep%% %%sitename%%";}','yes'),(3,'wpseo_taxonomy_meta','a:2:{s:8:"category";a:3:{i:7;a:5:{s:11:"wpseo_title";s:60:"%%term_title%% from the studio %%page%% %%sep%% %%sitename%%";s:10:"wpseo_desc";s:45:"Schedule changes, new classes and studio news";s:21:"wpseo_opengraph-title";s:11:"Studio news";s:19:"wpseo_twitter-image";s:62:"https://blog.example.test/wp-content/uploads/2024/05/photo.jpg";s:13:"wpseo_focuskw";s:11:"studio news";}i:8;a:1:{s:13:"wpseo_noindex";s:7:"noindex";}i:1;a:1:{s:13:"wpseo_focuskw";s:14:"only a keyword";}}s:11:"post_format";a:1:{i:40;a:1:{s:11:"wpseo_title";s:30:"Galleries %%sep%% %%sitename%%";}}}','yes'),(4,'mailserver_pass','not-read','yes');
CREATE TABLE `wp_termmeta` (
  `meta_id` bigint(20) unsigned NOT NULL AUTO_INCREMENT,
  `term_id` bigint(20) unsigned NOT NULL DEFAULT 0,
  `meta_key` varchar(255) DEFAULT NULL,
  `meta_value` longtext,
  PRIMARY KEY (`meta_id`)
) ENGINE=InnoDB;
INSERT INTO `wp_termmeta` VALUES (1,20,'rank_math_title','%term% tips %sep% %sitename%'),(2,20,'rank_math_description','Short practical tips for your practice'),(3,20,'rank_math_robots','a:1:{i:0;s:7:"noindex";}'),(4,20,'rank_math_facebook_title','Tips worth sharing'),(5,20,'rank_math_twitter_use_facebook','off'),(6,20,'rank_math_twitter_title','Tips on X'),(7,20,'_private_term_note','never read'),(8,99,'rank_math_title','A term nobody migrates'),(9,21,'rank_math_focus_keyword','breathing');
