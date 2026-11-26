-- Wizard drafts: one active draft per signed-in user (signed-out drafts live in the browser).
-- Not an exchange: never counted toward plan limits; purged 30 days after the last edit (cron).
CREATE TABLE IF NOT EXISTS `wizard_drafts` (
  `user_id` BIGINT UNSIGNED NOT NULL,
  `step` VARCHAR(16) NOT NULL DEFAULT 'service',
  `data` JSON NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`user_id`),
  KEY `idx_wizard_drafts_updated` (`updated_at`),
  CONSTRAINT `fk_wizard_drafts_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
