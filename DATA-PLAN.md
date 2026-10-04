# Data Plan

## Context provenance
- `আমি লাইভ দেখতে পারবো কোন কোন টাস্ক পেন্ডিং আছে কোন এজেন্ট কি কাজ করতেছে লাইভ ভিউ` (verbatim build request — user wants live visibility into pending tasks and which agent is doing what)
- Technical brief from owner's agent specifying the ingestSnapshot / getDashboard / resolveAttention contract, snapshot shape, and the Mission Control layout + design system (neurotrace-dashboard / coastal.ai / helios-mission-control research). This is the authoritative spec for this build.
- User context: owner runs multiple cron agents (NewsFlow for 'The AI Brief' Facebook Page, comment agent, learning loops) on a 5-minute cadence and wants a single glanceable wall. No demo cron rows are to be invented — empty state until first real snapshot.

## Tested sources
### Snapshot ingest contract (worker → artifact)
**Used by**: `ingestSnapshot` action (write), `getDashboard` action (read), `resolveAttention` action (mutate latest snapshot attention array)
**Test command**: Contract review against the technical brief; no live worker exists yet to probe. Validation will be exercised post-build by invoking `ingestSnapshot` with a realistic sample snapshot via `artifact.invoke_action`, then `getDashboard`, then `resolveAttention`.
**Sample output**: `getDashboard` returns `{ latest: snapshot|null, history: [≤12 snapshots], serverTime: ISO }`. Snapshot shape: `{ takenAt, crons: [{id,title,cadence,enabled,status,lastRunAt,lastRunStatus,nextRunAt}], newsflow: {status,target,pendingReview,published,warnings,lastPostAt,lastPostUrl}, attention: [{severity,text}], notes }`
**Processing**: Loose zod validation — all snapshot fields optional except a tolerant catch-all; missing optionals default to null/empty. Store each snapshot as a JSON row (takenAt + receivedAt + payload). Retain last 48 rows (delete older on ingest). `getDashboard` orders by receivedAt DESC. Timeline events are derived client-side by diffing consecutive snapshots (cron status flips, run completions/failures, NewsFlow status changes, new attention items) — no extra event table needed.

## Web-search sources
None. The design language (glassmorphic ops dashboards, cyan-on-near-black, JetBrains Mono telemetry) comes from the owner's agent brief, which already distills the open-source references (neurotrace-dashboard, coastal.ai, helios-mission-control). No runtime web fetch is required.

## Agent-task sources
None. No `ctx.agent.spawnTask` needed; the artifact is a pure snapshot viewer. The upstream snapshot worker (owned by the parent agent, every 5 minutes) is outside this artifact.

## Long-term data behavior
- **Refresh policy**: Client polls `getDashboard` every 30s (react-query refetchInterval). Worker pushes via `ingestSnapshot` every 10 minutes (owner-changed from 5m on 2026-10-02). Freshness line shows age of latest snapshot; STALE badge when older than 15 minutes (one full push window plus grace), with a freshness-window bar under the header.
- **Growth**: Snapshots table capped at 48 rows (rolling delete on ingest). History view uses the last 12. Attention items are mutable only on the latest snapshot (resolve = splice from stored JSON).
- **Ordering**: Schedules sorted enabled-first, then by title. History newest-first. Timeline derived newest-first.
- **Time semantics**: `takenAt` is the worker's Asia/Dhaka timestamp (ISO with offset). Relative times ("3m ago", "in 5m") computed against the viewer's now but labeled against Asia/Dhaka; live clock rendered in Asia/Dhaka (UTC+06). Server returns `serverTime` so the client can sanity-check skew.

## Rejected approaches
- **Tried**: Client-side demo/seed cron rows to make the first screen look full
  **Why rejected**: Brief explicitly forbids inventing demo cron data; honest empty state ("Waiting for first snapshot — the worker pushes data every 5 minutes") is the correct product behavior.
- **Tried**: Separate events table written by the worker
  **Why rejected**: Brief specifies diffing consecutive snapshots client-side; keeps the ingest contract minimal and lets the timeline work from already-stored history.
- **Tried**: Light theme / purple-accent dashboard
  **Why rejected**: Owner's design system mandates near-black #050a0f canvas with a single cyan signal; purple gradients are explicitly excluded by the research brief.

