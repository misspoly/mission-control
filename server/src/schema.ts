import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    takenAt: text("taken_at").notNull(),
    dedupKey: text("dedup_key"),
    receivedAt: integer("received_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
    payload: text("payload").notNull(),
  },
  (t) => [uniqueIndex("snapshots_dedup_key_unique").on(t.dedupKey)],
);

export const ingestMeta = sqliteTable("ingest_meta", {
  id: integer("id").primaryKey(),
  lastIngestAt: text("last_ingest_at").notNull(),
});

export const attentionDismissals = sqliteTable("attention_dismissals", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dismissedAt: text("dismissed_at").notNull(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  targetKey: text("target_key").notNull(),
  result: text("result").notNull(),
});

export const improvements = sqliteTable("improvements", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  createdAt: text("created_at").notNull(),
  title: text("title").notNull(),
  problem: text("problem").notNull(),
  discovery: text("discovery"),
  solution: text("solution").notNull(),
  status: text("status", {
    enum: ["proposed", "testing", "verified", "rejected", "regressed", "rolled-back"],
  }).notNull(),
  result: text("result"),
  verificationNotes: text("verification_notes"),
  updatedAt: text("updated_at").notNull(),
});
