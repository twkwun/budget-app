ALTER TABLE `category_rules` ADD `system_key` text;--> statement-breakpoint
ALTER TABLE `category_rules` ADD `disabled_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `category_rules_system_key_unique` ON `category_rules` (`system_key`);--> statement-breakpoint
ALTER TABLE `raw_records` ADD `sender` text;--> statement-breakpoint
ALTER TABLE `raw_records` ADD `client_received_at` integer;--> statement-breakpoint
ALTER TABLE `raw_records` ADD `issue` text;--> statement-breakpoint
ALTER TABLE `raw_records` ADD `issue_data` text;--> statement-breakpoint
ALTER TABLE `raw_records` ADD `resolved_at` integer;--> statement-breakpoint
CREATE INDEX `raw_records_issue_idx` ON `raw_records` (`issue`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `raw_records_token_hash_idx` ON `raw_records` (`webhook_token_id`,`content_hash`);--> statement-breakpoint
ALTER TABLE `transactions` ADD `merchant_key` text;--> statement-breakpoint
CREATE INDEX `transactions_merchant_key_idx` ON `transactions` (`merchant_key`,`occurred_at`);--> statement-breakpoint
ALTER TABLE `webhook_tokens` ADD `received_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `webhook_tokens` ADD `ignored_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `webhook_tokens` ADD `last_ignored_at` integer;