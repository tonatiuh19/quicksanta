-- Shareable invite link + short code per exchange (anyone with it can join after signing in with email OTP).
-- Closes automatically at the draw; plan limit always applies; optional cap + expiry set by the organizer.
ALTER TABLE `events` ADD COLUMN `join_code` CHAR(8) NULL;
ALTER TABLE `events` ADD COLUMN `join_enabled` TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE `events` ADD COLUMN `join_max` INT UNSIGNED NULL;
ALTER TABLE `events` ADD COLUMN `join_expires_at` DATETIME NULL;
ALTER TABLE `events` ADD UNIQUE KEY `uq_events_join_code` (`join_code`);

-- How each person got in (link joins count toward `join_max`; shown to the organizer).
ALTER TABLE `participants` ADD COLUMN `joined_via` ENUM('email','link') NOT NULL DEFAULT 'email';
