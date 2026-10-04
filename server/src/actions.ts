import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { desc, eq } from "drizzle-orm";
import * as schema from "./schema";
import { privileged } from "@space/privileged";

const cronItemSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    cadence: z.string().nullable().optional(),
    enabled: z.boolean().optional(),
    status: z
      .enum(["active", "paused", "disabled", "pending", "running"])
      .nullable()
      .optional(),
    lastRunAt: z.string().nullable().optional(),
    lastRunStatus: z
      .enum(["completed", "failed", "skipped"])
      .nullable()
      .optional(),
    nextRunAt: z.string().nullable().optional(),
  })
  .passthrough();

const attentionItemSchema = z
  .object({
    severity: z.enum(["action", "warn", "info"]),
    text: z.string(),
  })
  .passthrough();

const newsflowSchema = z
  .object({
    status: z.string(),
    target: z.string().nullable().optional(),
    pendingReview: z.number().nullable().optional(),
    published: z.number().nullable().optional(),
    warnings: z.number().nullable().optional(),
    lastPostAt: z.string().nullable().optional(),
    lastPostUrl: z.string().nullable().optional(),
  })
  .passthrough();

const snapshotSchema = z
  .object({
    takenAt: z.string(),
    crons: z.array(cronItemSchema).optional(),
    newsflow: newsflowSchema.nullable().optional(),
    attention: z.array(attentionItemSchema).optional(),
    notes: z.string().nullable().optional(),
  })
  .passthrough();

type Snapshot = z.infer<typeof snapshotSchema>;

function parsePayload(raw: string): Snapshot | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null) return v as Snapshot;
    return null;
  } catch {
    return null;
  }
}

export const Actions = {
  ingestSnapshot: defineAction({
    request: z.object({
      snapshot: snapshotSchema,
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.number(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const payload = JSON.stringify(args.snapshot);
      const result = await db
        .insert(schema.snapshots)
        .values({
          takenAt: args.snapshot.takenAt,
          payload,
        })
        .returning({ id: schema.snapshots.id });
      const inserted = result[0];
      if (!inserted) throw new Error("ingestSnapshot: insert returned no rows");

      // Keep last 48 snapshots
      try {
        const rows = await db
          .select({ id: schema.snapshots.id })
          .from(schema.snapshots)
          .orderBy(desc(schema.snapshots.id));
        if (rows.length > 48) {
          const excess = rows.slice(48);
          for (const r of excess) {
            await db
              .delete(schema.snapshots)
              .where(eq(schema.snapshots.id, r.id));
          }
        }
      } catch {
        // pruning is best-effort
      }

      ctx.invalidateQueries();
      return { ok: true, id: inserted.id };
    },
  }),

  getDashboard: defineAction({
    request: z.object({}),
    response: z.object({
      latest: z.any().nullable(),
      history: z.array(z.any()),
      serverTime: z.string(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.snapshots)
        .orderBy(desc(schema.snapshots.id))
        .limit(12);
      const parsed = rows
        .map((r) => parsePayload(r.payload))
        .filter((v): v is Snapshot => v !== null);
      return {
        latest: parsed[0] ?? null,
        history: parsed,
        serverTime: new Date().toISOString(),
      };
    },
  }),

  loadJournal: defineAction({
    request: z.object({}),
    response: z.object({
      entries: z.array(attentionItemSchema),
      source: z.string(),
    }),
    privileged: [privileged.readJournal],
    async handler(ctx) {
      try {
        const result = await ctx.executePrivileged(privileged.readJournal, {});
        return { entries: result.entries, source: result.source };
      } catch {
        return { entries: [], source: "workspace/mission-control/attention.json" };
      }
    },
  }),

  resolveAttention: defineAction({
    request: z.object({
      index: z.number().int().nonnegative(),
    }),
    response: z.object({
      ok: z.boolean(),
      latest: z.any().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.snapshots)
        .orderBy(desc(schema.snapshots.id))
        .limit(1);
      const row = rows[0];
      if (!row) return { ok: false, latest: null };
      const snap = parsePayload(row.payload);
      if (!snap) return { ok: false, latest: null };
      const attention = Array.isArray(snap.attention) ? [...snap.attention] : [];
      if (args.index < 0 || args.index >= attention.length) {
        return { ok: false, latest: snap };
      }
      attention.splice(args.index, 1);
      const updated: Snapshot = { ...snap, attention };
      await db
        .update(schema.snapshots)
        .set({ payload: JSON.stringify(updated) })
        .where(eq(schema.snapshots.id, row.id));
      ctx.invalidateQueries();
      return { ok: true, latest: updated };
    },
  }),
} satisfies ActionsModule;
