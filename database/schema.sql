-- Full current schema (concatenation of migrations). Never edit without adding a migration.
-- QuickSanta initial schema (TiDB / MySQL 8). Multi-tenant: every tenant-owned row carries tenant_id.

CREATE TABLE IF NOT EXISTS `system_settings` (
  `setting_key` VARCHAR(100) NOT NULL,
  `setting_value` TEXT NULL,
  `description` VARCHAR(255) NULL,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`setting_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One identity per email. platform_role is NULL for regular users; owner/admin run the Command Center.
CREATE TABLE IF NOT EXISTS `users` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` CHAR(26) NOT NULL,
  `email` VARCHAR(190) NOT NULL,
  `full_name` VARCHAR(120) NOT NULL DEFAULT '',
  `locale` ENUM('en','es') NOT NULL DEFAULT 'en',
  `platform_role` ENUM('owner','admin') NULL DEFAULT NULL,
  `status` ENUM('active','suspended') NOT NULL DEFAULT 'active',
  `last_login_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_users_email` (`email`),
  UNIQUE KEY `uq_users_public` (`public_id`),
  KEY `idx_users_platform_role` (`platform_role`),
  KEY `idx_users_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Passwordless login codes, keyed by email (first login == signup).
CREATE TABLE IF NOT EXISTS `otp_codes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email` VARCHAR(190) NOT NULL,
  `code_hash` CHAR(64) NOT NULL,
  `purpose` ENUM('login') NOT NULL DEFAULT 'login',
  `expires_at` DATETIME NOT NULL,
  `consumed_at` DATETIME NULL,
  `attempts` TINYINT UNSIGNED NOT NULL DEFAULT 0,
  `ip_address` VARCHAR(64) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_otp_email_created` (`email`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `user_sessions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `active_tenant_id` BIGINT UNSIGNED NULL,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `ip_address` VARCHAR(64) NULL,
  `user_agent` VARCHAR(255) NULL,
  `expires_at` DATETIME NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sessions_token` (`token_hash`),
  KEY `idx_sessions_user` (`user_id`),
  CONSTRAINT `fk_sessions_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A tenant is the workspace that owns exchanges (a family, a company, a club). Created implicitly by the wizard.
CREATE TABLE IF NOT EXISTS `tenants` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` CHAR(26) NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `slug` VARCHAR(80) NOT NULL,
  `status` ENUM('active','suspended','archived') NOT NULL DEFAULT 'active',
  `plan` ENUM('free','pro','enterprise') NOT NULL DEFAULT 'free',
  `max_events` INT UNSIGNED NOT NULL DEFAULT 10,
  `max_participants_per_event` INT UNSIGNED NOT NULL DEFAULT 100,
  `locale` ENUM('en','es') NOT NULL DEFAULT 'en',
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_tenants_slug` (`slug`),
  UNIQUE KEY `uq_tenants_public` (`public_id`),
  KEY `idx_tenants_status` (`status`),
  KEY `idx_tenants_created` (`created_at`),
  CONSTRAINT `fk_tenants_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `tenant_members` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NOT NULL,
  `role` ENUM('organizer','participant') NOT NULL DEFAULT 'participant',
  `status` ENUM('active','removed') NOT NULL DEFAULT 'active',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_member` (`tenant_id`, `user_id`),
  KEY `idx_member_user` (`user_id`),
  CONSTRAINT `fk_member_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_member_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Catalog of services (Secret Santa, white elephant, ...). Managed from the Command Center.
CREATE TABLE IF NOT EXISTS `event_types` (
  `id` INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug` VARCHAR(40) NOT NULL,
  `name_en` VARCHAR(80) NOT NULL,
  `name_es` VARCHAR(80) NOT NULL,
  `description_en` VARCHAR(255) NOT NULL DEFAULT '',
  `description_es` VARCHAR(255) NOT NULL DEFAULT '',
  `icon` VARCHAR(40) NOT NULL DEFAULT 'gift',
  `uses_draw` TINYINT(1) NOT NULL DEFAULT 1,
  `is_active` TINYINT(1) NOT NULL DEFAULT 1,
  `sort_order` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_event_types_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` CHAR(26) NOT NULL,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `event_type_id` INT UNSIGNED NOT NULL,
  `name` VARCHAR(140) NOT NULL,
  `description` TEXT NULL,
  `status` ENUM('draft','open','drawn','completed','cancelled') NOT NULL DEFAULT 'open',
  `budget_min` DECIMAL(10,2) NULL,
  `budget_max` DECIMAL(10,2) NULL,
  `currency` CHAR(3) NOT NULL DEFAULT 'USD',
  `exchange_date` DATE NULL,
  `rsvp_deadline` DATE NULL,
  `location` VARCHAR(200) NULL,
  `allow_wishlists` TINYINT(1) NOT NULL DEFAULT 1,
  `created_by` BIGINT UNSIGNED NULL,
  `drawn_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_events_public` (`public_id`),
  KEY `idx_events_tenant_status` (`tenant_id`, `status`),
  KEY `idx_events_tenant_date` (`tenant_id`, `exchange_date`),
  KEY `idx_events_created` (`created_at`),
  CONSTRAINT `fk_events_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_events_type` FOREIGN KEY (`event_type_id`) REFERENCES `event_types` (`id`),
  CONSTRAINT `fk_events_creator` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `participants` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id` CHAR(26) NOT NULL,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `event_id` BIGINT UNSIGNED NOT NULL,
  `user_id` BIGINT UNSIGNED NULL,
  `name` VARCHAR(120) NOT NULL,
  `email` VARCHAR(190) NOT NULL,
  `status` ENUM('invited','joined','declined','removed') NOT NULL DEFAULT 'invited',
  `invite_token_hash` CHAR(64) NULL,
  `invited_at` DATETIME NULL,
  `joined_at` DATETIME NULL,
  `wishlist` TEXT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_participants_public` (`public_id`),
  UNIQUE KEY `uq_participant_email` (`event_id`, `email`),
  UNIQUE KEY `uq_participant_invite` (`invite_token_hash`),
  KEY `idx_participants_tenant` (`tenant_id`),
  KEY `idx_participants_user` (`user_id`),
  CONSTRAINT `fk_participants_event` FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_participants_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_participants_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- "A must not give to B" (and optionally the reverse).
CREATE TABLE IF NOT EXISTS `exclusions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `event_id` BIGINT UNSIGNED NOT NULL,
  `giver_participant_id` BIGINT UNSIGNED NOT NULL,
  `receiver_participant_id` BIGINT UNSIGNED NOT NULL,
  `bidirectional` TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_exclusion` (`event_id`, `giver_participant_id`, `receiver_participant_id`),
  CONSTRAINT `fk_excl_event` FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_excl_giver` FOREIGN KEY (`giver_participant_id`) REFERENCES `participants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_excl_receiver` FOREIGN KEY (`receiver_participant_id`) REFERENCES `participants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `assignments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NOT NULL,
  `event_id` BIGINT UNSIGNED NOT NULL,
  `giver_participant_id` BIGINT UNSIGNED NOT NULL,
  `receiver_participant_id` BIGINT UNSIGNED NOT NULL,
  `viewed_at` DATETIME NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_assign_giver` (`event_id`, `giver_participant_id`),
  UNIQUE KEY `uq_assign_receiver` (`event_id`, `receiver_participant_id`),
  CONSTRAINT `fk_assign_event` FOREIGN KEY (`event_id`) REFERENCES `events` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assign_giver` FOREIGN KEY (`giver_participant_id`) REFERENCES `participants` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_assign_receiver` FOREIGN KEY (`receiver_participant_id`) REFERENCES `participants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `email_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NULL,
  `to_email` VARCHAR(190) NOT NULL,
  `template` VARCHAR(60) NOT NULL,
  `status` ENUM('sent','failed','dry_run') NOT NULL,
  `provider_id` VARCHAR(120) NULL,
  `error` VARCHAR(500) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_email_tenant` (`tenant_id`, `created_at`),
  KEY `idx_email_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `audit_log` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NULL,
  `actor_user_id` BIGINT UNSIGNED NULL,
  `action` VARCHAR(60) NOT NULL,
  `entity` VARCHAR(40) NOT NULL,
  `entity_id` VARCHAR(40) NULL,
  `meta` JSON NULL,
  `ip_address` VARCHAR(64) NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_audit_tenant` (`tenant_id`, `created_at`),
  KEY `idx_audit_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
-- First platform owner + the starter service catalog + settings.
INSERT IGNORE INTO `users` (`public_id`, `email`, `full_name`, `platform_role`, `status`)
VALUES ('01JQS0WNER00000000000000AG', 'alex@disruptinglabs.com', 'Alex Gomez', 'owner', 'active');
UPDATE `users` SET `platform_role` = 'owner' WHERE `email` = 'alex@disruptinglabs.com';

INSERT IGNORE INTO `event_types` (`slug`, `name_en`, `name_es`, `description_en`, `description_es`, `icon`, `uses_draw`, `sort_order`) VALUES
('secret_santa', 'Secret Santa', 'Amigo secreto', 'Everyone draws a secret person to gift. Fair, private, with exclusions.', 'Cada quien recibe en secreto a alguien a quien regalar. Justo, privado y con exclusiones.', 'gift', 1, 10),
('white_elephant', 'White Elephant', 'Intercambio de elefante blanco', 'Bring one fun gift, then steal and swap at the party.', 'Trae un regalo divertido y roba e intercambia en la fiesta.', 'party', 0, 20),
('wishlist_exchange', 'Wishlist Exchange', 'Intercambio por lista de deseos', 'A Secret Santa where everyone shares a wishlist first.', 'Un amigo secreto donde todos comparten su lista de deseos.', 'list', 1, 30),
('book_swap', 'Book Swap', 'Intercambio de libros', 'Draw a reader and gift a book you think they will love.', 'Recibe a un lector y regálale un libro que le encantará.', 'book', 1, 40),
('cookie_swap', 'Cookie Swap', 'Intercambio de galletas', 'Bake, bring, share. Track who brings what.', 'Hornea, trae y comparte. Registra quién trae qué.', 'cookie', 0, 50);

INSERT IGNORE INTO `system_settings` (`setting_key`, `setting_value`, `description`) VALUES
('app_version', NULL, 'Current production version (written by deploy:prod)'),
('release_notes_snapshot', NULL, 'Last release-notes snapshot commit'),
('session_days', '30', 'Login session lifetime in days'),
('default_max_events', '10', 'Default event limit for new tenants'),
('default_max_participants', '100', 'Default participant limit per event for new tenants'),
('signups_enabled', '1', 'Allow new tenants to be created from the wizard');
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
-- Grace period is counted from the first failed renewal, not from current_period_end (which Stripe advances).
ALTER TABLE `tenants` ADD COLUMN `past_due_since` DATETIME NULL AFTER `current_period_end`;
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
