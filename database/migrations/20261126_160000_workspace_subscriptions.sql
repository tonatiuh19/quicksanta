-- Pro = Stripe subscription per workspace ($8.90/month, STRIPE_PLATFORM_PRICE_ID).
ALTER TABLE `tenants` ADD COLUMN `stripe_customer_id` VARCHAR(64) NULL AFTER `locale`;
ALTER TABLE `tenants` ADD COLUMN `stripe_subscription_id` VARCHAR(64) NULL AFTER `stripe_customer_id`;
ALTER TABLE `tenants` ADD COLUMN `subscription_status` ENUM('none','incomplete','incomplete_expired','trialing','active','past_due','canceled','unpaid','paused') NOT NULL DEFAULT 'none' AFTER `stripe_subscription_id`;
ALTER TABLE `tenants` ADD COLUMN `current_period_end` DATETIME NULL AFTER `subscription_status`;
ALTER TABLE `tenants` ADD COLUMN `cancel_at_period_end` TINYINT(1) NOT NULL DEFAULT 0 AFTER `current_period_end`;
ALTER TABLE `tenants` ADD COLUMN `cancel_reason` VARCHAR(40) NULL AFTER `cancel_at_period_end`;
ALTER TABLE `tenants` ADD COLUMN `cancel_feedback` VARCHAR(1000) NULL AFTER `cancel_reason`;
ALTER TABLE `tenants` ADD COLUMN `save_offer_used_at` DATETIME NULL AFTER `cancel_feedback`;
ALTER TABLE `tenants` ADD COLUMN `card_brand` VARCHAR(20) NULL AFTER `save_offer_used_at`;
ALTER TABLE `tenants` ADD COLUMN `card_last4` CHAR(4) NULL AFTER `card_brand`;
ALTER TABLE `tenants` ADD COLUMN `card_exp` VARCHAR(7) NULL AFTER `card_last4`;
CREATE UNIQUE INDEX `uq_tenants_stripe_customer` ON `tenants` (`stripe_customer_id`);
CREATE INDEX `idx_tenants_subscription` ON `tenants` (`subscription_status`);

-- Payments now also hold subscription invoices (no single exchange).
ALTER TABLE `payments` MODIFY COLUMN `event_id` BIGINT UNSIGNED NULL;
ALTER TABLE `payments` ADD COLUMN `kind` ENUM('one_time','invoice') NOT NULL DEFAULT 'one_time' AFTER `provider`;
ALTER TABLE `payments` ADD COLUMN `hosted_invoice_url` VARCHAR(500) NULL AFTER `card_last4`;

INSERT INTO `system_settings` (`setting_key`, `setting_value`, `description`) VALUES
('subscription_grace_days', '3', 'Days Pro stays on after a failed renewal (past_due)'),
('save_offer_percent', '50', 'Retention offer: % off the next invoice when someone starts cancelling')
ON DUPLICATE KEY UPDATE `description` = VALUES(`description`);