## Redesign (2026-10-02, game-HUD rebuild)
- Owner asked for a live game/mission-control HUD ("কে কি কোন কাজ করতেছে" visible live). Deep research at `~/workspace/research_notes/mission-control-game-hud/report.md` (GitHub references: Alice Mission Control orbital agent map, GOD MODE recon dashboard, Sentinel OS, Enceladus MCC, Cockpit HUD) drove the new UI: orbital stage with one node per schedule around a NewsFlow core, corner-bracket HUD panels, radar sweep, scanlines, starfield canvas, boot overlay, severity-coded activity log, SVG systems gauge.
- Data contract unchanged: same `ingestSnapshot` / `getDashboard` / `resolveAttention` actions, same snapshot JSON, 30s polling, honest empty state. Node colors derive only from snapshot fields (status/enabled/lastRunStatus); no new or invented data. (Stale threshold later moved 10m → 15m when the worker cadence changed to 10 minutes.)

## Polish pass (2026-10-02, "আরো ভালো পলিস করো")
- Visual/UX only; data contract untouched. Unique disambiguated node codes (FN1/FN2/…), freshness-window bar, panel header hairlines + ticks, core glow, larger 44px node tap targets, Escape-to-deselect, cyan focus rings, custom scrollbars, shorter boot (skipped under reduced motion), cadence copy 5m → 10m.

## 3D gaming redesign (2026-10-02, "ওয়েবসাইটটা তুমি এমন ভাবে ডিজাইন করো যে মনে হবে যে থ্রিডি একটা গেমিং লুক")
- Owner asked for a true 3D gaming look and for an icon refresh in the same spirit. Design playbook: `~/workspace/research_notes/3d-gaming-mission-control-design-20261002-1557/report.md` (Three.js holographic command-room references — ULTRON ORB UI, HOLO.SYS, FUI WebGL Globe, Stellar Nomad UI style guide; exact scene recipe, bloom values, mobile budgets, icon concepts).
- Implementation: `client/src/OrbitalScene3D.tsx` — vanilla Three.js (bundled `three@0.180.0`, no CDN) scene swapped in for the flat SVG stage: Fresnel-shader NewsFlow core whose rim color follows NewsFlow's own status (RUNNING vs other vs unknown), status-colored icosahedron nodes (emissive + wireframe + holo ring + glow sprite) on two tilted orbit rings, single-draw-call core→node beams with traveling data packets, 4k/1.2k particle starfield, polar grid floor, FogExp2, UnrealBloom (strength 0.65 / radius 0.35 / threshold 0.85, tuned down after the first capture blew out to white) on desktop tier only; mobile tier = sprite glow, DPR ≤1.25, no composer. Camera: fov 45 at (0, 5.2, 10.5), damped OrbitControls with idle auto-rotate; node tap raycasts, selection dollies the camera in 700ms and freezes the orbit (plus a CSS RGB-split flash). World-space HTML labels (code + status) ride on each node; all statuses still derive only from snapshot fields — data contract unchanged.
- The 2D stage stays as a user toggle (3D/2D buttons, persisted per session) and as the automatic fallback when WebGL context creation fails. Optional sound cues (WebAudio blips on select, alert when the failed count rises) sit behind an explicit SND toggle, default off.
- Icon: regenerated per the playbook's "Command Core" concept (dark volumetric sphere, two tilted orbit rings with front/back occlusion, one green node dot).

## Modernization (2026-10-04, "আরো চোখে ভালো + ফাস্ট + আধুনিক")

Design research: `~/workspace/research_notes/mission-control-redesign/report.md`
(nightwire / scifiui / artpass-pro token patterns, epure skeleton+motion
grammar, live-flow-dashboard interaction bar). No data contract change
except one addition below.

- **Tokens**: new semantic set in `theme.css` (`--bg-alt`,
  `--surface-strong`, `--text-muted/--text-faint`, `--accent-2`,
  `--ok/--warn/--danger/--info`, border strengths, glass vars,
  150/300ms motion tokens, `clamp()` fluid scale). Dark HUD canvas kept
  in both color schemes; light mode raises surface opacity for contrast.
