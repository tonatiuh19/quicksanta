-- Grace period is counted from the first failed renewal, not from current_period_end (which Stripe advances).
ALTER TABLE `tenants` ADD COLUMN `past_due_since` DATETIME NULL AFTER `current_period_end`;
