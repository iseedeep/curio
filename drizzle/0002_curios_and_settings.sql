DROP TABLE IF EXISTS entries;
--> statement-breakpoint
CREATE TABLE curios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_input TEXT NOT NULL,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Science',
  method TEXT NOT NULL DEFAULT 'text',
  simple_answer TEXT NOT NULL DEFAULT '',
  why_it_matters TEXT NOT NULL DEFAULT '',
  connections_json TEXT NOT NULL DEFAULT '[]',
  follow_up TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  needs_retry INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE settings (
  id INTEGER PRIMARY KEY,
  is_premium INTEGER NOT NULL DEFAULT 0,
  checklist_json TEXT NOT NULL DEFAULT '{}'
);
--> statement-breakpoint
INSERT INTO settings (id, is_premium, checklist_json) VALUES (1, 0, '{}');
