ALTER TABLE `curios` ADD COLUMN `pos_x` real;
--> statement-breakpoint
ALTER TABLE `curios` ADD COLUMN `pos_y` real;
--> statement-breakpoint
ALTER TABLE `curios` ADD COLUMN `map_label` text DEFAULT '' NOT NULL;
--> statement-breakpoint
CREATE TABLE `entry_links` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `from_id` integer NOT NULL,
  `to_id` integer NOT NULL,
  `note` text DEFAULT '' NOT NULL,
  `created_at` integer NOT NULL
);