- **Layout**: panels moved to CSS grid (`.mc-layout-grid`, areas
  fleet/stage/side ≥1024px, single column on phone).
- **Loading**: shape-matched skeletons (opacity oscillation) replace the
  plain "ESTABLISHING UPLINK" text on first load and in Journal.
- **Status semantics**: `StatusIcon` (check / cross / pause / hollow) and
  `SeverityIcon` (alert-triangle / info) pair icon + label + color
  everywhere a status shows; dots alone no longer carry meaning.
- **Accessibility**: 44px targets (`.mc-touch`) on stage toggles and
  fleet filters, 150/300ms hover/focus micro-animations, all motion
  collapses under `prefers-reduced-motion`, existing keyboard support
  (arrows/Escape, focus rings) preserved.
- **Journal**: new `loadJournal` action + privileged `readJournal`
  contract reads `~/workspace/mission-control/attention.json` and renders
  it as the durable Journal panel; empty states in Fleet / Attention /
  Activity now cross-link to Journal and Activity Log instead of dead-ending.

## 3D timeline upgrade (2026-10-04, "থ্রিডি ভিউয়ে … কোন কাজ কখন হবে")

Research: `~/workspace/research_notes/mission-control-redesign/BUILD-BRIEF-3D-TIMELINE.md`
(+ LIVE-SITES.md, PHOTO-RESEARCH.md). Data contract unchanged — everything
derives from the same snapshot fields (`nextRunAt`, `lastRunAt`,
`lastRunStatus`, `cadence`); no new action, no invented runs. Where a
cadence string can't be parsed, the countdown period falls back to the
last→next run span, and the timeline simply shows the one known next run.

- **3D stage**: per-node countdown arc (fills as the next run approaches,
  DUE at full), status shapes (active sphere / paused cube / failed
  octahedron + pulsing ring / disabled icosahedron) on top of color +
  text labels, core→node beams flare on each snapshot ingest, no
  auto-orbit (drag only; 600ms ease-out focus tween), merged ring-guide
  geometry, label passes throttled to ~5Hz, adaptive quality (bloom →
  pixel ratio → 2D fallback on sustained <45fps), 2D stage is the
  Suspense fallback while three.js loads. 2D nodes get the same
  countdown ring as an SVG arc.
- **Timeline (24H) view**: third stage view (3D / 2D / 24H toggle, keys
  1/2/3, persisted per session). Desktop: 24h strip — one row per
  schedule sorted by next run, 1h gridlines, glowing NOW beam, run
  blocks projected from nextRunAt + parsed cadence, next-run countdown
  pill ("in 2h 14m"), last-run marker (red outline when failed), cadence
  in plain words ("Every 6 hours", raw string only on hover tooltip).
  Phone: chronological upcoming-runs list. Click selects the unit
  everywhere (stage + detail card); hover cross-highlights fleet /
  stage / timeline; a selection dims the other timeline rows to 30%.

## Pending + Running states (2026-10-04, "কোনটা pending আছে")

Brief: `~/workspace/research_notes/mission-control-redesign/BUILD-BRIEF-PENDING-RUNNING.md`.
The snapshot worker now derives two first-class per-cron states from
the scheduler's queued/running run counts and sends them as
`status: "pending"` (a run is queued, waiting to execute) and
`status: "running"` (a run is executing right now). Full status enum:
disabled, active, paused, pending, running; `lastRunStatus`
(completed/failed/skipped) stays separate.

- **Contract**: `ingestSnapshot`'s cron schema accepts the two new
  status values (additive only; all other fields unchanged, 10-min
  cadence kept). No migration — snapshots are stored as JSON payloads.
