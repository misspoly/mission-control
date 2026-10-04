CREATE TABLE improvements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL,
  title TEXT NOT NULL,
  problem TEXT NOT NULL,
  discovery TEXT,
  solution TEXT NOT NULL,
  status TEXT NOT NULL,
  result TEXT,
  verification_notes TEXT,
  updated_at TEXT NOT NULL
);
