CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`owner_user_id` integer NOT NULL,
	`primary_user_id` integer,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`issuer` text,
	`last4` text,
	`billing_day` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`primary_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "accounts_last4_check" CHECK(last4 is null or last4 glob '[0-9][0-9][0-9][0-9]'),
	CONSTRAINT "accounts_billing_day_check" CHECK(billing_day is null or billing_day between 1 and 31)
);
--> statement-breakpoint
CREATE INDEX `accounts_owner_idx` ON `accounts` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `accounts_issuer_last4_idx` ON `accounts` (`issuer`,`last4`);--> statement-breakpoint
CREATE TABLE `budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`month` text NOT NULL,
	`category_id` integer,
	`amount` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "budgets_amount_check" CHECK(amount >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_month_category_unique` ON `budgets` (`month`,`category_id`) WHERE category_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_month_total_unique` ON `budgets` (`month`) WHERE category_id is null;--> statement-breakpoint
CREATE TABLE `categories` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`parent_id` integer,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`system_key` text,
	`icon` text,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`archived_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_system_key_unique` ON `categories` (`system_key`);--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`);--> statement-breakpoint
CREATE TABLE `category_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`pattern` text NOT NULL,
	`match_type` text DEFAULT 'contains' NOT NULL,
	`category_id` integer NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `category_rules_priority_idx` ON `category_rules` (`priority`);--> statement-breakpoint
CREATE INDEX `category_rules_category_idx` ON `category_rules` (`category_id`);--> statement-breakpoint
CREATE TABLE `import_batches` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`format` text NOT NULL,
	`file_name` text,
	`file_sha256` text,
	`status` text DEFAULT 'previewed' NOT NULL,
	`new_count` integer DEFAULT 0 NOT NULL,
	`duplicate_count` integer DEFAULT 0 NOT NULL,
	`review_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`applied_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `import_batches_user_idx` ON `import_batches` (`user_id`);--> statement-breakpoint
CREATE INDEX `import_batches_file_idx` ON `import_batches` (`file_sha256`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`device_type` text,
	`backed_up` integer DEFAULT false NOT NULL,
	`device_name` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `passkeys_user_idx` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `raw_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source` text NOT NULL,
	`user_id` integer,
	`webhook_token_id` integer,
	`import_batch_id` integer,
	`received_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`raw_text` text NOT NULL,
	`content_hash` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`parser` text,
	`parsed` text,
	`error` text,
	`transaction_id` integer,
	`processed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`webhook_token_id`) REFERENCES `webhook_tokens`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`import_batch_id`) REFERENCES `import_batches`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `raw_records_status_idx` ON `raw_records` (`status`);--> statement-breakpoint
CREATE INDEX `raw_records_transaction_idx` ON `raw_records` (`transaction_id`);--> statement-breakpoint
CREATE INDEX `raw_records_hash_idx` ON `raw_records` (`content_hash`);--> statement-breakpoint
CREATE INDEX `raw_records_batch_idx` ON `raw_records` (`import_batch_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_verified_at` integer,
	`user_agent` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`occurred_at` integer NOT NULL,
	`occurred_date` text NOT NULL,
	`type` text NOT NULL,
	`amount` integer NOT NULL,
	`original_amount` integer,
	`merchant` text,
	`memo` text,
	`category_id` integer,
	`account_id` integer,
	`owner_user_id` integer NOT NULL,
	`status` text DEFAULT 'confirmed' NOT NULL,
	`source` text NOT NULL,
	`installment_months` integer,
	`approval_no` text,
	`is_private` integer DEFAULT false NOT NULL,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "transactions_amount_check" CHECK(amount >= 0),
	CONSTRAINT "transactions_original_amount_check" CHECK(original_amount is null or original_amount >= amount),
	CONSTRAINT "transactions_installment_check" CHECK(installment_months is null or installment_months >= 2)
);
--> statement-breakpoint
CREATE INDEX `transactions_occurred_at_idx` ON `transactions` (`occurred_at`);--> statement-breakpoint
CREATE INDEX `transactions_occurred_date_idx` ON `transactions` (`occurred_date`);--> statement-breakpoint
CREATE INDEX `transactions_owner_occurred_idx` ON `transactions` (`owner_user_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `transactions_category_idx` ON `transactions` (`category_id`);--> statement-breakpoint
CREATE INDEX `transactions_merchant_idx` ON `transactions` (`merchant`);--> statement-breakpoint
CREATE INDEX `transactions_approval_idx` ON `transactions` (`account_id`,`approval_no`);--> statement-breakpoint
CREATE INDEX `transactions_dedupe_idx` ON `transactions` (`account_id`,`occurred_date`,`amount`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`login_name` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`webauthn_user_id` text NOT NULL,
	`password_hash` text,
	`recovery_code_hash` text,
	`lock_timeout_seconds` integer DEFAULT 300,
	`failed_login_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`disabled_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_login_name_unique` ON `users` (`login_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_webauthn_user_id_unique` ON `users` (`webauthn_user_id`);--> statement-breakpoint
CREATE TABLE `webhook_tokens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`device_name` text NOT NULL,
	`token_hash` text NOT NULL,
	`token_hint` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`last_received_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_tokens_token_hash_unique` ON `webhook_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `webhook_tokens_user_idx` ON `webhook_tokens` (`user_id`);