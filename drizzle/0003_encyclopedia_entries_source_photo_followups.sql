ALTER TABLE curios ADD COLUMN image_blob_key TEXT;
--> statement-breakpoint
ALTER TABLE curios ADD COLUMN source_text TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE curios ADD COLUMN unreadable_note TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE curios ADD COLUMN followups_json TEXT NOT NULL DEFAULT '[]';
--> statement-breakpoint
ALTER TABLE curios ADD COLUMN updated_at INTEGER;
