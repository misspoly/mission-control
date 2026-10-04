ALTER TABLE snapshots ADD COLUMN dedup_key TEXT;
--> statement-breakpoint
CREATE UNIQUE INDEX snapshots_dedup_key_unique ON snapshots(dedup_key);
