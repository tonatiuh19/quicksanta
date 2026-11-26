-- Pro-only services + "Create your own" exchanges + reusable workspace templates.
ALTER TABLE `event_types` ADD COLUMN `requires_pro` TINYINT(1) NOT NULL DEFAULT 0 AFTER `uses_draw`;
UPDATE `event_types` SET `requires_pro` = 1 WHERE `slug` NOT IN ('secret_santa', 'white_elephant');
INSERT IGNORE INTO `event_types` (`slug`, `name_en`, `name_es`, `description_en`, `description_es`, `icon`, `uses_draw`, `requires_pro`, `sort_order`) VALUES
('custom', 'Create your own', 'Crea el tuyo', 'Design a unique exchange: name, theme, rules, draw or no draw, reveal style.', 'Diseña un intercambio único: nombre, tema, reglas, con o sin sorteo y estilo de revelación.', 'sparkles', 1, 1, 999);
UPDATE `event_types` SET `requires_pro` = 1 WHERE `slug` = 'custom';

ALTER TABLE `events` ADD COLUMN `custom_name` VARCHAR(80) NULL AFTER `name`;
ALTER TABLE `events` ADD COLUMN `custom_icon` VARCHAR(20) NULL AFTER `custom_name`;
ALTER TABLE `events` ADD COLUMN `custom_color` VARCHAR(16) NULL AFTER `custom_icon`;
ALTER TABLE `events` ADD COLUMN `match_mode` ENUM('draw','none') NULL AFTER `custom_color`;
ALTER TABLE `events` ADD COLUMN `theme_rules` VARCHAR(500) NULL AFTER `match_mode`;
ALTER TABLE `events` ADD COLUMN `reveal_mode` ENUM('private','together') NOT NULL DEFAULT 'private' AFTER `theme_rules`;

CREATE TABLE IF NOT EXISTS `event_templates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `name` VARCHAR(80) NOT NULL,
  `icon` VARCHAR(20) NOT NULL DEFAULT 'sparkles',
  `color` VARCHAR(16) NOT NULL DEFAULT 'red',
  `match_mode` ENUM('draw','none') NOT NULL DEFAULT 'draw',
  `allow_wishlists` TINYINT(1) NOT NULL DEFAULT 1,
  `budget_min` DECIMAL(10,2) NULL,
  `budget_max` DECIMAL(10,2) NULL,
  `currency` CHAR(3) NOT NULL DEFAULT 'USD',
  `theme_rules` VARCHAR(500) NULL,
  `reveal_mode` ENUM('private','together') NOT NULL DEFAULT 'private',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_template_name` (`tenant_id`, `name`),
  CONSTRAINT `fk_templates_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_templates_user` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
