PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_product_sale_unit_config` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`managed_product_id` integer NOT NULL,
	`source_unit` text NOT NULL,
	`quantity_per_sale_unit` real NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`managed_product_id`) REFERENCES `managed_products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_sale_unit_config_quantity_positive" CHECK("__new_product_sale_unit_config"."quantity_per_sale_unit" > 0),
	CONSTRAINT "product_sale_unit_config_source_unit_check" CHECK("__new_product_sale_unit_config"."source_unit" IN ('KG', 'MT'))
);
--> statement-breakpoint
INSERT INTO `__new_product_sale_unit_config`("id", "managed_product_id", "source_unit", "quantity_per_sale_unit", "active", "created_at", "updated_at", "updated_by") SELECT "id", "managed_product_id", "source_unit", "quantity_per_sale_unit", "active", "created_at", "updated_at", "updated_by" FROM `product_sale_unit_config`;--> statement-breakpoint
DROP TABLE `product_sale_unit_config`;--> statement-breakpoint
ALTER TABLE `__new_product_sale_unit_config` RENAME TO `product_sale_unit_config`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `product_sale_unit_config_managed_product_id_idx` ON `product_sale_unit_config` (`managed_product_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_sale_unit_config_one_active_idx` ON `product_sale_unit_config` (`managed_product_id`) WHERE "product_sale_unit_config"."active" = 1;