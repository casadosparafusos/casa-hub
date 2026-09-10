CREATE TABLE `boxes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`managed_product_id` integer,
	`units_per_box` integer,
	`enabled` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`managed_product_id`) REFERENCES `managed_products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `imports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`filename` text NOT NULL,
	`imported_by` text,
	`total_rows` integer DEFAULT 0 NOT NULL,
	`created_rows` integer DEFAULT 0 NOT NULL,
	`updated_rows` integer DEFAULT 0 NOT NULL,
	`error_rows` integer DEFAULT 0 NOT NULL,
	`error_detail` text,
	`status` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_locks` (
	`resource` text PRIMARY KEY NOT NULL,
	`locked_at` text,
	`locked_by` text,
	`expires_at` text
);
--> statement-breakpoint
CREATE TABLE `managed_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ciss_product_id` text NOT NULL,
	`wake_product_variant_id` text NOT NULL,
	`wake_sku` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`import_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`import_id`) REFERENCES `imports`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `managed_products_ciss_product_id_idx` ON `managed_products` (`ciss_product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `managed_products_wake_variant_id_idx` ON `managed_products` (`wake_product_variant_id`);--> statement-breakpoint
CREATE INDEX `managed_products_active_idx` ON `managed_products` (`active`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `sync_product_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`managed_product_id` integer NOT NULL,
	`erp_price` real,
	`erp_stock` integer,
	`erp_read_at` text,
	`calculated_wake_unit_price` real,
	`calculated_wake_special_price` real,
	`calculated_wake_stock` integer,
	`last_applied_wake_unit_price` real,
	`last_applied_wake_special_price` real,
	`last_applied_wake_stock` integer,
	`last_applied_at` text,
	`last_sync_run_id` integer,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`managed_product_id`) REFERENCES `managed_products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_product_state_managed_product_id_idx` ON `sync_product_state` (`managed_product_id`);--> statement-breakpoint
CREATE TABLE `sync_run_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sync_run_id` integer NOT NULL,
	`managed_product_id` integer NOT NULL,
	`field` text NOT NULL,
	`source_old_value` real,
	`source_new_value` real,
	`target_old_value` real,
	`target_new_value` real,
	`wake_before_raw` text,
	`wake_after_raw` text,
	`status` text NOT NULL,
	`error_message` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`managed_product_id`) REFERENCES `managed_products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sync_run_items_sync_run_id_idx` ON `sync_run_items` (`sync_run_id`);--> statement-breakpoint
CREATE INDEX `sync_run_items_managed_product_id_idx` ON `sync_run_items` (`managed_product_id`);--> statement-breakpoint
CREATE INDEX `sync_run_items_status_idx` ON `sync_run_items` (`status`);--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`triggered_by` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total_products` integer DEFAULT 0 NOT NULL,
	`changed_products` integer DEFAULT 0 NOT NULL,
	`applied_products` integer DEFAULT 0 NOT NULL,
	`skipped_products` integer DEFAULT 0 NOT NULL,
	`failed_products` integer DEFAULT 0 NOT NULL,
	`error_summary` text,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`finished_at` text
);
--> statement-breakpoint
CREATE INDEX `sync_runs_started_at_idx` ON `sync_runs` (`started_at`);--> statement-breakpoint
CREATE INDEX `sync_runs_status_idx` ON `sync_runs` (`status`);