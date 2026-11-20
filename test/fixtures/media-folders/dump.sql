-- Synthetic dump: FileBird and Real Media Library tables (plus an options row that must be ignored).
CREATE TABLE `wp_fbv` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(250) NOT NULL,
  `parent` int(11) NOT NULL DEFAULT 0,
  `type` int(2) NOT NULL DEFAULT 0,
  `ord` int(11) DEFAULT 0,
  `created_by` int(11) DEFAULT 0,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;
INSERT INTO `wp_fbv` VALUES (1,'Photos',0,0,0,1),(2,'Classes',1,0,1,1),(3,'Downloads',0,0,2,1),(4,'It\'s new',2,0,0,1);
CREATE TABLE `wp_fbv_attachment_folder` (
  `folder_id` int(11) NOT NULL,
  `attachment_id` bigint(20) NOT NULL
) ENGINE=InnoDB;
INSERT INTO `wp_fbv_attachment_folder` VALUES (2,201),(3,202),(4,203),(1,204);
CREATE TABLE `wp_realmedialibrary` (
  `id` mediumint(9) NOT NULL AUTO_INCREMENT,
  `parent` mediumint(9) NOT NULL DEFAULT -1,
  `name` tinytext NOT NULL,
  `slug` text NOT NULL,
  `absolute` text NOT NULL,
  `owner` bigint(20) NOT NULL,
  `ord` mediumint(10) NOT NULL DEFAULT 0,
  `type` varchar(10) NOT NULL DEFAULT '0',
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;
INSERT INTO `wp_realmedialibrary` (`id`,`parent`,`name`,`slug`,`absolute`,`owner`,`ord`,`type`) VALUES (5,-1,'photos','photos','photos',1,0,'0'),(6,5,'Archive','archive','photos/archive',1,0,'0');
CREATE TABLE `wp_realmedialibrary_posts` (
  `attachment` bigint(20) NOT NULL,
  `fid` mediumint(9) NOT NULL DEFAULT -1,
  `isShortcut` bigint(20) NOT NULL DEFAULT 0,
  `nr` bigint(20) DEFAULT NULL
) ENGINE=InnoDB;
INSERT INTO `wp_realmedialibrary_posts` VALUES (205,6,0,NULL),(201,5,0,NULL),(206,6,99,NULL),(206,5,0,NULL);
INSERT INTO `wp_options` VALUES (1,'siteurl','https://example.test','yes');
