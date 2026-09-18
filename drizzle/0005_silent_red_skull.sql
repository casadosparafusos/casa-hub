CREATE TABLE `product_sale_unit_config_events` (
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
	FOREIGN KEY (`managed_product_id`) REFERENCES `managed_products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `product_sale_unit_config_events_managed_product_id_idx` ON `product_sale_unit_config_events` (`managed_product_id`);--> statement-breakpoint
CREATE INDEX `product_sale_unit_config_events_created_at_idx` ON `product_sale_unit_config_events` (`created_at`);