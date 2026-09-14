CREATE TABLE `product_sale_unit_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`managed_product_id` integer NOT NULL,
	`wake_sku` text NOT NULL,
	`source_unit` text NOT NULL,
	`quantity_per_sale_unit` real NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`managed_product_id`) REFERENCES `managed_products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_sale_unit_config_quantity_positive" CHECK("product_sale_unit_config"."quantity_per_sale_unit" > 0)
);
--> statement-breakpoint
CREATE INDEX `product_sale_unit_config_managed_product_id_idx` ON `product_sale_unit_config` (`managed_product_id`);--> statement-breakpoint
CREATE INDEX `product_sale_unit_config_wake_sku_idx` ON `product_sale_unit_config` (`wake_sku`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_sale_unit_config_one_active_idx` ON `product_sale_unit_config` (`managed_product_id`) WHERE "product_sale_unit_config"."active" = 1;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sync_product_state` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`managed_product_id` integer NOT NULL,
	`erp_price` real,
	`erp_stock` real,
	`erp_read_at` text,
	`unit_raw` text,
	`unit_normalized` text,
	`unit_class` text,
	`unit_resolution_status` text,
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
INSERT INTO `__new_sync_product_state`("id", "managed_product_id", "erp_price", "erp_stock", "erp_read_at", "calculated_wake_unit_price", "calculated_wake_special_price", "calculated_wake_stock", "last_applied_wake_unit_price", "last_applied_wake_special_price", "last_applied_wake_stock", "last_applied_at", "last_sync_run_id", "updated_at") SELECT "id", "managed_product_id", "erp_price", "erp_stock", "erp_read_at", "calculated_wake_unit_price", "calculated_wake_special_price", "calculated_wake_stock", "last_applied_wake_unit_price", "last_applied_wake_special_price", "last_applied_wake_stock", "last_applied_at", "last_sync_run_id", "updated_at" FROM `sync_product_state`;--> statement-breakpoint
DROP TABLE `sync_product_state`;--> statement-breakpoint
ALTER TABLE `__new_sync_product_state` RENAME TO `sync_product_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sync_product_state_managed_product_id_idx` ON `sync_product_state` (`managed_product_id`);