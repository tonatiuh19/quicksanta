-- Per-exchange pricing: Free (≤ free_max_participants) / Pro paid per exchange via Stripe / Enterprise (tenant plan).
ALTER TABLE `events` MODIFY COLUMN `status` ENUM('pending_payment','draft','open','drawn','completed','cancelled') NOT NULL DEFAULT 'open';
ALTER TABLE `events` ADD COLUMN `plan` ENUM('free','pro') NOT NULL DEFAULT 'free' AFTER `status`;
ALTER TABLE `events` ADD COLUMN `paid_at` DATETIME NULL AFTER `plan`;
ALTER TABLE `events` ADD COLUMN `invites_pending` TINYINT(1) NOT NULL DEFAULT 0 AFTER `paid_at`;

CREATE TABLE IF NOT EXISTS `payments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `event_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NULL,
  `provider` VARCHAR(20) NOT NULL DEFAULT 'stripe',
  `provider_payment_id` VARCHAR(120) NOT NULL,
  `amount_cents` INT UNSIGNED NOT NULL,
  `currency` CHAR(3) NOT NULL DEFAULT 'USD',
  `status` ENUM('pending','succeeded','failed','refunded') NOT NULL DEFAULT 'pending',
  `card_brand` VARCHAR(20) NULL,
  `card_last4` CHAR(4) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_payments_provider` (`provider_payment_id`),
  KEY `idx_payments_tenant` (`tenant_id`, `created_at`),
  KEY `idx_payments_event` (`event_id`),
  KEY `idx_payments_created` (`created_at`),
  CONSTRAINT `fk_payments_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_payments_event` FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_payments_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `system_settings` (`setting_key`, `setting_value`, `description`) VALUES
('free_max_participants', '20', 'Max people per exchange on the Free plan'),
('pro_max_participants', '100', 'Max people per exchange on Pro (paid per exchange)'),
('pro_price_cents', '890', 'Pro price per exchange in cents'),
('pro_currency', 'usd', 'Pro price currency (Stripe)')
ON DUPLICATE KEY UPDATE `description` = VALUES(`description`);
UPDATE `system_settings` SET `setting_value` = '20' WHERE `setting_key` = 'default_max_participants';
