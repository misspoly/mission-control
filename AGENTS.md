# Building this web artifact

This directory is a web artifact — a TypeScript space: a React client in
`client/`, server actions in `server/src/actions.ts`, the schema in
`server/src/schema.ts`, and Drizzle SQL migrations in `drizzle/` (see
`space.json` for its runtime and slug).

Build, audit, and ship it only through the web-artifact builder interface your
session provides — the exact plan → build → audit → submit flow, how to edit or
inspect an existing artifact, and the schema/migration commands are all in your
builder instructions and the artifacts skill, which stay current if that
interface ever changes. Do not hand-edit the
built bundle under `.space-build/`, and do not `bun run build`: neither
publishes the artifact.

If you are not the builder subagent (for example, the main assistant landed
here), do not build from this directory. List the existing artifacts and
request a change by describing the edit — that spawns a builder to do the
work.

## This artifact's data

This artifact's data lives in `app.db`, managed by the app: read it with the
artifact inspect data operations and change it through the app's own actions
(`artifact.invoke_action`) or an artifact edit, never by running sqlite or
scripts against the file.

Actions:
- `ingestSnapshot` — worker pushes a snapshot (keeps last 48).
- `getDashboard` — latest + last 12 snapshots for the wall.
- `resolveAttention` — dismiss an item on the latest snapshot only.
- `loadJournal` — reads durable entries from
  `~/workspace/mission-control/attention.json` via the privileged
  `readJournal` contract (`server/src/privileged.ts`). Returns
  `{ entries: [{severity, text}], source }`; missing/unreadable file
  yields an empty list, never an error. The client polls it every 60s
  and renders it in the Journal panel (right rail, below Attention).

## Design tokens & layout

`client/src/theme.css` is the token source: `--bg/--bg-alt`,
`--surface/--surface-strong`, `--text/--text-muted/--text-faint`,
`--accent/--accent-2`, `--ok/--warn/--danger/--info`,
`--border/--border-strong/--border-soft`, glass vars
(`--glass-blur/--glass-alpha/--glass-highlight`), motion tokens
(`--motion-fast` 150ms / `--motion-base` 300ms), and a fluid type scale
(`--step-*` via `clamp()`; `.mc-stat-hero/.mc-stat-mid/.mc-stat-sub`).
Layout is CSS grid: `.mc-layout-grid` with named areas
`fleet / stage / side` at ≥1024px, single column below. The stage has
three views (3D orbit / 2D orbit / 24H timeline; keys 1/2/3, persisted
per session) with countdown arcs on nodes in both orbit views; all of
it derives from snapshot fields only. Status is always
icon + label + color (`.mc-status*`, `StatusIcon`/`SeverityIcon` in
`App.tsx`), never color alone. Primary controls meet 44px targets
(`.mc-touch`); hover/focus micro-animations run 150/300ms and collapse
under `prefers-reduced-motion`.
