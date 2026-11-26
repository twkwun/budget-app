-- Budgets and 고정지출 become personal: each row belongs to one member.
-- Nothing references these tables, so they are rebuilt with the new column.
-- What the family set up so far goes to the first active admin (the person
-- who ran the household budget); members start with none of their own.
CREATE TABLE `__new_budgets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
	`month` text NOT NULL,
	`category_id` integer,
	`amount` integer NOT NULL,
	`updated_by_user_id` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsec') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "budgets_amount_check" CHECK(amount >= 0)
);
--> statement-breakpoint
INSERT INTO `__new_budgets` (`id`, `user_id`, `month`, `category_id`, `amount`, `updated_by_user_id`, `created_at`, `updated_at`)
SELECT b.`id`, o.`id`, b.`month`, b.`category_id`, b.`amount`, b.`updated_by_user_id`, b.`created_at`, b.`updated_at`
FROM `budgets` b
JOIN (
	SELECT `id` FROM `users`
	ORDER BY (`role` = 'admin' AND `disabled_at` IS NULL) DESC, `id`
	LIMIT 1
) o;--> statement-breakpoint
DROP TABLE `budgets`;--> statement-breakpoint
ALTER TABLE `__new_budgets` RENAME TO `budgets`;--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_user_month_category_unique` ON `budgets` (`user_id`,`month`,`category_id`) WHERE category_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `budgets_user_month_total_unique` ON `budgets` (`user_id`,`month`) WHERE category_id is null;--> statement-breakpoint
CREATE TABLE `__new_recurring_expenses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` integer NOT NULL,
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
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "recurring_day_check" CHECK(day_of_month between 1 and 31),
	CONSTRAINT "recurring_amount_check" CHECK(amount > 0)
);
--> statement-breakpoint
INSERT INTO `__new_recurring_expenses` (`id`, `user_id`, `name`, `match_key`, `amount`, `day_of_month`, `category_id`, `account_id`, `status`, `source`, `created_by_user_id`, `created_at`, `updated_at`)
SELECT r.`id`, o.`id`, r.`name`, r.`match_key`, r.`amount`, r.`day_of_month`, r.`category_id`, r.`account_id`, r.`status`, r.`source`, r.`created_by_user_id`, r.`created_at`, r.`updated_at`
FROM `recurring_expenses` r
JOIN (
	SELECT `id` FROM `users`
	ORDER BY (`role` = 'admin' AND `disabled_at` IS NULL) DESC, `id`
	LIMIT 1
) o;--> statement-breakpoint
DROP TABLE `recurring_expenses`;--> statement-breakpoint
ALTER TABLE `__new_recurring_expenses` RENAME TO `recurring_expenses`;--> statement-breakpoint
CREATE UNIQUE INDEX `recurring_expenses_user_match_key_unique` ON `recurring_expenses` (`user_id`,`match_key`);--> statement-breakpoint
CREATE INDEX `recurring_expenses_status_idx` ON `recurring_expenses` (`status`);
