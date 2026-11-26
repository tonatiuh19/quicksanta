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