- **Rendering — shape + color + text label, never color alone**
  (WCAG-AA): pending = cyan/teal (#22d3ee) clock icon + "PENDING"
  label, dashed/squarish node in 2D, torus ring-halo geometry in 3D,
  pulsing ring, countdown ring nearly full; running = bright cyan
  (#00f0ff) play icon + "RUNNING" label, dodecahedron in 3D,
  expanding pulse rings + fast heartbeat glow, indeterminate
  spinning ring instead of a countdown ("● LIVE" in 3D labels).
- **Surfaces**: PENDING and RUNNING filter chips (ALL, ACTIVE,
  PENDING, RUNNING, ISSUES, STANDBY) with live counts; header status
  strip shows "N PENDING · N RUNNING" when non-zero; fleet list rows
  carry icon + label + queued/running copy; 24H timeline renders
  pending as a dashed/outlined block with its countdown ("PENDING
  in 9m") and running as a solid bright block pinned at the NOW line
  labeled "NOW · RUNNING" (phone list shows the same labels);
  detail card shows "QUEUED — runs next" / "RUNNING — executing now
  (started ~Xm ago from lastRunAt)"; overview panel counts both.
- **Backward compatibility**: older snapshots without pending/running
  (only active/paused/disabled) render exactly as before; an
  unknown/missing status falls back to active instead of breaking.
  Live states outrank the last-run outcome for the primary badge (a
  unit running now is RUNNING even if its previous run failed), while
  the detail card still shows the last result separately.

## Live feel (2026-10-04, Pass B — "data actually moves")

Brief: `~/workspace/research_notes/mission-control-redesign/BUILD-BRIEF-PASS-B.md`.
Client-only; no contract change, no invented data — every motion
derives from the real snapshot + the real clock.

- **Ticking countdowns**: the shared `nowMs` clock ticks every 200ms
  (at most one text update per 200ms, no per-frame thrash); countdown
  labels are second-granular below a minute so the final minute is
  visibly counting. Tabular numerals (`tabular-nums`) on countdowns,
  the Dhaka clock, and every tweened counter.
- **"Updated Xs ago"**: live-ages every tick ("updated 1m 12s ago");
  on each ingest the freshness line resets to "just now" with a soft
  glow pulse (`mc-updated-pulse`), a cyan light sweep crosses the
  status bar (`mc-ingest-flash`), and the orbital core/beam pulse
  keeps riding the same snapshot key. Routine ingests get no toast.
- **Tweened counters**: header ACTIVE/PENDING/RUNNING/STANDBY/ALERT,
  overview counts, gauge % + SYS %, NewsFlow stats, and fleet filter
  chips tween over ~600ms ease-out when a snapshot changes them
  (`TweenedNumber`); instant under `prefers-reduced-motion`.
- **Status-flip toasts**: cross-snapshot diff of per-unit node states;
  a small `role="status"` toast (max 1, auto-dismiss ~6s, dismissible,
  tap to inspect the unit) appears only for newly-failed units and
  queued→running starts — never for routine ingests, never for the
  first snapshot of a session.
- **Stale badge**: snapshot older than 15 min shows an amber
  "STALE — LAST UPDATE Xm AGO" badge (freshness line and freshness
  bar share the amber) and clears automatically on the next ingest.
- **Skeletons**: first load only — the 30s poll never re-skeletons;
  snapshot changes animate via tweened numbers instead.

## Power features (2026-10-04, Pass C)

Client-only; no contract change, no invented data — every palette
result, card action, and shortcut target resolves to fields of the
same snapshots (latest + last 12 history) the wall already loads.

- **Command palette (⌘K/Ctrl+K, header search button)**: fuzzy search
  over schedules (title/id/code/status), attention items, view/jump
  targets, session filter toggles, CSV exports (activity log, per-unit
  runs), task-ID copy, and time travel. Static ranking only — failed,
  running, pending, paused, active, disabled, alphabetical tie-break —
  plus a 30-second "recently viewed" boost tracked in session state.
  Navigation & inspection only: nothing in the palette mutates backend
  state. Highlighting a task previews its status badge, cadence, next
  run, a recent-runs sparkline, and its last activity-log lines (all
  from history). ⌘+Enter / long-press pins a task to a session tray.
- **Shortcuts**: 1/2/3 views (as before), ? help overlay, F cycles the
  fleet filter (now including a FAILED filter), Esc unwinds one layer
  (help → palette → time travel → selection). Desktop hint bar under
  the header; "?" button serves small screens.
- **Narrative attention cards**: failures, correlated failures, and
  disabled-but-scheduled anomalies become WHAT → WHY → ACTION cards.
  WHY lines are computed only from history (failure streaks across
  distinct runs, last success, failures within 2 min of another unit);
  no computable why → no why line. Unmatched attention items stay a
  quiet list with the existing server-backed Dismiss; cards dismiss
  per session only.
- **Time travel**: palette offers "Timeline: N minutes ago" only when
  a real history snapshot answers it; the wall then renders that
  snapshot read-only under a TIME TRAVEL banner (live ingest watch and
  toasts keep tracking the newest snapshot underneath).
- **Mobile grammar**: palette is full-screen, filters are a sticky
  horizontal scroll-snap carousel of 44px chips under the measured
  sticky header, timeline keeps native scrolling, 3D touch stays
  OrbitControls defaults (drag orbit, pinch zoom, tap select).

## Reliability + Improvement centers (2026-10-04, Phase 7)

- **Reliability Center** (`getReliability` action, read-only): derives
  failed runs (distinct `lastRunAt` failures, failure frequency,
  consecutive streaks), overdue schedules (latest snapshot, `now -
  lastRunAt > 2×` cadence-derived interval; skipped when `lastRunAt`
  or a parseable cadence is missing), and failed→completed recoveries
  (both run timestamps) from the stored snapshot history (≤48 rows).
  Filter chips All / Failed / Overdue / Recovered match the fleet
  filter UX; empty states state plainly when history is thin. No new
  write surface; `ingestSnapshot` / `getDashboard` contracts and the
  `takenAt` dedup key are unchanged.
- **Improvement Center** (`improvements` table, migration 0006):
  lifecycle proposed → testing → verified plus rejected / regressed /
  rolled-back via `proposeImprovement`, `updateImprovementStatus`,
  and `listImprovements`. Terminal transitions require a result and a
  verification note (enforced server-side); credential-like values are
  rejected so secrets are never stored. Seeded on first read (when the
  table is empty) with exactly the three real 2026-10-04 project
  entries: P1-1 error boundary, P1-2 idempotent ingest, and Phase 5
  observability — all verified, with their real problems, discoveries,
  solutions, and results.
- **Navigation**: Operations / Reliability / Improvements tabs (keys
  4/5, Esc returns to Operations), also reachable from the command
  palette; existing 3D/2D/24H views, filters, attention, and health
  strip are untouched.

## Audit hardening (2026-10-04, Phases 3–6)

- **Phase 3 — P1 fixes.** (1) Localized error boundaries around the
  stage and fleet regions with Retry (no full-app crash on a render
  failure). (2) Idempotent snapshot ingestion: malformed records are
  repaired or skipped during normalization; snapshot identity is
  `takenAt` (unique constraint + upsert refreshes the existing row,
  migration 0004 collapses pre-existing duplicates by `takenAt`).
  Independently verified 2026-10-04: the same payload pushed twice
  returned the same row id (291), the probe appeared exactly once, and
  zero duplicate `takenAt` values existed in the 12-row history window.
- **Phases 5/6 — observability / health model.** `ingest_meta`
  watermark table plus `ingestHealth.lastIngestAt` /
  `ingestHealth.ageSec` on `getDashboard`; `dataQuality` (`ok` /
  `degraded`) with `degradedRowId`; distinct `DATA DEGRADED` and
  `JOURNAL UNAVAILABLE` UI states; attention-dismissal audit trail;
  health strip for INGEST / DATA / JOURNAL / LINK. Data contracts
  unchanged.

## Performance hardening (2026-10-04, Phase 8)

- Client-only. The 200ms clock/freshness tick is isolated into tiny
  components (`DhakaClock`, `FreshnessText`, `FreshnessTrack`,
  `useNowMs`); 2D orbit motion and parallax write transforms directly
  to DOM refs via `requestAnimationFrame` instead of React state;
  Three.js scene re-sync is gated by a structural key (snapshot /
  selection / core-state changes). Ambient animation stays on
  transform/opacity/canvas paths. Also fixed a reliability-logic nit:
  disabled schedules are excluded from the overdue calculation.

## Premium 3D pass (2026-10-04, Pass 3D-1)

- Depth system (six layers/tokens), quiet grid, atmospheric glow,
  particles, fog/vignette; physical glass/metal card language;
  restrained bloom (later tuned 0.32 → 0.18 in the UX pass); AI core
  states ONLINE / THINKING / EXECUTING / WAITING / ERROR / LEARNING
  driven by real signals. A distinct non-operational `NO SIGNAL` state
  (dim, desaturated, static) shows before the first real snapshot and
  is never treated as an asserted operational state. Mobile uses a
  lighter render tier / 2D fallback. Rendered visual QA from the
  builder environment was unavailable (organization policy blocks the
  artifact URL in the managed browser).

## Full UI/UX redesign (2026-10-04)

- Per the owner's 30-point brief + reference mockup + 13-page UI
  materials catalog. Header with MISSION CONTROL branding, LIVE pill,
  real animated counters, search, notifications/help/avatar, Dhaka
  clock. Desktop icon rail (Ops / Activity / 24H / Reliability /
  Improve / Fleet / Logs). System health strip (CORE + INGEST pills,
  DATA / JOURNAL / LINK states). Hero 3D agent universe with dynamic
  real schedule nodes on three orbital layers. Views: 3D, 2D, 24H,
  Reliability, Improvement, plus a new ACTIVITY stream. Current-task
  strip, failed-agent alert, Next Up countdowns, live activity rail,
  agent detail (desktop drawer / mobile bottom sheet). Fleet demoted
  to a full-width schedule deck with search and filters
  ALL / ACTIVE / RUNNING / PENDING / PAUSED / FAILED / DISABLED.
  Mobile-first at 390px with no horizontal overflow; WCAG-AA contrast,
  visible focus, keyboard support, 44px touch targets,
  `prefers-reduced-motion` preserved.
- **Data honesty held:** the mockup's invented figures (success rates,
  execution counts, avg runtimes) were not implemented; no Run/Pause/
  Settings actions exist where the backend exposes none. Backend,
  actions, schema, and data flow untouched. `getDashboard` and
  `getReliability` re-verified working after the redesign; full
  interaction-level regression was not independently confirmable from
  the builder environment.

## Evolving system (2026-10-04)

- Infrastructure-only pass; the default dashboard appearance is
  unchanged. New code lives in `client/src/evolving.tsx` plus small
  hooks in `App.tsx` / `OrbitalScene3D.tsx`.
- **Performance monitor** (`perfMonitor`, `measureAction`):
  page-load / DOM-ready times, frame rate, 3D scene FPS, JS heap where
  exposed, long tasks (>50ms), failed requests, JS errors, per-action
  latency, render-frequency counters. Surfaced in a discreet
  Diagnostics view (Ctrl+Shift+D or the command palette) — real
  measured values only, no synthetic data.
- **Adaptive 3D tiers**: PERFORMANCE / BALANCED / HIGH / ULTRA
  (particle count, bloom on/off + strength, pixel-ratio cap,
  connection animation, lighting basic→advanced). Auto-selected from
  device capability plus a rolling-FPS adjustment; a manual override
  is persisted locally. The pre-existing sustained-low-FPS 2D
  fallback is untouched.
- **Modular 3D engine**: six independently toggleable modules —
  orbital layers, particle fields, data streams/beams, holographic
  rings, energy pulses, background grid.
- **Feature flags**: `ENABLE_3D_PARTICLES`, `ENABLE_DYNAMIC_ORBITS`,
  `ENABLE_ADVANCED_LIGHTING`, `ENABLE_ADAPTIVE_RENDERING`.
- **Design versioning + rollback**: the visual configuration is a
  serializable `VisualConfig` (`VISUAL_CONFIG_V1` → `VISUAL_CONFIG_V1.1`);
  applying a change first preserves the current config as the rollback
  target; rollback restores it. Never overwrites the stable config
  without keeping a rollback.
- **UX auditor (advisory only)**: evaluates FPS trends, failed
  actions, long tasks, re-render hotspots, responsiveness,
  accessibility, complexity, and consistency; emits plain-language
  suggestions labeled machine-generated. It never modifies production
  code — every suggestion ends with "No change was made automatically."
- Builder-attested; the pass's own content critique noted only
  partial confirmation of every evolving-system internal (truncated
  sources), so runtime behavior of diagnostics/tiers/auditor awaits
  the owner's in-browser verification.
