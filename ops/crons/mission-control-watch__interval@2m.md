---
id: mission-control-watch
title: Mission Control state watcher
enabled: true
owner: goal:mission-control-dashboard
mode: task
schedule:
  kind: interval
  timezone: Asia/Dhaka
  at: 2026-10-04T11:12:02
  every: 2m
delivery:
  - chat_id: e3b10501-a32c-4fe7-a7bb-3207dbbe5943
metadata:
  tags: [cron:automatic-interval-anchor]
  originating_chat_context_json: '{"chat_id":"e3b10501-a32c-4fe7-a7bb-3207dbbe5943","origin_provider":"main","chat_kind":"direct","event_kind":"message","require_mention":false}'
  presentation_locale: en-US
---
# Mission Control state watcher (every 2 minutes) — keeps the dashboard truthful between the 10-minute snapshots.

You are the Mission Control state watcher. The 10-minute snapshot is too coarse to catch short runs: a task can queue, run, and finish between snapshots, so the dashboard would show "running" minutes after it finished (or miss it entirely). Your job: notice queued/running CHANGES quickly and push a fresh full snapshot when they happen. Do NOT message the user.

## Steps
1. `cron.list` with include_disabled=true. For each schedule where is_system=false AND is_heartbeat=false (same exclusions as the snapshot worker: skip the 24 feed-pulse jobs, deterministic-doctor, profile-image, heartbeat), call `cron.status(id)` and record enabled, title, schedule_key, last run time + status, next run time, queued_runs, running_runs.
2. Read ~/workspace/goals/mission-control-dashboard/hidden_files/watch_state.json — an object mapping schedule id → {"q": <queued_runs>, "r": <running_runs>}. If the file is missing or unreadable, treat it as {} (first run establishes the baseline, triggers nothing).
3. Compare: for each schedule, a state change = q or r differs from the stored values, or the schedule is not in the stored map at all.
4. ALWAYS write the current map to watch_state.json (even when nothing changed).
5. If NO state change: end quietly — no snapshot, no message.
6. If ANY state change: build and push a FULL snapshot yourself (same contract as the mission-control-snapshot worker — keep this in sync with it):
   a. For each schedule from step 1: title = title or id fallback; cadence = human text from schedule_key ("every 10m", "hourly", "every 8h", "daily 09:39"); status = "disabled" if enabled=false, else "running" if running_runs>0, else "pending" if queued_runs>0, else "active"; lastRunStatus = "succeeded"→"completed", "failed"→"failed", null→null. (The watcher's snapshot skips the two "paused" exceptions — the 10-minute worker is the authority for paused states; never mark paused here.)
   b. NewsFlow: `artifact.invoke_action` on slug `ai-newsflow`, action `getdashboard`; take agent.status, schedulerActive, stats.pendingReview, stats.published, stats.warnings, lastPostAt, lastPostUrl (null when absent). Target label "The AI Brief Page". On failure set newsflow.status="UNKNOWN" and note it.
   c. Attention: read ~/workspace/mission-control/attention.json (array of {severity, text}); [] if missing. Prepend failure-correlation items: among crons with lastRunStatus="failed" and known lastRunAt, group those that failed within 120s of each other; per group prepend {"severity":"error","text":"<Title A> and <Title B> both failed around HH:MM (within 2 min) — possibly related, check shared causes"}.
   d. Snapshot object: {"takenAt": "<now ISO +06:00>", "crons": [{"id","title","cadence","enabled","status","lastRunAt","lastRunStatus","nextRunAt"}], "newsflow": {...}, "attention": [...], "notes": "<e.g. '14 schedules tracked (7 active, 2 pending, 1 running, 4 disabled); watcher-triggered refresh'>"}. Nulls for unknown times, never empty strings.
   e. `artifact.invoke_action` on slug `mission-control`, action `ingestsnapshot`, args {"snapshot": <the object>}.
7. If the ingest in step 6 fails, do NOT retry in a loop and do NOT message the user — the scheduled 10-minute worker will recover on its next run.

## Delivery
Always silent. End with exactly `📡 watch ok` and nothing else.
