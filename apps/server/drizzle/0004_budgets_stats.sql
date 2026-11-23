CREATE TABLE `recurring_expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`match_key` text NOT NULL,
	`amount` integer NOT NULL,
	`day_of_month` integer NOT NULL,
	`category_id` integer,
	`account_id` integer,
	`status` text DEFAULT 'suggested' NOT NULL,
	`source` text DEFAULT 'detected' NOT NULL,
	`created_by_user_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recurring_day_check" CHECK(day_of_month between 1 and 31),
	CONSTRAINT "recurring_amount_check" CHECK(amount > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_expenses_match_key_unique` ON `recurring_expenses` (`match_key`);--> statement-breakpoint
CREATE INDEX `recurring_expenses_status_idx` ON `recurring_expenses` (`status`);--> statement-breakpoint
ALTER TABLE `budgets` ADD `updated_by_user_id` integer REFERENCES users(id);