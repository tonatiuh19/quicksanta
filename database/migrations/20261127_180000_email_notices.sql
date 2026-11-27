-- Idempotency ledger for one-off / scheduled emails (reveal day, Pro grace ended, daily reminder limit…).
-- INSERT IGNORE on (kind, ref): only the first writer sends, however many webhooks/crons/retries race.
CREATE TABLE IF NOT EXISTS `email_notices` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `tenant_id` BIGINT UNSIGNED NULL,
  `kind` VARCHAR(40) NOT NULL,
  `ref` VARCHAR(160) NOT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_email_notice` (`kind`, `ref`),
  KEY `idx_email_notices_tenant` (`tenant_id`),
  CONSTRAINT `fk_email_notices_tenant` FOREIGN KEY (`tenant_id`) REFERENCES `tenants` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
