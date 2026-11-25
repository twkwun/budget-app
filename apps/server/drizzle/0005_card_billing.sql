-- Add the usage-period cutoff in place: rebuilding `accounts` would drop the
-- table under foreign keys and null every transactions.account_id.
ALTER TABLE `accounts` ADD `cutoff_day` integer CONSTRAINT "accounts_cutoff_day_check" CHECK(cutoff_day is null or cutoff_day between 1 and 31);--> statement-breakpoint
-- Usual cutoff for the payment day (defaultCutoffDay in @budget/shared).
UPDATE `accounts` SET `cutoff_day` = CASE
  WHEN `billing_day` >= 15 THEN `billing_day` - 14
  WHEN `billing_day` = 14 THEN 31
  ELSE `billing_day` + 16
END WHERE `billing_day` IS NOT NULL;
