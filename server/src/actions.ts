import { defineAction, z, type ActionsModule } from "@hatch/space-sdk";
import { and, desc, eq, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
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

/**
 * Dedup identity of a snapshot is its takenAt — nothing else.
 *
 * Root cause of the P1-2 failure (verified 2026-10-04 against the live
 * DB): the previous key hashed snapshot CONTENT (cron nextRunAt /
 * lastRunAt, newsflow stamps, notes). Producers re-push the same
 * logical snapshot with takenAt pinned while those volatile fields
 * drift between pushes, so every re-push minted a fresh key, the
 * unique index on dedup_key never fired, and each push landed as a
 * plain INSERT. Rows 283/285 (the "byte-identical" probe pair) differ
 * exactly in crons[].nextRunAt; the 12:13:12 snapshot exists 3× for
 * the same reason. Keying on takenAt makes a re-push — identical or
 * merely same-timestamp — refresh the one stored row instead.
 */
function snapshotDedupKey(snap: Snapshot): string {
  return snap.takenAt;
}

function parsePayload(raw: string): Snapshot | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null) return v as Snapshot;
    return null;
  } catch {
    return null;
  }
}

function targetKeyFor(item: { severity: string; text: string }): string {
  const input = `${item.severity}\n${item.text}`;
  let h1 = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h1 ^= input.charCodeAt(i);
    h1 = Math.imul(h1, 0x01000193);
  }
  let h2 = 0x01000193;
  for (let i = input.length - 1; i >= 0; i--) {
    h2 ^= input.charCodeAt(i);
    h2 = Math.imul(h2, 0x811c9dc5);
  }
  return `att_${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

function actorFor(ctx: { viewer?: unknown }): string {
  const v = ctx.viewer as
    | { userId?: string; displayName?: string; viewerFbid?: string }
    | undefined;
  if (!v) return "viewer";
  return v.displayName ?? v.userId ?? v.viewerFbid ?? "viewer";
}

// Snapshot reads race the worker's ingest writes on the same SQLite
// file; a lock/busy error there is momentary, so ride it out with a
// short backoff instead of surfacing a 500 that blanks the dashboard.
function isTransientDbError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /locked|busy|temporarily unavailable|SQLITE_BUSY/i.test(msg);
}

async function withDbRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isTransientDbError(e) || i === attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 120 * (i + 1)));
    }
  }
  throw lastErr;
}

/* ---------- Phase 7: Reliability + Improvement centers ---------- */

const improvementStatusSchema = z.enum([
  "proposed",
  "testing",
  "verified",
  "rejected",
  "regressed",
  "rolled-back",
]);

const improvementItemSchema = z.object({
  id: z.number(),
  createdAt: z.string(),
  title: z.string(),
  problem: z.string(),
  discovery: z.string().nullable(),
  solution: z.string(),
  status: improvementStatusSchema,
  result: z.string().nullable(),
  verificationNotes: z.string().nullable(),
  updatedAt: z.string(),
});

type ImprovementItem = z.infer<typeof improvementItemSchema>;

function toImprovementItem(row: typeof schema.improvements.$inferSelect): ImprovementItem {
  return {
    id: row.id,
    createdAt: row.createdAt,
    title: row.title,
    problem: row.problem,
    discovery: row.discovery ?? null,
    solution: row.solution,
    status: row.status as ImprovementItem["status"],
    result: row.result ?? null,
    verificationNotes: row.verificationNotes ?? null,
    updatedAt: row.updatedAt,
  };
}

const TERMINAL_STATUSES = new Set(["verified", "rejected", "regressed", "rolled-back"]);

/** Never store secrets: reject obvious credential assignments. */
function containsSecretLike(value: string): boolean {
  return /(api[_-]?key|access[_-]?token|password|passwd|secret|bearer)\s*[:=]\s*\S+/i.test(value);
}

const SEED_IMPROVEMENTS: Array<{
  createdAt: string;
  title: string;
  problem: string;
  discovery: string | null;
  solution: string;
  status: ImprovementItem["status"];
  result: string;
  verificationNotes: string;
}> = [
  {
    createdAt: "2026-10-04T12:00:00+06:00",
    title: "P1-1 error boundary",
    problem: "One malformed entry white-screened the wall",
    discovery: null,
    solution: "Boundaries around stage + fleet with fallback + Retry",
    status: "verified",
    result: "Verified by builder QA",
    verificationNotes: "Builder QA 2026-10-04: fallback + Retry render without white-screening the wall",
  },
  {
    createdAt: "2026-10-04T12:00:00+06:00",
    title: "P1-2 idempotent ingest",
    problem: "Duplicate snapshots from concurrent pushes",
    discovery: "First fix failed independent test (dedup key hashed volatile fields)",
    solution: "dedup_key=takenAt + upsert + migration 0004",
    status: "verified",
    result: "Verified 2026-10-04 via double-push returning same id 291, zero duplicates",
    verificationNotes: "Double-push returned same id 291, zero duplicates (2026-10-04)",
  },
  {
    createdAt: "2026-10-04T12:00:00+06:00",
    title: "Phase 5 observability",
    problem: "Silent staleness/degradation",
    discovery: null,
    solution:
      "Server ingest watermark, DATA DEGRADED badge, journal unavailable state, dismissal audit log, health strip",
    status: "verified",
    result: "Verified at action layer 2026-10-04",
    verificationNotes: "Verified at action layer 2026-10-04",
  },
];

async function ensureSeedImprovements(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<void> {
  const existing = await db
    .select({ id: schema.improvements.id })
    .from(schema.improvements)
    .limit(1);
  if (existing.length > 0) return;
  for (const s of SEED_IMPROVEMENTS) {
    await db.insert(schema.improvements).values({
      createdAt: s.createdAt,
      title: s.title,
      problem: s.problem,
      discovery: s.discovery,
      solution: s.solution,
      status: s.status,
      result: s.result,
      verificationNotes: s.verificationNotes,
      updatedAt: s.createdAt,
    });
  }
}

/** Parse a cadence string ("every 10m", "hourly", "daily 14:15") into ms. */
function cadenceIntervalMsServer(cadence: string | null | undefined): number | null {
  if (!cadence) return null;
  const c = cadence.trim().toLowerCase();
  if (c === "hourly") return 3_600_000;
  if (c === "daily" || c.startsWith("daily")) return 86_400_000;
  if (c === "weekly" || c.startsWith("weekly")) return 604_800_000;
  const m = c.match(/^every\s+(\d+)\s*(m|min|mins|h|hr|hrs|d|day|days)\b/);
  if (m) {
    const n = Number(m[1]);
    const u = m[2] ?? "m";
    if (u.startsWith("h")) return n * 3_600_000;
    if (u.startsWith("d")) return n * 86_400_000;
    return n * 60_000;
  }
  return null;
}

function toMsOrNull(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
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
      const dedupKey = snapshotDedupKey(args.snapshot);
      const nowIso = new Date().toISOString();
      const insertedId = await withDbRetry(async () => {
        // Idempotent upsert: a duplicate push (same dedup key) refreshes
        // the stored payload instead of writing a second row.
        const upserted = await db
          .insert(schema.snapshots)
          .values({
            takenAt: args.snapshot.takenAt,
            dedupKey,
            payload,
          })
          .onConflictDoUpdate({
            target: schema.snapshots.dedupKey,
            set: { takenAt: args.snapshot.takenAt, payload },
          })
          .returning({ id: schema.snapshots.id });
        const row = upserted[0];
        if (!row) throw new Error("ingestSnapshot: upsert returned no rows");

        // Heal legacy duplicates: rows written before the takenAt-key
        // fix carry hash keys, so an upsert cannot see them. Collapse
        // any other row sharing this takenAt into the row just written.
        // Scoped strictly to the pushed takenAt — no other snapshot is
        // touched.
        await db
          .delete(schema.snapshots)
          .where(
            and(
              eq(schema.snapshots.takenAt, args.snapshot.takenAt),
              ne(schema.snapshots.id, row.id),
            ),
          );

        // Server-truth ingest watermark: last successful ingest time on
        // the server clock. The dashboard's freshness is driven from
        // this, not from the producer's takenAt.
        await db
          .insert(schema.ingestMeta)
          .values({ id: 1, lastIngestAt: nowIso })
          .onConflictDoUpdate({
            target: schema.ingestMeta.id,
            set: { lastIngestAt: nowIso },
          });

        // Prune to the last 48 snapshots in the same unit of work, so a
        // concurrent push cannot interleave between insert and prune.
        const rows = await db
          .select({ id: schema.snapshots.id })
          .from(schema.snapshots)
          .orderBy(desc(schema.snapshots.id));
        if (rows.length > 48) {
          const excess = rows.slice(48);
          const deletes = excess.map(
            (r) =>
              db
                .delete(schema.snapshots)
                .where(eq(schema.snapshots.id, r.id)) as unknown as BatchItem<"sqlite">,
          );
          const [first, ...rest] = deletes;
          if (first) await db.batch([first, ...rest]);
        }
        return row.id;
      });

      ctx.invalidateQueries();
      return { ok: true, id: insertedId };
    },
  }),

  getDashboard: defineAction({
    request: z.object({}),
    response: z.object({
      latest: z.any().nullable(),
      history: z.array(z.any()),
      serverTime: z.string(),
      ingestHealth: z.object({
        lastIngestAt: z.string().nullable(),
        ageSec: z.number().nullable(),
      }),
      dataQuality: z.enum(["ok", "degraded"]),
      degradedRowId: z.number().nullable(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await withDbRetry(() =>
        db
          .select()
          .from(schema.snapshots)
          .orderBy(desc(schema.snapshots.id))
          .limit(12),
      );
      const now = new Date();
      // Ingest watermark (server clock). Prefer the dedicated meta row;
      // fall back to the newest snapshot's received_at for rows written
      // before the watermark existed.
      let lastIngestAt: string | null = null;
      try {
        const meta = await withDbRetry(() =>
          db.select().from(schema.ingestMeta).where(eq(schema.ingestMeta.id, 1)),
        );
        const m = meta[0];
        if (m?.lastIngestAt) lastIngestAt = m.lastIngestAt;
      } catch {
        lastIngestAt = null;
      }
      if (!lastIngestAt && rows.length > 0) {
        const newest = rows[0];
        if (newest?.receivedAt) {
          lastIngestAt =
            newest.receivedAt instanceof Date
              ? newest.receivedAt.toISOString()
              : new Date(newest.receivedAt as unknown as number).toISOString();
        }
      }
      const ageSec =
        lastIngestAt != null
          ? Math.max(0, Math.floor((now.getTime() - new Date(lastIngestAt).getTime()) / 1000))
          : null;

      // Data quality: if the newest row fails to parse, do NOT promote
      // the next row as latest. Surface degraded + the offending id;
      // history still carries the last good snapshots for the client
      // to label explicitly.
      let isDegraded = false;
      let degradedRowId: number | null = null;
      let latest: Snapshot | null = null;
      const parsedAll: Snapshot[] = [];
      rows.forEach((r, idx) => {
        const p = parsePayload(r.payload);
        if (p) parsedAll.push(p);
        else if (idx === 0) {
          isDegraded = true;
          degradedRowId = r.id;
        }
      });
      const dataQuality: "ok" | "degraded" = isDegraded ? "degraded" : "ok";
      if (isDegraded) {
        latest = null;
      } else {
        latest = parsedAll[0] ?? null;
      }
      return {
        latest,
        history: parsedAll,
        serverTime: now.toISOString(),
        ingestHealth: { lastIngestAt, ageSec },
        dataQuality,
        degradedRowId,
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
      // Propagate failures so the client's journal.isError branch can
      // render "journal unavailable" — distinct from a legitimately
      // empty journal. Swallowing the error here made an unreadable
      // file indistinguishable from "no entries yet".
      const result = await ctx.executePrivileged(privileged.readJournal, {});
      return { entries: result.entries, source: result.source };
    },
  }),

  resolveAttention: defineAction({
    request: z.object({
      index: z.number().int().nonnegative(),
      targetKey: z.string().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      latest: z.any().nullable(),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const actor = actorFor(ctx as unknown as { viewer?: unknown });
      const dismissedAt = new Date().toISOString();
      const logDismissal = async (targetKey: string, result: "ok" | "failed") => {
        try {
          await db.insert(schema.attentionDismissals).values({
            dismissedAt,
            actor,
            action: "dismiss",
            targetKey,
            result,
          });
        } catch {
          // Audit logging must never break the dismissal itself.
        }
      };
      const rows = await withDbRetry(() =>
        db
          .select()
          .from(schema.snapshots)
          .orderBy(desc(schema.snapshots.id))
          .limit(1),
      );
      const row = rows[0];
      if (!row) {
        await logDismissal(args.targetKey ?? `missing:${args.index}`, "failed");
        return { ok: false, latest: null };
      }
      const snap = parsePayload(row.payload);
      if (!snap) {
        await logDismissal(args.targetKey ?? `corrupt:${row.id}`, "failed");
        return { ok: false, latest: null };
      }
      const attention = Array.isArray(snap.attention) ? [...snap.attention] : [];
      if (args.index < 0 || args.index >= attention.length) {
        await logDismissal(args.targetKey ?? `oob:${args.index}`, "failed");
        return { ok: false, latest: snap };
      }
      const item = attention[args.index];
      const stableKey = item ? targetKeyFor(item) : (args.targetKey ?? `oob:${args.index}`);
      // Prefer the client-supplied stable key when it matches; the
      // server-derived hash is authoritative for the audit trail.
      const auditKey = args.targetKey && args.targetKey === stableKey ? args.targetKey : stableKey;
      attention.splice(args.index, 1);
      const updated: Snapshot = { ...snap, attention };
      await withDbRetry(() =>
        db
          .update(schema.snapshots)
          .set({ payload: JSON.stringify(updated) })
          .where(eq(schema.snapshots.id, row.id)),
      );
      await logDismissal(auditKey, "ok");
      ctx.invalidateQueries();
      return { ok: true, latest: updated };
    },
  }),

  getReliability: defineAction({
    request: z.object({}),
    response: z.object({
      generatedAt: z.string(),
      window: z.object({
        snapshotCount: z.number(),
        fromTakenAt: z.string().nullable(),
        toTakenAt: z.string().nullable(),
      }),
      failed: z.array(
        z.object({
          scheduleId: z.string(),
          title: z.string(),
          cadence: z.string().nullable(),
          lastFailedRunAt: z.string().nullable(),
          lastFailedSnapshotAt: z.string().nullable(),
          failureCount: z.number(),
          totalRuns: z.number(),
          consecutiveStreak: z.number(),
        }),
      ),
      overdue: z.array(
        z.object({
          scheduleId: z.string(),
          title: z.string(),
          cadence: z.string().nullable(),
          lastRunAt: z.string().nullable(),
          nextRunAt: z.string().nullable(),
          expectedIntervalMs: z.number(),
          overdueMs: z.number(),
        }),
      ),
      recovered: z.array(
        z.object({
          scheduleId: z.string(),
          title: z.string(),
          failedRunAt: z.string().nullable(),
          recoveredRunAt: z.string().nullable(),
          failedSnapshotAt: z.string().nullable(),
          recoveredSnapshotAt: z.string().nullable(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await withDbRetry(() =>
        db
          .select()
          .from(schema.snapshots)
          .orderBy(desc(schema.snapshots.id))
          .limit(48),
      );
      const parsed: Snapshot[] = [];
      for (const r of rows) {
        const p = parsePayload(r.payload);
        if (p) parsed.push(p);
      }
      // Chronological (oldest first) for streak / flip detection.
      const chrono = [...parsed].reverse();
      const now = new Date();

      type RunRec = { at: string; st: string | null; snapshotAt: string };
      // Distinct runs per schedule (keyed by lastRunAt), chronological.
      const runsById = new Map<string, RunRec[]>();
      const seenRun = new Map<string, Set<string>>();
      const titleById = new Map<string, string>();
      const cadenceById = new Map<string, string | null>();
      for (const snap of chrono) {
        for (const c of snap.crons ?? []) {
          titleById.set(c.id, c.title ?? c.id);
          cadenceById.set(c.id, c.cadence ?? null);
          if (!c.lastRunAt) continue;
          let seen = seenRun.get(c.id);
          if (!seen) {
            seen = new Set<string>();
            seenRun.set(c.id, seen);
          }
          if (seen.has(c.lastRunAt)) continue;
          seen.add(c.lastRunAt);
          let arr = runsById.get(c.id);
          if (!arr) {
            arr = [];
            runsById.set(c.id, arr);
          }
          arr.push({
            at: c.lastRunAt,
            st: c.lastRunStatus ?? null,
            snapshotAt: snap.takenAt,
          });
        }
      }
      for (const arr of runsById.values()) {
        arr.sort((a, b) => (toMsOrNull(a.at) ?? 0) - (toMsOrNull(b.at) ?? 0));
      }

      // Failed: schedules with at least one distinct failed run.
      const failed: Array<{
        scheduleId: string;
        title: string;
        cadence: string | null;
        lastFailedRunAt: string | null;
        lastFailedSnapshotAt: string | null;
        failureCount: number;
        totalRuns: number;
        consecutiveStreak: number;
      }> = [];
      for (const [id, runs] of runsById) {
        const fails = runs.filter((r) => r.st === "failed");
        if (fails.length === 0) continue;
        // Consecutive streak from the newest run backwards.
        let streak = 0;
        for (let i = runs.length - 1; i >= 0; i--) {
          if (runs[i]?.st === "failed") streak++;
          else break;
        }
        const lastFail = fails[fails.length - 1];
        failed.push({
          scheduleId: id,
          title: titleById.get(id) ?? id,
          cadence: cadenceById.get(id) ?? null,
          lastFailedRunAt: lastFail?.at ?? null,
          lastFailedSnapshotAt: lastFail?.snapshotAt ?? null,
          failureCount: fails.length,
          totalRuns: runs.length,
          consecutiveStreak: streak,
        });
      }
      failed.sort(
        (a, b) =>
          b.consecutiveStreak - a.consecutiveStreak ||
          b.failureCount - a.failureCount ||
          a.title.localeCompare(b.title),
      );

      // Recovered: a failed distinct run followed by a completed one.
      const recovered: Array<{
        scheduleId: string;
        title: string;
        failedRunAt: string | null;
        recoveredRunAt: string | null;
        failedSnapshotAt: string | null;
        recoveredSnapshotAt: string | null;
      }> = [];
      for (const [id, runs] of runsById) {
        let lastFail: RunRec | null = null;
        for (const r of runs) {
          if (r.st === "failed") lastFail = r;
          else if (r.st === "completed" && lastFail) {
            recovered.push({
              scheduleId: id,
              title: titleById.get(id) ?? id,
              failedRunAt: lastFail.at,
              recoveredRunAt: r.at,
              failedSnapshotAt: lastFail.snapshotAt,
              recoveredSnapshotAt: r.snapshotAt,
            });
            lastFail = null;
          }
        }
      }
      recovered.sort(
        (a, b) => (toMsOrNull(b.recoveredRunAt) ?? 0) - (toMsOrNull(a.recoveredRunAt) ?? 0),
      );

      // Overdue: from the LATEST snapshot only, now - lastRunAt > 2x interval.
      const latestSnap = parsed[0] ?? null;
      const overdue: Array<{
        scheduleId: string;
        title: string;
        cadence: string | null;
        lastRunAt: string | null;
        nextRunAt: string | null;
        expectedIntervalMs: number;
        overdueMs: number;
      }> = [];
      if (latestSnap) {
        for (const c of latestSnap.crons ?? []) {
          if (!c.lastRunAt) continue;
          // A deliberately disabled schedule is not "overdue" — it is
          // off on purpose. Only enabled schedules can be overdue.
          if (c.enabled === false || c.status === "disabled") continue;
          const interval = cadenceIntervalMsServer(c.cadence);
          if (!interval || interval <= 0) continue;
          const lastMs = toMsOrNull(c.lastRunAt);
          if (lastMs == null) continue;
          const elapsed = now.getTime() - lastMs;
          if (elapsed > 2 * interval) {
            overdue.push({
              scheduleId: c.id,
              title: c.title ?? c.id,
              cadence: c.cadence ?? null,
              lastRunAt: c.lastRunAt,
              nextRunAt: c.nextRunAt ?? null,
              expectedIntervalMs: interval,
              overdueMs: elapsed - 2 * interval,
            });
          }
        }
      }
      overdue.sort((a, b) => b.overdueMs - a.overdueMs);

      return {
        generatedAt: now.toISOString(),
        window: {
          snapshotCount: parsed.length,
          fromTakenAt: chrono[0]?.takenAt ?? null,
          toTakenAt: chrono[chrono.length - 1]?.takenAt ?? null,
        },
        failed,
        overdue,
        recovered,
      };
    },
  }),

  listImprovements: defineAction({
    request: z.object({}),
    response: z.object({
      items: z.array(improvementItemSchema),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const items = await withDbRetry(async () => {
        await ensureSeedImprovements(db);
        const rows = await db
          .select()
          .from(schema.improvements)
          .orderBy(desc(schema.improvements.id));
        return rows.map(toImprovementItem);
      });
      return { items };
    },
  }),

  proposeImprovement: defineAction({
    request: z.object({
      title: z.string(),
      problem: z.string(),
      discovery: z.string().optional(),
      solution: z.string(),
    }),
    response: z.object({
      ok: z.boolean(),
      id: z.number().nullable(),
      item: improvementItemSchema.nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      id: number | null;
      item: ImprovementItem | null;
      error: string | null;
    }> => {
      const title = args.title.trim();
      const problem = args.problem.trim();
      const discovery = (args.discovery ?? "").trim();
      const solution = args.solution.trim();
      if (!title || !problem || !solution) {
        return {
          ok: false,
          id: null,
          item: null,
          error: "Title, problem and solution are required.",
        };
      }
      if (
        containsSecretLike(title) ||
        containsSecretLike(problem) ||
        containsSecretLike(discovery) ||
        containsSecretLike(solution)
      ) {
        return {
          ok: false,
          id: null,
          item: null,
          error: "Entries must not contain secrets or credentials.",
        };
      }
      const db = ctx.db<typeof schema>();
      const nowIso = new Date().toISOString();
      const item = await withDbRetry(async () => {
        await ensureSeedImprovements(db);
        const inserted = await db
          .insert(schema.improvements)
          .values({
            createdAt: nowIso,
            title,
            problem,
            discovery: discovery === "" ? null : discovery,
            solution,
            status: "proposed",
            result: null,
            verificationNotes: null,
            updatedAt: nowIso,
          })
          .returning();
        const row = inserted[0];
        return row ? toImprovementItem(row) : null;
      });
      ctx.invalidateQueries();
      return { ok: item !== null, id: item?.id ?? null, item, error: null };
    },
  }),

  updateImprovementStatus: defineAction({
    request: z.object({
      id: z.number().int().positive(),
      status: improvementStatusSchema,
      result: z.string().optional(),
      verificationNotes: z.string().optional(),
    }),
    response: z.object({
      ok: z.boolean(),
      item: improvementItemSchema.nullable(),
      error: z.string().nullable(),
    }),
    handler: async (
      ctx,
      args,
    ): Promise<{
      ok: boolean;
      item: ImprovementItem | null;
      error: string | null;
    }> => {
      const result = (args.result ?? "").trim();
      const verificationNotes = (args.verificationNotes ?? "").trim();
      if (TERMINAL_STATUSES.has(args.status)) {
        if (!result || !verificationNotes) {
          return {
            ok: false,
            item: null,
            error:
              "A result and verification note are required to mark verified, rejected, regressed or rolled-back.",
          };
        }
      }
      if (
        (result && containsSecretLike(result)) ||
        (verificationNotes && containsSecretLike(verificationNotes))
      ) {
        return {
          ok: false,
          item: null,
          error: "Entries must not contain secrets or credentials.",
        };
      }
      const db = ctx.db<typeof schema>();
      const nowIso = new Date().toISOString();
      const outcome = await withDbRetry(async () => {
        await ensureSeedImprovements(db);
        const existing = await db
          .select()
          .from(schema.improvements)
          .where(eq(schema.improvements.id, args.id));
        const row0 = existing[0];
        if (!row0) return { found: false as const, item: null as ImprovementItem | null };
        const updated = await db
          .update(schema.improvements)
          .set({
            status: args.status,
            result: result === "" ? row0.result : result,
            verificationNotes:
              verificationNotes === "" ? row0.verificationNotes : verificationNotes,
            updatedAt: nowIso,
          })
          .where(eq(schema.improvements.id, args.id))
          .returning();
        const row = updated[0];
        return { found: true as const, item: row ? toImprovementItem(row) : null };
      });
      if (!outcome.found) {
        return { ok: false, item: null, error: "Improvement not found." };
      }
      ctx.invalidateQueries();
      return { ok: outcome.item !== null, item: outcome.item, error: null };
    },
  }),
} satisfies ActionsModule;
