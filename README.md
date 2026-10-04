# Mission Control

A 3D mission-control dashboard for monitoring automated background tasks (cron schedules) — each schedule rendered as a glowing node orbiting a central core.

## Views
- **3D Orbital** — nodes orbit the core; status is encoded as shape + color + label (never color alone): active = green sphere, pending = teal ring, running = bright cyan pulse, paused = amber cube, failed = red octahedron, disabled = gray icosahedron. Countdown rings show time-to-next-run; light-beam tethers pulse on every data refresh.
- **2D** — fitted top-down orbital map (default on small screens).
- **24H Timeline** — every schedule on a 24-hour strip with a glowing NOW line; pending = dashed block with countdown, running = bright block at NOW.

## Features
- ⌘K command palette, keyboard shortcuts (`1/2/3` switch views, `?` help)
- Live ticking countdowns, eased counters, status-flip toasts, stale-data badge
- Filters: ALL / ACTIVE / PENDING / RUNNING / ISSUES / STANDBY
- Attention feed + journal

## Data
The dashboard is fed by snapshot pushes (every 10 min in production) via the `ingestsnapshot` action:

```json
{
  "takenAt": "2026-10-04T10:44:53+06:00",
  "crons": [
    {"id": "...", "title": "...", "cadence": "hourly", "enabled": true,
     "status": "active|pending|running|paused|disabled",
     "lastRunAt": "...", "lastRunStatus": "completed|failed|null", "nextRunAt": "..."}
  ],
  "newsflow": {"status": "RUNNING", "pendingReview": 0, "...": "..."},
  "attention": [{"severity": "info", "text": "..."}],
  "notes": "..."
}
```

`pending` = a run is queued; `running` = a run is executing now (derived from the scheduler's queued/running run counts).

## Run it

```bash
bun install
bun run dev
```

## Status
Active development — the UI is being polished pass by pass (visual → live-feel → power features → hardening).
