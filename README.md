# Mission Control

A private mission-control dashboard for monitoring automated background tasks (cron schedules) — a futuristic AI operations command center. Schedules render as nodes in a 3D agent universe around a glowing core; statuses derive only from real snapshot data. No invented metrics, ever.

## UI structure

- **Header** — MISSION CONTROL branding, LIVE pill, real animated counters, search, notifications/help/avatar, Dhaka (Asia/Dhaka) clock.
- **Icon rail** (desktop) — Ops / Activity / 24H / Reliability / Improve / Fleet / Logs.
- **System health strip** — CORE + INGEST pills; DATA / JOURNAL / LINK states (`ok`, `degraded`, `unavailable`).
- **Hero 3D agent universe** — dynamic real schedule nodes on three orbital layers; status encoded as shape + color + label (never color alone). Adaptive 3D quality tiers keep it smooth (see Evolving system).
- **Views** — 3D, 2D (default on small screens / automatic fallback when WebGL fails or FPS stays low), 24H timeline, ACTIVITY stream, Reliability Center, Improvement Center, Fleet deck.
- **Current-task strip** — running/failed agents first, Next Up countdowns, live activity rail, failed-agent alerts.
- **Agent detail** — desktop drawer / mobile bottom sheet.
- **Fleet deck** — full-width schedule list with search and filters: ALL / ACTIVE / RUNNING / PENDING / PAUSED / FAILED / DISABLED.
- **Diagnostics** — discreet view (Ctrl+Shift+D or command palette) with real measured performance; the default dashboard look is unchanged by it.
- **Command palette** (⌘K) and keyboard shortcuts (`1/2/3` switch views, `?` help).
- Mobile-first at 390px with no horizontal overflow; WCAG-AA contrast, visible focus, keyboard support, 44px touch targets, `prefers-reduced-motion` honored. A distinct dim `NO SIGNAL` state shows before the first real snapshot.

## Data

The dashboard is fed by snapshot pushes (every 10 min in production) via the `ingestSnapshot` action:

```json
{
  "takenAt": "2026-10-04T10:44:53+06:00",
  "crons": [
    {"id": "...", "title": "...", "cadence": "hourly", "enabled": true,
     "status": "active|pending|running|paused|disabled",
     "lastRunAt": "...", "lastRunStatus": "completed|failed|null", "nextRunAt": "..."}
  ],
  "newsflow": {"status": "RUNNING", "pendingReview": 0, "published": 0, "warnings": 0,
               "lastPostAt": "...", "lastPostUrl": "..."},
  "attention": [{"severity": "info|warning|error", "text": "..."}],
  "notes": "..."
}
```

- `pending` = a run is queued; `running` = a run is executing now (derived from the scheduler's queued/running run counts). `paused` is only ever set by the 10-minute worker, never by the watcher.
- **Ingest is idempotent**: snapshot identity is `takenAt` (unique constraint + upsert); malformed records are repaired or skipped during normalization.
- Snapshots table capped at 48 rows (rolling delete on ingest); history view uses the last 12.
- Attention items are mutable only on the latest snapshot (`resolveAttention` splices the stored JSON, with an audit trail).
- Client polls `getDashboard` every 30s; the 200ms clock/freshness tick is isolated so it never re-renders the whole tree. Snapshot older than 15 min shows a STALE badge.
- Severity levels used across attention and the health strip: `info`, `warning`, `error`.

## Server actions

| Action | Kind | Purpose |
|---|---|---|
| `ingestSnapshot` | write | Store a worker-pushed snapshot (validated, deduped by `takenAt`) |
| `getDashboard` | read | Latest snapshot + ≤12 history rows, ingest health, data quality |
| `getReliability` | read | Failed / overdue / recovered derivations from snapshot history |
| `loadJournal` | read | Journal entries; distinct `JOURNAL UNAVAILABLE` state on failure |
| `resolveAttention` | mutate | Dismiss an attention item on the latest snapshot (audited) |
| `listImprovements` | read | Improvement items (seeds 3 real 2026-10-04 entries when empty) |
| `proposeImprovement` | write | New improvement, `proposed` status |
| `updateImprovementStatus` | mutate | Lifecycle transitions; terminal states require result + verification notes |

## Data pipeline

`cron worker (every 10 min)` → full snapshot JSON → `ingestSnapshot` (normalize → validate → upsert by `takenAt`) → SQLite → `getDashboard` (latest + history + `ingestHealth` + `dataQuality`) → React client (30s poll). Between pushes, the **state watcher** (every 2 min, `ops/crons/mission-control-watch__interval@2m.md`) detects queued/running changes and pushes a fresh full snapshot so short runs are never missed. Failure-correlation attention items are prepended when ≥2 schedules fail within 120s of each other.

## Evolving system (infrastructure; default look unchanged)

- **Performance monitor** — page load, DOM ready, frame rate, 3D scene FPS, JS heap (where exposed), long tasks, failed requests, JS errors, per-action latency, render counters. Real measured values only.
- **Adaptive 3D tiers** — PERFORMANCE / BALANCED / HIGH / ULTRA (particle count, bloom, pixel-ratio cap, connection animation, lighting). Auto-selected from device capability + rolling FPS; manual override persisted locally. Sustained-low-FPS 2D fallback unchanged.
- **Modular 3D engine** — six independent modules: orbital layers, particle fields, data streams/beams, holographic rings, energy pulses, background grid.
- **Feature flags** — `ENABLE_3D_PARTICLES`, `ENABLE_DYNAMIC_ORBITS`, `ENABLE_ADVANCED_LIGHTING`, `ENABLE_ADAPTIVE_RENDERING`.
- **Design versioning + rollback** — serializable `VisualConfig` (`VISUAL_CONFIG_V1` → `VISUAL_CONFIG_V1.1`); applying a change preserves the current config as the rollback target first.
- **UX auditor (advisory only)** — evaluates FPS trends, failed actions, long tasks, re-render hotspots, responsiveness, accessibility, complexity, consistency; emits plain-language suggestions labeled machine-generated and never changes anything automatically.

## Ops

- `ops/crons/mission-control-snapshot__interval@10m.md` — the 10-minute snapshot worker (paused-state authority).
- `ops/crons/mission-control-watch__interval@2m.md` — the state watcher (queued/running changes).
- DB migrations in `drizzle/` (0001–0006: snapshots table, dedup key, `takenAt` uniqueness, ingest watermark + dismissal audit, improvements table).

## Run it

```bash
bun install
bun run dev
```

## Status

Private build, active development. See `DATA-PLAN.md` for the full pass-by-pass build log.
