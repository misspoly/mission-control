---
id: mission-control-snapshot
title: Mission Control snapshot worker
enabled: true
owner: goal:mission-control-dashboard
mode: task
schedule:
  kind: interval
  timezone: Asia/Dhaka
  at: 2026-10-02T18:24:53
  every: 10m
delivery:
  - chat_id: c3109990-c6e4-42e4-b4b9-ffad6b2d614d
metadata:
  tags: [cron:automatic-interval-anchor]
  originating_chat_context_json: '{"chat_id":"e3b10501-a32c-4fe7-a7bb-3207dbbe5943","origin_provider":"main","chat_kind":"direct","provider":"main","event_kind":"message","require_mention":false,"device_id":"949aa9e8dd95987e"}'
  presentation_locale: en-US
---
# Mission Control snapshot worker (every 10 minutes) — serves the mission-control dashboard artifact.

You are the Mission Control snapshot worker. Collect the live state of Zyvex's automations and push it into the mission-control dashboard. Do NOT message the user.

## Steps

1. `cron.list` with include_disabled=true. For each schedule where is_system=false AND is_heartbeat=false (skip the 24 feed-pulse jobs, deterministic-doctor, profile-image, heartbeat — runtime infrastructure, not his agents), call `cron.status(id)` to get: enabled, schedule text, last run time + status, next run time, queued_runs, running_runs.
   - title: fall back to the schedule id whenever the title is null or empty. Several schedules (e.g. `agentic-feature-tour`, `cryptopulse-refresh`) have null titles — normalize this BEFORE building the snapshot, so the first ingest never fails validation.
   - cadence: human text from schedule_key, e.g. "every 10m", "hourly", "every 8h", "daily 09:39", "once 2026-11-02 05:00".
   - status: "disabled" if enabled=false; else "paused" for the two exceptions below; else "running" if running_runs>0 (a run is executing right now); else "pending" if queued_runs>0 (a run is queued, waiting to execute); else "active". Exceptions: `newsflow-cycle` → "paused" when the NewsFlow agent status (step 2) is not RUNNING; `fb-browser-comment-agent` → "paused" if the file ~/workspace/facebook-browser-comment-agent/PAUSED exists.
   - lastRunStatus: map "succeeded"→"completed", "failed"→"failed", null→null.
2. NewsFlow: `artifact.invoke_action` on slug `ai-newsflow`, action `getdashboard`. Take agent.status (RUNNING/PAUSED/...), schedulerActive, stats.pendingReview, stats.published, stats.warnings, lastPostAt, lastPostUrl (null when absent). Target label: "The AI Brief Page". If the call fails, set newsflow.status="UNKNOWN" and say so in notes.
3. Attention: read ~/workspace/mission-control/attention.json (array of {severity, text}) and include as-is. If the file is missing, use []. Then FAILURE CORRELATION: among the crons from step 1 with lastRunStatus="failed" and a known lastRunAt, find groups where 2+ crons failed within 120 seconds of each other. For each group, PREPEND an attention item: {"severity": "error", "text": "<Title A> and <Title B> both failed around HH:MM (within 2 min) — possibly related, check shared causes"}. Only add when such a group exists; never invent one.
4. Build the snapshot object:
   {"takenAt": "<now as ISO with +06:00 offset>", "crons": [{"id","title","cadence","enabled","status","lastRunAt","lastRunStatus","nextRunAt"}], "newsflow": {"status","target","pendingReview","published","warnings","lastPostAt","lastPostUrl"}, "attention": [...], "notes": "<one-line summary, e.g. '14 schedules tracked (7 active, 2 pending, 1 running, 4 disabled); NewsFlow RUNNING; 24 system jobs hidden'>"}
   status is one of: disabled, active, paused, pending, running. lastRunStatus stays separate (completed/failed/null) — a "failed" last run does not by itself change status.
   Use null (not empty strings) for unknown times. Validate loosely — never fail the whole run over one bad field.
5. `artifact.invoke_action` on slug `mission-control`, action `ingestsnapshot`, args {"snapshot": <the object>}.

## Delivery
Routine runs: end with exactly `📡 snapshot ok` — no chat report. Only write a chat message if something URGENT broke: the ingest failed, a previously-enabled schedule got disabled, or NewsFlow flipped to an error state — then one short Bangla message saying what changed.
