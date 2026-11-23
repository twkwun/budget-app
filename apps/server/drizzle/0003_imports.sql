CREATE TABLE `import_account_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`label` text NOT NULL,
	`account_id` integer,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_account_mappings_label_unique` ON `import_account_mappings` (`label`);--> statement-breakpoint
CREATE TABLE `import_category_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`category_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_category_mappings_key_unique` ON `import_category_mappings` (`key`);--> statement-breakpoint
CREATE TABLE `import_profiles` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`header_signature` text NOT NULL,
	`column_map` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_profiles_header_signature_unique` ON `import_profiles` (`header_signature`);--> statement-breakpoint
ALTER TABLE `import_batches` ADD `skipped_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `row_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `container` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `sheet_name` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `header` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `header_signature` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `column_map` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `result` text;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `import_batches` ADD `undone_at` integer;--> statement-breakpoint
CREATE INDEX `raw_records_source_hash_idx` ON `raw_records` (`source`,`content_hash`);