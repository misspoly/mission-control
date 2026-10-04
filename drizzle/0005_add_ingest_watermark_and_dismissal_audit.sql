CREATE TABLE ingest_meta (
  id INTEGER PRIMARY KEY,
  last_ingest_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE attention_dismissals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dismissed_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_key TEXT NOT NULL,
  result TEXT NOT NULL
);
