-- Enterprise / sales inquiries from the landing page contact form (platform-level, not tenant-owned).
-- Managed in Command Center → Leads; the platform owners are emailed on each new request.
CREATE TABLE IF NOT EXISTS `contact_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name` VARCHAR(120) NOT NULL,
  `email` VARCHAR(190) NOT NULL,
  `company` VARCHAR(160) NULL,
  `team_size` ENUM('lt50','50_100','100_500','500_plus') NOT NULL,
  `message` TEXT NULL,
  `locale` ENUM('en','es') NOT NULL DEFAULT 'en',
  `status` ENUM('new','contacted','won','lost') NOT NULL DEFAULT 'new',
  `notes` VARCHAR(1000) NULL,
  `ip_hash` CHAR(64) NULL,
  `handled_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_contact_status` (`status`, `created_at`),
  KEY `idx_contact_email` (`email`),
  CONSTRAINT `fk_contact_handled_by` FOREIGN KEY (`handled_by`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
