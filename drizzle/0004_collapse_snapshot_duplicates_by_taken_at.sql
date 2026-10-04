DELETE FROM snapshots
WHERE id NOT IN (SELECT MAX(id) FROM snapshots GROUP BY taken_at);
--> statement-breakpoint
UPDATE snapshots SET dedup_key = taken_at;
