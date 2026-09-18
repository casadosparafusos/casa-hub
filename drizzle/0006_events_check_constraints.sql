PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_product_sale_unit_config_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`managed_product_id` integer NOT NULL,
	`action` text NOT NULL,
	`source_unit` text NOT NULL,
	`old_quantity_per_sale_unit` real,
	`new_quantity_per_sale_unit` real,
	`actor` text NOT NULL,
	`origin` text NOT NULL,
	`filename` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`managed_product_id`) REFERENCES `managed_products`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_sale_unit_config_events_action_check" CHECK("__new_product_sale_unit_config_events"."action" IN ('CREATE', 'UPDATE', 'DEACTIVATE', 'REACTIVATE')),
	CONSTRAINT "product_sale_unit_config_events_origin_check" CHECK("__new_product_sale_unit_config_events"."origin" IN ('MANUAL', 'IMPORT')),
	CONSTRAINT "product_sale_unit_config_events_source_unit_check" CHECK("__new_product_sale_unit_config_events"."source_unit" IN ('KG', 'MT')),
	CONSTRAINT "product_sale_unit_config_events_old_quantity_positive_check" CHECK("__new_product_sale_unit_config_events"."old_quantity_per_sale_unit" IS NULL OR "__new_product_sale_unit_config_events"."old_quantity_per_sale_unit" > 0),
	CONSTRAINT "product_sale_unit_config_events_new_quantity_positive_check" CHECK("__new_product_sale_unit_config_events"."new_quantity_per_sale_unit" IS NULL OR "__new_product_sale_unit_config_events"."new_quantity_per_sale_unit" > 0),
	CONSTRAINT "product_sale_unit_config_events_action_quantity_shape_check" CHECK(
        ("__new_product_sale_unit_config_events"."action" IN ('CREATE', 'REACTIVATE') AND "__new_product_sale_unit_config_events"."old_quantity_per_sale_unit" IS NULL AND "__new_product_sale_unit_config_events"."new_quantity_per_sale_unit" IS NOT NULL) OR
        ("__new_product_sale_unit_config_events"."action" = 'DEACTIVATE' AND "__new_product_sale_unit_config_events"."old_quantity_per_sale_unit" IS NOT NULL AND "__new_product_sale_unit_config_events"."new_quantity_per_sale_unit" IS NULL) OR
        ("__new_product_sale_unit_config_events"."action" = 'UPDATE' AND "__new_product_sale_unit_config_events"."old_quantity_per_sale_unit" IS NOT NULL AND "__new_product_sale_unit_config_events"."new_quantity_per_sale_unit" IS NOT NULL)
      )
);
--> statement-breakpoint
INSERT INTO `__new_product_sale_unit_config_events`("id", "managed_product_id", "action", "source_unit", "old_quantity_per_sale_unit", "new_quantity_per_sale_unit", "actor", "origin", "filename", "created_at") SELECT "id", "managed_product_id", "action", "source_unit", "old_quantity_per_sale_unit", "new_quantity_per_sale_unit", "actor", "origin", "filename", "created_at" FROM `product_sale_unit_config_events`;--> statement-breakpoint
DROP TABLE `product_sale_unit_config_events`;--> statement-breakpoint
ALTER TABLE `__new_product_sale_unit_config_events` RENAME TO `product_sale_unit_config_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `product_sale_unit_config_events_managed_product_id_idx` ON `product_sale_unit_config_events` (`managed_product_id`);--> statement-breakpoint
CREATE INDEX `product_sale_unit_config_events_created_at_idx` ON `product_sale_unit_config_events` (`created_at`);