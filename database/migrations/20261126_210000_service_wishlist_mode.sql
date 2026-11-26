-- Each service decides whether wishlists exist: off (Secret Santa, White Elephant, Cookie Swap),
-- required (Wishlist Exchange, the Pro service built around them), optional (Book Swap, Create your own).
ALTER TABLE `event_types` ADD COLUMN `wishlist_mode` ENUM('off','required','optional') NOT NULL DEFAULT 'off' AFTER `requires_pro`;
UPDATE `event_types` SET `wishlist_mode` = 'required' WHERE `slug` = 'wishlist_exchange';
UPDATE `event_types` SET `wishlist_mode` = 'optional' WHERE `slug` IN ('book_swap', 'custom');
UPDATE `event_types` SET `wishlist_mode` = 'off' WHERE `slug` IN ('secret_santa', 'white_elephant', 'cookie_swap');
