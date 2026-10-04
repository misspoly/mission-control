import {
Component,
lazy,
Suspense,
useEffect,
useMemo,
useRef,
useState,
type CSSProperties,
type ErrorInfo,
type KeyboardEvent as ReactKeyboardEvent,
type ReactNode,
type TouchEvent as ReactTouchEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { useNowMs } from "./useNow";
import type { SceneNode } from "./OrbitalScene3D";
import { ImprovementCenter, ReliabilityCenter } from "./Centers";
import {
DiagnosticsPanel,
measureAction,
perfMonitor,
useVisualConfig,
} from "./evolving";

// The WebGL stage is code-split: the flat 2D stage renders instantly and
// the 3D scene swaps in as soon as its chunk (three.js) arrives.
const OrbitalScene3D = lazy(() => import("./OrbitalScene3D"));

type Dashboard = ApiResponse<typeof api, "getDashboard">;
type Snapshot = {
  takenAt?: string;
  crons?: Array<{
    id: string;
    title?: string;
    cadence?: string | null;
    enabled?: boolean;
    status?: "active" | "paused" | "disabled" | "pending" | "running" | null;
    lastRunAt?: string | null;
    lastRunStatus?: "completed" | "failed" | "skipped" | null;
    nextRunAt?: string | null;
  }>;
  newsflow?: {
    status?: string;
    target?: string | null;
    pendingReview?: number | null;
    published?: number | null;
    warnings?: number | null;
    lastPostAt?: string | null;
    lastPostUrl?: string | null;
  } | null;
  attention?: Array<{ severity: "action" | "warn" | "info"; text: string }>;
  notes?: string | null;
};

type CronItem = NonNullable<Snapshot["crons"]>[number];

type ViewMode = "3d" | "2d" | "timeline" | "activity";
type CenterView = "ops" | "reliability" | "improvements";

/* ---------- error boundary ---------- */

/**
 * Catches render errors in a stage/fleet region so one bad snapshot can
 * never white-screen the whole wall. Falls back to a plain-language
 * panel with a Retry button that re-attempts the render.
 */
class MissionErrorBoundary extends Component<
  { label: string; children: ReactNode },
  { hasError: boolean }
> {
  override state: { hasError: boolean } = { hasError: false };

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the failure visible in the console for diagnosis; the UI
    // falls back to the panel below instead of a blank screen.
    console.error(`[MissionControl] ${this.props.label} render failed:`, error, info.componentStack);
  }

  private handleRetry = (): void => {
    this.setState({ hasError: false });
  };

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="mc-glass relative p-6 text-center"
          style={{ minHeight: 160 }}
        >
          <p className="font-mono text-sm text-[#e8a84d]">
            {this.props.label} hit a snag
          </p>
          <p className="mx-auto mt-2 max-w-sm font-mono text-xs leading-relaxed text-[#8a9bb0]">
            This panel ran into unexpected data and paused itself so the
            rest of the dashboard keeps working.
          </p>
          <button
            type="button"
            aria-label={`Retry ${this.props.label}`}
            onClick={this.handleRetry}
            className="mt-4 rounded border border-[#5cc6da]/40 bg-[#5cc6da]/10 px-4 py-2 font-mono text-xs tracking-widest text-[#5cc6da]"
          >
            RETRY
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function asSnapshot(v: unknown): Snapshot | null {
  if (typeof v !== "object" || v === null) return null;
  const raw = v as Record<string, unknown>;
  // Defensive normalization: one malformed cron entry must never kill
  // the whole render. Skip entries without a usable id, coerce the
  // optional fields to their expected shapes, and drop junk entries.
  const rawCrons = Array.isArray(raw.crons) ? raw.crons : [];
  const crons: NonNullable<Snapshot["crons"]> = [];
  for (const entry of rawCrons) {
    if (typeof entry !== "object" || entry === null) continue;
    const c = entry as Record<string, unknown>;
    if (typeof c.id !== "string" || c.id.trim() === "") continue;
    const status =
      c.status === "active" ||
      c.status === "paused" ||
      c.status === "disabled" ||
      c.status === "pending" ||
      c.status === "running"
        ? c.status
        : null;
    const lastRunStatus =
      c.lastRunStatus === "completed" ||
      c.lastRunStatus === "failed" ||
      c.lastRunStatus === "skipped"
        ? c.lastRunStatus
        : null;
    crons.push({
      id: c.id,
      title: typeof c.title === "string" ? c.title : undefined,
      cadence: typeof c.cadence === "string" ? c.cadence : null,
      enabled: typeof c.enabled === "boolean" ? c.enabled : undefined,
      status,
      lastRunAt: typeof c.lastRunAt === "string" ? c.lastRunAt : null,
      lastRunStatus,
      nextRunAt: typeof c.nextRunAt === "string" ? c.nextRunAt : null,
    });
  }
  const rawNf =
    typeof raw.newsflow === "object" && raw.newsflow !== null
      ? (raw.newsflow as Record<string, unknown>)
      : null;
  const newsflow: Snapshot["newsflow"] = rawNf
    ? {
        status: typeof rawNf.status === "string" ? rawNf.status : undefined,
        target: typeof rawNf.target === "string" ? rawNf.target : null,
        pendingReview:
          typeof rawNf.pendingReview === "number" ? rawNf.pendingReview : null,
        published: typeof rawNf.published === "number" ? rawNf.published : null,
        warnings: typeof rawNf.warnings === "number" ? rawNf.warnings : null,
        lastPostAt: typeof rawNf.lastPostAt === "string" ? rawNf.lastPostAt : null,
        lastPostUrl: typeof rawNf.lastPostUrl === "string" ? rawNf.lastPostUrl : null,
      }
    : null;
  const rawAtt = Array.isArray(raw.attention) ? raw.attention : [];
  const attention: NonNullable<Snapshot["attention"]> = [];
  for (const entry of rawAtt) {
    if (typeof entry !== "object" || entry === null) continue;
    const a = entry as Record<string, unknown>;
    if (typeof a.text !== "string") continue;
    attention.push({
      severity:
        a.severity === "action" || a.severity === "warn" || a.severity === "info"
          ? a.severity
          : "info",
      text: a.text,
    });
  }
  return {
    takenAt: typeof raw.takenAt === "string" ? raw.takenAt : undefined,
    crons,
    newsflow,
    attention,
    notes: typeof raw.notes === "string" ? raw.notes : null,
  };
}

function rel(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = t - now;
  const abs = Math.abs(diff);
  const sec = Math.round(abs / 1000);
  if (sec < 10) return diff <= 0 ? "just now" : "in <10s";
  if (sec < 60) return diff <= 0 ? `${sec}s ago` : `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return diff <= 0 ? `${min}m ago` : `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return diff <= 0 ? `${hr}h ago` : `in ${hr}h`;
  const d = Math.round(hr / 24);
  return diff <= 0 ? `${d}d ago` : `in ${d}d`;
}

/** Stable dismissal identity (severity + text hash) — mirrors server. */
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

function dhakaTime(d: Date): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dhaka",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}

function dhakaStamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dhaka",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 16).replace("T", " ");
  }
}

/* ---------- cadence & countdown ---------- */

/** Parse a cadence string ("every 10m", "hourly", "daily 14:15") into a period. */
function cadenceIntervalMs(cadence: string | null | undefined): number | null {
  if (!cadence) return null;
  const c = cadence.trim().toLowerCase();
  if (c === "hourly") return 3_600_000;
  if (c === "daily" || c.startsWith("daily")) return 86_400_000;
  if (c === "weekly" || c.startsWith("weekly")) return 604_800_000;
  const m = /^every\s+(\d+)\s*(m|min|mins|h|hr|hrs|d|day|days)\b/.exec(c);
  if (m) {
    const n = Number(m[1]);
    const u = m[2] ?? "m";
    if (u.startsWith("h")) return n * 3_600_000;
    if (u.startsWith("d")) return n * 86_400_000;
    return n * 60_000;
  }
  return null;
}

/** Plain-words cadence for humans ("Every 6 hours", "Daily at 14:15"). */
function cadencePlain(cadence: string | null | undefined): string {
  if (!cadence) return "On demand";
  const c = cadence.trim().toLowerCase();
  if (c === "hourly") return "Every hour";
  const daily = /^daily\s+(\d{1,2}:\d{2})/.exec(c);
  if (daily) return `Daily at ${daily[1]}`;
  if (c === "daily") return "Daily";
  if (c === "weekly") return "Weekly";
  const m = /^every\s+(\d+)\s*(m|min|mins|h|hr|hrs|d|day|days)\b/.exec(c);
  if (m) {
    const n = Number(m[1]);
    const u = m[2] ?? "m";
    const unit = u.startsWith("h")
      ? n === 1
        ? "hour"
        : "hours"
      : u.startsWith("d")
        ? n === 1
          ? "day"
          : "days"
        : n === 1
          ? "minute"
          : "minutes";
    return `Every ${n} ${unit}`;
  }
  return cadence;
}

function toMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "in 2h 14m" / "in 45m" / "due now" for a future run time. */
function countdownLabel(targetMs: number | null, nowMs: number): string {
  if (targetMs == null) return "—";
  const diff = targetMs - nowMs;
  if (diff <= 0) return "due now";
  const totalMin = Math.floor(diff / 60000);
  if (totalMin < 1) return "in <1m";
  if (totalMin < 60) return `in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m ? `in ${h}h ${String(m).padStart(2, "0")}m` : `in ${h}h`;
  const d = Math.floor(h / 24);
  return `in ${d}d ${h % 24}h`;
}

/**
 * Countdown-arc fraction (0 = just ran, 1 = due). Period from cadence,
 * falling back to the last→next span. Null when unknowable.
 */
function nextRunFrac(c: CronItem, nowMs: number): number | null {
  const next = toMs(c.nextRunAt);
  if (next == null) return null;
  if (next <= nowMs) return 1;
  let period = cadenceIntervalMs(c.cadence);
  const last = toMs(c.lastRunAt);
  if (!period && last != null && next > last) period = next - last;
  if (!period || period <= 0) return null;
  return Math.max(0, Math.min(1, 1 - (next - nowMs) / period));
}

/** Dhaka HH:MM for timeline pills. */
function dhakaClock(ms: number): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Dhaka",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

function dhakaDayKey(ms: number): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Dhaka",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 10);
  }
}

/* ---------- node state ---------- */

type NodeState = "active" | "paused" | "disabled" | "failed" | "pending" | "running";

/* ---------- AI core states (PASS 1) ----------
   Truthful mapping only — never decorative. Priority is top-down:
   ERROR > LEARNING > EXECUTING > THINKING > WAITING > ONLINE.
   - ERROR:     NewsFlow status signals failure (contains ERROR/FAIL/
                FAILURE or the paused-by-failure marker). Warnings alone
                never produce ERROR; they surface in Attention instead.
   - LEARNING:  an Improvement is in "testing" (verification activity
                is genuinely in progress on the Improvement Center).
   - EXECUTING: at least one schedule is currently "running".
   - THINKING:  at least one schedule is "pending" (queued work exists).
   - WAITING:   fleet exists and at least one unit is active/idle —
                the system is on but no work is queued or running.
   - ONLINE:    default when a snapshot is present but none of the
                above signals fire (e.g. empty/standby fleet).
   NO SIGNAL is NOT a seventh state: before the first snapshot exists
   there is no signal to derive a state from, and asserting ONLINE
   would be a lie. It renders a separate non-operational presentation
   (dim, desaturated, static — no pulse) in all three core renderings
   (2D core, 3D core tint, health-strip chip) until data lands.
   The label is always shown as text (icon + word + colour), and the
   core button carries an aria-label naming the state for screen readers. */
type CoreState = "ONLINE" | "THINKING" | "EXECUTING" | "WAITING" | "ERROR" | "LEARNING";
type CoreVisual = CoreState | "NO_SIGNAL";

const CORE_META: Record<
  CoreVisual,
  { color: string; bg: string; border: string; cls: string; desc: string }
> = {
  ONLINE: { color: "#5cc6da", bg: "rgba(92,198,218,0.08)", border: "rgba(92,198,218,0.28)", cls: "mc-core-online", desc: "Core online — systems nominal" },
  THINKING: { color: "#8ec9dc", bg: "rgba(142,201,220,0.08)", border: "rgba(142,201,220,0.30)", cls: "mc-core-thinking", desc: "Core thinking — queued work is waiting to run" },
  EXECUTING: { color: "#4ecf8f", bg: "rgba(78,207,143,0.08)", border: "rgba(78,207,143,0.30)", cls: "mc-core-executing", desc: "Core executing — a schedule is running now" },
  WAITING: { color: "#8aa8c4", bg: "rgba(138,168,196,0.06)", border: "rgba(138,168,196,0.24)", cls: "mc-core-waiting", desc: "Core waiting — idle but active, no queued work" },
  ERROR: { color: "#e86a7c", bg: "rgba(232,106,124,0.08)", border: "rgba(232,106,124,0.32)", cls: "mc-core-error", desc: "Core error — NewsFlow needs attention" },
  LEARNING: { color: "#b3a3d8", bg: "rgba(179,163,216,0.08)", border: "rgba(179,163,216,0.30)", cls: "mc-core-learning", desc: "Core learning — improvement verification in progress" },
  NO_SIGNAL: { color: "#7d8ea3", bg: "rgba(125,142,163,0.07)", border: "rgba(125,142,163,0.30)", cls: "mc-core-nosignal", desc: "No signal — waiting for first snapshot" },
};

function deriveCoreState(args: {
  newsflowStatus: string | undefined;
  newsflowWarnings: number | null | undefined;
  crons: CronItem[];
  hasLearning: boolean;
  hasSnapshot: boolean;
}): CoreVisual {
  // No snapshot yet = no signal at all. Never assert an operational
  // state without data; render the non-operational NO SIGNAL view.
  if (!args.hasSnapshot) return "NO_SIGNAL";
  const nf = (args.newsflowStatus ?? "").toUpperCase();
  const nfFailed =
    nf.includes("ERROR") ||
    nf.includes("FAIL") ||
    nf.includes("PAUSED-BY-FAILURE") ||
    nf.includes("PAUSED_BY_FAILURE");
  if (nfFailed) return "ERROR";
  if (args.hasLearning) return "LEARNING";
  const hasRunning = args.crons.some((c) => c.status === "running");
  if (hasRunning) return "EXECUTING";
  const hasPending = args.crons.some((c) => c.status === "pending");
  if (hasPending) return "THINKING";
  const hasActive = args.crons.some(
    (c) => c.status === "active" || (c.status == null && c.enabled === true),
  );
  if (args.crons.length > 0 && hasActive) return "WAITING";
  return "ONLINE";
}

function nodeState(c: CronItem): NodeState {
  // First-class live states from the scheduler (queued / executing)
  // outrank the last-run outcome: a unit that is running right now is
  // RUNNING even if its previous run failed.
  if (c.status === "running") return "running";
  if (c.status === "pending") return "pending";
  if (c.lastRunStatus === "failed") return "failed";
  if (c.status === "paused") return "paused";
  if (c.enabled === true || c.status === "active") return "active";
  // Backward compat: unknown/missing status on older snapshots must
  // never break rendering — fall back to active when the worker left
  // the unit enabled, disabled otherwise (pre-pending/running rows
  // render exactly as before).
  if (c.status != null && c.status !== "disabled") return "active";
  return "disabled";
}

const STATE_COLOR: Record<NodeState, string> = {
  active: "#4ecf8f",
  paused: "#e8a84d",
  disabled: "#6b7c92",
  failed: "#e86a7c",
  pending: "#6fc3d8",
  running: "#5cc6da",
};

const STATE_LABEL: Record<NodeState, string> = {
  active: "ACTIVE",
  paused: "PAUSED",
  disabled: "DISABLED",
  failed: "FAILED",
  pending: "PENDING",
  running: "RUNNING",
};

function baseCode(c: CronItem): string {
  const words = (c.title ?? c.id)
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const first = words[0];
  const second = words[1];
  if (first && second) return ((first[0] ?? "") + (second[0] ?? "")).toUpperCase();
  if (first) return first.slice(0, 2).toUpperCase();
  return c.id.slice(0, 2).toUpperCase() || "??";
}

/**
 * Short node codes, disambiguated: when several schedules share initials
 * (e.g. five "Facebook news post" slots), every duplicate gets a numeric
 * suffix (FN1, FN2, …) assigned in title order so each node is unique.
 */
function buildCodeMap(crons: CronItem[]): Map<string, string> {
  const ordered = [...crons].sort((a, b) =>
    (a.title ?? a.id).localeCompare(b.title ?? b.id),
  );
  const totals = new Map<string, number>();
  for (const c of ordered) {
    const base = baseCode(c);
    totals.set(base, (totals.get(base) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const map = new Map<string, string>();
  for (const c of ordered) {
    const base = baseCode(c);
    if ((totals.get(base) ?? 0) > 1) {
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      map.set(c.id, `${base}${n}`);
    } else {
      map.set(c.id, base);
    }
  }
  return map;
}

function StatusIcon({ state }: { state: NodeState }) {
  // Icon + label semantics: never color alone. Check = ok, triangle = warn,
  // cross = failed, pause bars = paused, hollow = disabled, clock = pending
  // (queued, waiting), play-pulse = running (executing now).
  if (state === "active")
    return (
      <span className="mc-status-icon" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5.5L4.2 7.5L8 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    );
  if (state === "failed")
    return (
      <span className="mc-status-icon" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2.5 2.5L7.5 7.5M7.5 2.5L2.5 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </span>
    );
  if (state === "paused")
    return (
      <span className="mc-status-icon" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3.5 2.5V7.5M6.5 2.5V7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      </span>
    );
  if (state === "pending")
    return (
      <span className="mc-status-icon" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="3.4" stroke="currentColor" strokeWidth="1.3" /><path d="M5 3.2V5.2L6.6 6.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    );
  if (state === "running")
    return (
      <span className="mc-status-icon" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3.4 2.6L7.4 5L3.4 7.4V2.6Z" fill="currentColor" /></svg>
      </span>
    );
  return (
    <span className="mc-status-icon" aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="2.6" stroke="currentColor" strokeWidth="1.3" /></svg>
    </span>
  );
}

function SeverityIcon({ severity }: { severity: "action" | "warn" | "info" }) {
  if (severity === "action")
    return (
      <span className="mc-status-icon" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1.5L9 8.5H1L5 1.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M5 4V6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="5" cy="7.3" r="0.7" fill="currentColor" /></svg>
      </span>
    );
  if (severity === "warn")
    return (
      <span className="mc-status-icon" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M5 1.5L9 8.5H1L5 1.5Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /><path d="M5 4V6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
      </span>
    );
  return (
    <span className="mc-status-icon" aria-hidden="true">
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><circle cx="5" cy="5" r="3.4" stroke="currentColor" strokeWidth="1.3" /><path d="M5 4.4V7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /><circle cx="5" cy="2.9" r="0.7" fill="currentColor" /></svg>
    </span>
  );
}

function statusBadge(c: CronItem) {
  const st = nodeState(c);
  const color = STATE_COLOR[st];
  const label =
    st === "failed"
      ? "LAST RUN FAILED"
      : st === "pending"
        ? "PENDING — QUEUED"
        : st === "running"
          ? "RUNNING — LIVE"
          : STATE_LABEL[st];
  return (
    <span
      className="mc-chip-cut inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] tracking-widest"
      style={{ borderColor: `${color}55`, background: `${color}14`, color }}
    >
      <StatusIcon state={st} />
      {label}
    </span>
  );
}

function runDot(s: string | null | undefined) {
  if (s === "completed")
    return (
      <span className="inline-flex items-center gap-1.5" title="completed">
        <span className="inline-block h-2 w-2 rounded-full bg-[#4ecf8f] shadow-[0_0_6px_#4ecf8f]" aria-hidden />
        <span className="sr-only">completed</span>
      </span>
    );
  if (s === "failed")
    return (
      <span className="inline-flex items-center gap-1.5" title="failed">
        <span className="inline-block h-2 w-2 rounded-full bg-[#e86a7c] shadow-[0_0_6px_#e86a7c]" aria-hidden />
        <span className="sr-only">failed</span>
      </span>
    );
  if (s === "skipped")
    return (
      <span className="inline-flex items-center gap-1.5" title="skipped">
        <span className="inline-block h-2 w-2 rounded-full bg-[#e8a84d]" aria-hidden />
        <span className="sr-only">skipped</span>
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5" title="no run yet">
      <span className="inline-block h-2 w-2 rounded-full bg-[#3a4a5f]" aria-hidden />
      <span className="sr-only">no run yet</span>
    </span>
  );
}

/* ---------- timeline ---------- */

type TimelineEvent = {
  key: string;
  at: string;
  kind: "run-ok" | "run-fail" | "status" | "newsflow" | "attention";
  text: string;
};

const KIND_META: Record<TimelineEvent["kind"], { label: string; color: string }> = {
  "run-ok": { label: "OK", color: "#4ecf8f" },
  "run-fail": { label: "ERR", color: "#e86a7c" },
  status: { label: "INFO", color: "#8a9bb0" },
  newsflow: { label: "NF", color: "#5cc6da" },
  attention: { label: "WARN", color: "#e8a84d" },
};

function buildTimeline(history: Snapshot[]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const ordered = [...history].reverse();
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const curr = ordered[i];
    if (!prev || !curr) continue;
    const at = curr.takenAt ?? "";
    const prevMap = new Map((prev.crons ?? []).map((c) => [c.id, c]));
    for (const c of curr.crons ?? []) {
      const p = prevMap.get(c.id);
      if (!p) {
        events.push({
          key: `${at}-${c.id}-new`,
          at,
          kind: "status",
          text: `Schedule “${c.title ?? c.id}” appeared (${c.status ?? (c.enabled ? "active" : "disabled")})`,
        });
        continue;
      }
      if ((p.status ?? "") !== (c.status ?? "") || (p.enabled ?? false) !== (c.enabled ?? false)) {
        events.push({
          key: `${at}-${c.id}-status`,
          at,
          kind: "status",
          text: `“${c.title ?? c.id}” status ${p.status ?? "—"} → ${c.status ?? "—"}`,
        });
      }
      if (c.lastRunAt && c.lastRunAt !== p.lastRunAt) {
        events.push({
          key: `${at}-${c.id}-run-${c.lastRunAt}`,
          at,
          kind: c.lastRunStatus === "failed" ? "run-fail" : "run-ok",
          text: `“${c.title ?? c.id}” run ${c.lastRunStatus ?? "finished"} · ${dhakaStamp(c.lastRunAt)}`,
        });
      }
    }
    if ((prev.newsflow?.status ?? "") !== (curr.newsflow?.status ?? "") && curr.newsflow?.status) {
      events.push({
        key: `${at}-newsflow`,
        at,
        kind: "newsflow",
        text: `NewsFlow ${prev.newsflow?.status ?? "—"} → ${curr.newsflow.status}`,
      });
    }
    const prevAtt = new Set((prev.attention ?? []).map((a) => a.text));
    for (const a of curr.attention ?? []) {
      if (!prevAtt.has(a.text)) {
        events.push({
          key: `${at}-att-${a.text.slice(0, 40)}`,
          at,
          kind: "attention",
          text: a.text,
        });
      }
    }
  }
  return events.reverse().slice(0, 30);
}

/* ---------- HUD building blocks ---------- */

function Corners() {
  return (
    <>
      <span className="mc-corner mc-c-tl" aria-hidden />
      <span className="mc-corner mc-c-tr" aria-hidden />
      <span className="mc-corner mc-c-bl" aria-hidden />
      <span className="mc-corner mc-c-br" aria-hidden />
    </>
  );
}

function Gauge({ value, color, size = 92 }: { value: number; color: string; size?: number }) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value));
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={`${Math.round(pct * 100)} percent`}
      className="shrink-0"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - pct)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: "stroke-dashoffset 0.6s ease" }}
      />
    </svg>
  );
}

function Waveform() {
  const delays = [0, 0.18, 0.36, 0.1, 0.5, 0.28, 0.62, 0.05];
  const heights = [9, 15, 19, 12, 17, 10, 14, 8];
  return (
    <span className="flex h-5 items-end gap-[3px] opacity-60" aria-hidden>
      {delays.map((d, i) => (
        <span
          key={i}
          className="mc-eq-bar w-[3px] rounded-sm bg-[#5cc6da]/70"
          style={{ height: heights[i] ?? 10, animationDelay: `${d}s` }}
        />
      ))}
    </span>
  );
}

/* ---------- tweened counter ---------- */

/**
 * Header / overview counters: when a new snapshot changes a number,
 * tween it over ~600ms ease-out instead of jumping. Instant under
 * reduced motion. Tabular numerals keep the digit columns steady
 * while the value sweeps.
 */
function TweenedNumber({
  value,
  reducedMotion,
}: {
  value: number;
  reducedMotion?: boolean;
}) {
  const [display, setDisplay] = useState(value);
  const shownRef = useRef(value);
  useEffect(() => {
    const from = shownRef.current;
    if (from === value) {
      setDisplay(value);
      return;
    }
    if (reducedMotion) {
      shownRef.current = value;
      setDisplay(value);
      return;
    }
    const dur = 600;
    const start = performance.now();
    let raf = 0;
    const stepFn = (t: number) => {
      const k = Math.max(0, Math.min(1, (t - start) / dur));
      const eased = 1 - Math.pow(1 - k, 3);
      const next = Math.round(from + (value - from) * eased);
      shownRef.current = next;
      setDisplay(next);
      if (k < 1) raf = requestAnimationFrame(stepFn);
    };
    raf = requestAnimationFrame(stepFn);
    return () => cancelAnimationFrame(raf);
  }, [value, reducedMotion]);
  return <span className="tabular-nums">{display}</span>;
}

/* ---------- live clock readouts (isolated 200ms tick) ----------
   These are the only components allowed to re-render on the fast
   tick. The App root no longer holds a ticking clock: freshness,
   the Dhaka wall clock and the next-push countdown each live in a
   tiny component with its own useNowMs(200) subscription, so the
   rest of the wall renders only when data or interaction changes. */

/** Snapshot age in seconds at a given instant (server ingest watermark
    preferred, snapshot takenAt as fallback). */
function ageSecAt(
  now: number,
  takenAtMs: number,
  lastIngestAt: string | null,
  ingestAgeSecFallback: number | null,
): number | null {
  if (lastIngestAt) {
    const t = new Date(lastIngestAt).getTime();
    if (!Number.isNaN(t)) return Math.max(0, Math.round((now - t) / 1000));
  }
  if (ingestAgeSecFallback != null) return ingestAgeSecFallback;
  if (!Number.isNaN(takenAtMs))
    return Math.max(0, Math.round((now - takenAtMs) / 1000));
  return null;
}

function freshnessText(ageSec: number | null): string {
  if (ageSec === null) return "no snapshot yet";
  if (ageSec < 5) return "updated just now";
  if (ageSec < 60) return `updated ${ageSec}s ago`;
  if (ageSec < 3600) {
    const m = Math.floor(ageSec / 60);
    const s = ageSec % 60;
    return s > 0 ? `updated ${m}m ${s}s ago` : `updated ${m}m ago`;
  }
  return `updated ${Math.floor(ageSec / 3600)}h ago`;
}

function DhakaClock() {
  const now = useNowMs(200);
  return (
    <span aria-label="Current time in Dhaka" className="tabular-nums">
      DHAKA {dhakaTime(new Date(now))}
    </span>
  );
}

function FreshnessText({
  takenAtMs,
  lastIngestAt,
  ingestAgeSecFallback,
  snapshotKey,
  hasLatest,
}: {
  takenAtMs: number;
  lastIngestAt: string | null;
  ingestAgeSecFallback: number | null;
  snapshotKey: string | null;
  hasLatest: boolean;
}) {
  const now = useNowMs(200);
  const ageSec = ageSecAt(now, takenAtMs, lastIngestAt, ingestAgeSecFallback);
  const stale = ageSec !== null && ageSec > 900;
  const updatedHM = Number.isNaN(takenAtMs)
    ? null
    : dhakaTime(new Date(takenAtMs)).slice(0, 5);
  const nextSnapMs = Number.isNaN(takenAtMs) ? null : takenAtMs + 600_000;
  const nextSnapLabel =
    nextSnapMs === null
      ? null
      : nextSnapMs > now
        ? `NEXT IN ~${Math.max(1, Math.ceil((nextSnapMs - now) / 60000))}M`
        : "NEXT DUE ANY MOMENT";
  return (
    <>
      <span
        key={snapshotKey ?? "awaiting"}
        aria-label="Data freshness"
        className={`mc-updated-pulse tabular-nums ${stale ? "text-[#e8a84d]" : "text-[#5cc6da]"}`}
      >
        {hasLatest ? freshnessText(ageSec) : "awaiting data"}
      </span>
      {updatedHM ? (
        <span aria-label="Snapshot updated at (Dhaka)" className="tabular-nums text-[#5b6b80]">
          UPDATED {updatedHM}
        </span>
      ) : null}
      {nextSnapLabel ? (
        <span aria-label="Next snapshot expected" className="tabular-nums text-[#5b6b80]">
          {nextSnapLabel}
        </span>
      ) : null}
    </>
  );
}

function FreshnessTrack({
  takenAtMs,
  lastIngestAt,
  ingestAgeSecFallback,
}: {
  takenAtMs: number;
  lastIngestAt: string | null;
  ingestAgeSecFallback: number | null;
}) {
  const now = useNowMs(1_000);
  const ageSec = ageSecAt(now, takenAtMs, lastIngestAt, ingestAgeSecFallback);
  const stale = ageSec !== null && ageSec > 900;
  const pct =
    ageSec === null ? 0 : Math.min(100, Math.round((ageSec / 900) * 100));
  return (
    <div
      className="mc-fresh-track mt-2.5"
      role="img"
      aria-label={
        stale
          ? "Snapshot is stale — more than 15 minutes old"
          : `Snapshot freshness window: ${pct}% elapsed`
      }
    >
      <div
        className="mc-fresh-fill"
        style={{
          width: `${pct}%`,
          background: stale ? "#e8a84d" : pct > 66 ? "#e8a84d" : "#4ecf8f",
        }}
      />
    </div>
  );
}

function Starfield({ animate }: { animate: boolean }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const g = canvas.getContext("2d");
    if (!g) return;
    let w = 0;
    let h = 0;
    let raf = 0;
    type Star = { x: number; y: number; r: number; p: number; s: number };
    let stars: Star[] = [];
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = rect.width;
      h = rect.height;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const n = Math.max(20, Math.round((w * h) / 12500));
      stars = Array.from({ length: n }, () => ({
        x: Math.random() * w,
        y: Math.random() * h,
        r: Math.random() * 1.3 + 0.3,
        p: Math.random() * Math.PI * 2,
        s: 0.4 + Math.random() * 1.3,
      }));
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const draw = (t: number) => {
      g.clearRect(0, 0, w, h);
      for (const s of stars) {
        const tw = 0.3 + 0.7 * Math.abs(Math.sin(s.p + t * 0.001 * s.s));
        g.globalAlpha = tw * 0.6;
        g.fillStyle = "#9fdcff";
        g.beginPath();
        g.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
      if (animate) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [animate]);
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" aria-hidden="true" />;
}

/* ---------- orbital stage ---------- */

const RING_RADII = [28, 36.5, 43];
const RING_SPEEDS = [(Math.PI * 2) / 85000, -(Math.PI * 2) / 125000, (Math.PI * 2) / 170000];

type PlacedNode = { cron: CronItem; ring: number; baseAngle: number };

/**
 * Orbit geometry for a given animation clock: ring angle per node,
 * then the separation pass (nodes on adjacent rings pass through each
 * other as they orbit; overlapping pairs are pushed apart). Pure —
 * called by the render for initial paint and by the RAF loop that
 * writes node positions straight to the DOM, so orbit motion never
 * goes through React state.
 */
function computeOrbitPositions(
  placed: PlacedNode[],
  elapsedMs: number,
  nodePct: number,
  maxR: number,
): { x: number; y: number }[] {
  const pts = placed.map((n) => {
    const speed = RING_SPEEDS[n.ring] ?? 0;
    const radius = RING_RADII[n.ring] ?? 40;
    const a = n.baseAngle + elapsedMs * speed;
    return { x: 50 + radius * Math.cos(a), y: 50 + radius * Math.sin(a) };
  });
  for (let iter = 0; iter < 28; iter++) {
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const p = pts[i];
        const q = pts[j];
        if (!p || !q) continue;
        let dx = q.x - p.x;
        let dy = q.y - p.y;
        let d = Math.hypot(dx, dy);
        if (d >= nodePct) continue;
        if (d < 0.001) {
          dx = 0.02 * (j + 1);
          dy = 0.013;
          d = Math.hypot(dx, dy);
        }
        const push = (nodePct - d) / 2;
        const ux = dx / d;
        const uy = dy / d;
        p.x -= ux * push;
        p.y -= uy * push;
        q.x += ux * push;
        q.y += uy * push;
      }
    }
    for (const p of pts) {
      const dx = p.x - 50;
      const dy = p.y - 50;
      const d = Math.hypot(dx, dy);
      if (d > maxR) {
        p.x = 50 + (dx / d) * maxR;
        p.y = 50 + (dy / d) * maxR;
      }
    }
  }
  return pts;
}

function OrbitalStage({
  crons,
  codeMap,
  selectedId,
  nextId,
  onSelect,
  coreLabel,
  coreVisual,
  animate,
  hoverId,
  onHoverNode,
  pulseKey,
}: {
  crons: CronItem[];
  codeMap: Map<string, string>;
  selectedId: string | null;
  nextId: string | null;
  onSelect: (id: string | null) => void;
  coreLabel: string;
  coreVisual?: CoreVisual;
  animate: boolean;
  hoverId?: string | null;
  onHoverNode?: (id: string | null) => void;
  pulseKey?: string | null;
}) {
  // Countdown arcs + the corner clock tick here (1s) — isolated to
  // this stage. Orbit MOTION never touches React state: the RAF loop
  // below writes transforms/attributes straight to the DOM.
  const nowMs = useNowMs(1_000);
  // Ingest pulse on the core when a fresh snapshot lands.
  const [corePulse, setCorePulse] = useState(false);
  const pulseSeenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pulseKey || pulseSeenRef.current === pulseKey) return;
    pulseSeenRef.current = pulseKey;
    setCorePulse(true);
    const t = window.setTimeout(() => setCorePulse(false), 950);
    return () => window.clearTimeout(t);
  }, [pulseKey]);
  // Moving targets are hard to tap: while the pointer is over the stage
  // (or pressed), the orbits ease to a crawl so nodes stay trackable.
  const slowRef = useRef(false);

  const placed = useMemo<PlacedNode[]>(() => {
    const rings: CronItem[][] = [[], [], []];
    crons.forEach((c, i) => {
      const ring = rings[i % 3];
      if (ring) ring.push(c);
    });
    const out: PlacedNode[] = [];
    rings.forEach((members, ringIdx) => {
      members.forEach((cron, j) => {
        out.push({
          cron,
          ring: ringIdx,
          baseAngle: (j / Math.max(1, members.length)) * Math.PI * 2 + ringIdx * 0.7,
        });
      });
    });
    return out;
  }, [crons]);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const [stageW, setStageW] = useState(0);
  // Imperative orbit: node buttons, link lines and the selection ring
  // are positioned by the RAF loop via refs — zero React re-renders
  // per frame, motion stays on compositor-friendly transforms.
  const nodeElsRef = useRef(new Map<string, HTMLButtonElement>());
  const linkElsRef = useRef(new Map<string, SVGLineElement>());
  const selRingRef = useRef<SVGCircleElement | null>(null);
  const positionsRef = useRef<{ x: number; y: number }[]>([]);
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const geomRef = useRef({ nodePct: 13, maxR: 43 });
  const stageWRef = useRef(0);
  const animateRef = useRef(animate);
  animateRef.current = animate;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const apply = () => {
      stageWRef.current = el.clientWidth;
      setStageW(el.clientWidth);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Node diameter (48px) + breathing room, expressed in stage-percent so
  // the separation pass works at any viewport width.
  const nodePct = stageW > 0 ? (53 / stageW) * 100 : 13;
  const maxR = 50 - nodePct / 2 - 0.5;
  geomRef.current = { nodePct, maxR };

  useEffect(() => {
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const dt = t - last;
      last = t;
      if (animateRef.current) acc += dt * (slowRef.current ? 0.1 : 1);
      const { nodePct: np, maxR: mr } = geomRef.current;
      const pos = computeOrbitPositions(placedRef.current, acc, np, mr);
      positionsRef.current = pos;
      const w = stageWRef.current;
      placedRef.current.forEach((n, idx) => {
        const p = pos[idx];
        if (!p) return;
        const btn = nodeElsRef.current.get(n.cron.id);
        if (btn && w > 0) {
          btn.style.transform = `translate3d(${(p.x / 100) * w}px, ${(p.y / 100) * w}px, 0) translate(-50%, -50%)`;
        }
        const line = linkElsRef.current.get(n.cron.id);
        if (line) {
          line.setAttribute("x2", String(p.x));
          line.setAttribute("y2", String(p.y));
        }
      });
      const ring = selRingRef.current;
      if (ring) {
        const selIdx = placedRef.current.findIndex(
          (n) => n.cron.id === selectedIdRef.current,
        );
        const sp = selIdx >= 0 ? pos[selIdx] : undefined;
        if (sp) {
          ring.setAttribute("cx", String(sp.x));
          ring.setAttribute("cy", String(sp.y));
          ring.style.opacity = "1";
        } else {
          ring.style.opacity = "0";
        }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const selectedIdx = placed.findIndex((n) => n.cron.id === selectedId);
  const selectedNode = selectedIdx >= 0 ? (placed[selectedIdx] ?? null) : null;
  // Initial paint positions (the RAF loop takes over immediately).
  const initialPositions = computeOrbitPositions(placed, 0, nodePct, maxR);
  const renderPos = (idx: number) =>
    positionsRef.current[idx] ?? initialPositions[idx] ?? { x: 50, y: 50 };
  const selectedPos = selectedIdx >= 0 ? renderPos(selectedIdx) : null;

  // 2D network map zoom/pan: transform on a wrapper only (compositor),
  // node taps still select; background drag pans, buttons/wheel zoom.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const panDragRef = useRef<{ x: number; y: number; panX: number; panY: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = stageRef.current;
    if (el) el.style.transform = `scale(${zoom}) translate(${pan.x}px, ${pan.y}px)`;
  }, [zoom, pan]);

  return (
    <div
      ref={stageRef}
      className="relative aspect-square w-full touch-pan-y overflow-hidden lg:aspect-[16/10]"
      onPointerDownCapture={(e) => {
        panDragRef.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y, moved: false };
      }}
      onPointerMoveCapture={(e) => {
        const d = panDragRef.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        if (Math.abs(dx) + Math.abs(dy) > 5) {
          d.moved = true;
          setPan({ x: d.panX + dx, y: d.panY + dy });
        }
      }}
      onPointerUpCapture={() => {
        panDragRef.current = null;
      }}
      onWheel={(e) => {
        setZoom((z) => Math.max(0.7, Math.min(1.6, z - Math.sign(e.deltaY) * 0.1)));
      }}
      onPointerEnter={() => {
        slowRef.current = true;
      }}
      onPointerLeave={() => {
        slowRef.current = false;
      }}
      onPointerDown={() => {
        slowRef.current = true;
      }}
      onPointerUp={() => {
        slowRef.current = false;
      }}
    >
      <Starfield animate={animate} />

      {/* radar sweep — a live-scan motion: never rendered before the
          first snapshot, where the stage must read as unpowered */}
      {coreVisual !== "NO_SIGNAL" ? (
        <div className="mc-radar-sweep pointer-events-none absolute inset-[3%] rounded-full" aria-hidden />
      ) : null}

      {/* wireframe rings + links */}
      <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" aria-hidden>
        {RING_RADII.map((r, i) => (
          <circle
            key={i}
            cx={50}
            cy={50}
            r={r}
            fill="none"
            stroke={selectedNode?.ring === i ? "rgba(0,240,255,0.4)" : "rgba(0,240,255,0.13)"}
            strokeWidth={selectedNode?.ring === i ? 0.3 : 0.18}
            strokeDasharray={i === 1 ? "1.2 0.9" : undefined}
          />
        ))}
        {/* globe meridians */}
        <circle cx={50} cy={50} r={17} fill="none" stroke="rgba(0,240,255,0.10)" strokeWidth={0.18} />
        <ellipse cx={50} cy={50} rx={7} ry={17} fill="none" stroke="rgba(0,240,255,0.08)" strokeWidth={0.15} />
        <ellipse cx={50} cy={50} rx={17} ry={6} fill="none" stroke="rgba(0,240,255,0.08)" strokeWidth={0.15} />
        {placed.map((n, idx) => {
          const p = renderPos(idx);
          const st = nodeState(n.cron);
          const isSel = n.cron.id === selectedId;
          return (
            <line
              key={`link-${n.cron.id}`}
              ref={(el) => {
                if (el) linkElsRef.current.set(n.cron.id, el);
                else linkElsRef.current.delete(n.cron.id);
              }}
              x1={50}
              y1={50}
              x2={p.x}
              y2={p.y}
              stroke={isSel ? "#5cc6da" : STATE_COLOR[st]}
              strokeOpacity={isSel ? 0.85 : st === "disabled" ? 0.10 : 0.28}
              strokeWidth={isSel ? 0.35 : 0.16}
            />
          );
        })}
        {selectedId ? (
          <circle
            ref={selRingRef}
            cx={selectedPos?.x ?? 50}
            cy={selectedPos?.y ?? 50}
            r={3.6}
            fill="none"
            stroke="#5cc6da"
            strokeWidth={0.3}
          />
        ) : null}
      </svg>

      {/* rotating dashed halos around the core — only while the core
          carries a real state; NO SIGNAL must be fully static */}
      {coreVisual !== "NO_SIGNAL" ? (
        <>
          <div
            className="mc-spin-slow pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[38%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-[#5cc6da]/25"
            aria-hidden
          />
          <div
            className="mc-spin-rev pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[47%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#5cc6da]/10"
            aria-hidden
          />
        </>
      ) : null}

      {/* core = NewsFlow — six-state AI core (truthful mapping, see
          deriveCoreState); before the first snapshot it renders the
          dim, static NO SIGNAL presentation instead of a state */}
      <button
        type="button"
        aria-label={`Show mission overview. ${
          coreVisual === "NO_SIGNAL"
            ? "AI core: no signal — waiting for first snapshot."
            : `AI core state: ${coreVisual ?? "NO_SIGNAL"}. ${coreVisual ? CORE_META[coreVisual].desc : "No signal — waiting for first snapshot"}`
        }`}
        onClick={() => onSelect(null)}
        className={`absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border bg-[#04121c]/90 text-center sm:h-24 sm:w-24 ${
          coreVisual ? CORE_META[coreVisual].cls : ""
        } ${corePulse && coreVisual !== "NO_SIGNAL" ? "mc-core-pulse" : ""}`}
        style={{
          borderColor: coreVisual ? CORE_META[coreVisual].border : "rgba(125,142,163,0.30)",
          boxShadow:
            coreVisual === "NO_SIGNAL"
              ? "none"
              : `0 0 20px ${coreVisual ? CORE_META[coreVisual].color : "#5cc6da"}30`,
        }}
      >
        <span
          className="h-2 w-2 rounded-full"
          aria-hidden
          style={{
            background: coreVisual ? CORE_META[coreVisual].color : "#7d8ea3",
            boxShadow:
              coreVisual === "NO_SIGNAL"
                ? "none"
                : `0 0 6px ${coreVisual ? CORE_META[coreVisual].color : "#5cc6da"}`,
          }}
        />
        <span className="mt-1 font-mono text-[8px] tracking-[0.22em] text-[#8a9bb0]">CORE</span>
        <span
          className="max-w-[5.5rem] truncate px-1 font-mono text-[10px] font-semibold tracking-widest"
          style={{ color: coreVisual ? CORE_META[coreVisual].color : "#7d8ea3" }}
        >
          {coreLabel}
        </span>
        <span className="sr-only">{coreVisual ? CORE_META[coreVisual].desc : "No signal — waiting for first snapshot"}</span>
      </button>

      {/* orbiting agent nodes */}
      {placed.map((n, idx) => {
        const p = renderPos(idx);
        const st = nodeState(n.cron);
        const color = STATE_COLOR[st];
        const isSel = n.cron.id === selectedId;
        const isNext = n.cron.id === nextId;
        const isHover = hoverId === n.cron.id;
        // Pending: ring nearly full (queued, about to fire). Running:
        // indeterminate energetic ring instead of a countdown.
        const frac = st === "running" ? null : st === "pending" ? 0.92 : nextRunFrac(n.cron, nowMs);
        const RING_C = 2 * Math.PI * 26;
        return (
          <button
            key={n.cron.id}
            ref={(el) => {
              if (el) nodeElsRef.current.set(n.cron.id, el);
              else nodeElsRef.current.delete(n.cron.id);
            }}
            type="button"
            aria-label={`${n.cron.title ?? n.cron.id}, ${STATE_LABEL[st]}${st === "pending" ? ", queued and waiting to execute" : st === "running" ? ", executing now" : ""}${isNext ? ", runs next" : ""}${isSel ? ", selected" : ""}`}
            aria-pressed={isSel}
            onClick={() => onSelect(isSel ? null : n.cron.id)}
            onMouseEnter={() => onHoverNode?.(n.cron.id)}
            onMouseLeave={() => onHoverNode?.(null)}
            onFocus={() => onHoverNode?.(n.cron.id)}
            onBlur={() => onHoverNode?.(null)}
            className={`mc-node-btn absolute left-0 top-0 flex h-12 w-12 touch-manipulation flex-col items-center justify-center rounded-full border bg-[#04121c]/92 font-mono backdrop-blur-sm ${
              st === "active"
                ? "mc-node-active"
                : st === "failed"
                  ? "mc-node-failed"
                  : st === "pending"
                    ? "mc-node-pending"
                    : st === "running"
                      ? "mc-node-running"
                      : ""
            } ${isHover && !isSel ? "mc-node-hover" : ""} ${st === "pending" ? "rounded-[14px]" : ""}`}
            title={n.cron.title ?? n.cron.id}
            style={{
              transform:
                stageW > 0
                  ? `translate3d(${(p.x / 100) * stageW}px, ${(p.y / 100) * stageW}px, 0) translate(-50%, -50%)`
                  : "translate(-50%, -50%)",
              borderColor: isSel ? "#5cc6da" : isNext ? "#e6f1ff" : `${color}88`,
              color,
              boxShadow: isSel
                ? "0 0 0 2px rgba(0,240,255,0.45), 0 0 14px rgba(0,240,255,0.38)"
                : isNext
                  ? `0 0 0 1.5px rgba(230,241,255,0.7), 0 0 9px ${color}50`
                  : st === "disabled"
                    ? "none"
                    : `0 0 6px ${color}2e`,
              opacity: st === "disabled" ? 0.62 : 1,
            }}
          >
            {st === "running" ? (
              <svg
                className="mc-spin-slow pointer-events-none absolute -inset-[5px] h-[58px] w-[58px]"
                viewBox="0 0 58 58"
                aria-hidden
                style={{ animationDuration: "3s" }}
              >
                <circle cx={29} cy={29} r={26} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={2} />
                <circle
                  cx={29}
                  cy={29}
                  r={26}
                  fill="none"
                  stroke={color}
                  strokeWidth={2.5}
                  strokeLinecap="round"
                  strokeDasharray={`${RING_C * 0.32} ${RING_C * 0.68}`}
                  style={{ filter: `drop-shadow(0 0 4px ${color})` }}
                />
              </svg>
            ) : frac !== null ? (
              <svg
                className="pointer-events-none absolute -inset-[5px] h-[58px] w-[58px] -rotate-90"
                viewBox="0 0 58 58"
                aria-hidden
              >
                <circle cx={29} cy={29} r={26} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={2} />
                <circle
                  cx={29}
                  cy={29}
                  r={26}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeOpacity={st === "failed" ? 0.9 : st === "active" ? 0.42 : 0.65}
                  strokeDasharray={st === "pending" ? "4 3" : RING_C}
                  strokeDashoffset={st === "pending" ? 0 : RING_C * (1 - frac)}
                  style={{
                    transition: "stroke-dashoffset 1s linear",
                    filter: st === "failed" ? `drop-shadow(0 0 3px ${color})` : undefined,
                  }}
                />
              </svg>
            ) : null}
            {isNext ? (
              <span
                aria-hidden
                className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-sm bg-[#e6f1ff] px-1 py-px text-[6.5px] font-semibold tracking-[0.12em] text-[#04121c]"
              >
                NEXT
              </span>
            ) : null}
            <span className="text-[11px] font-semibold leading-none">{codeMap.get(n.cron.id) ?? baseCode(n.cron)}</span>
            <span className="mt-0.5 text-[7px] tracking-[0.14em] opacity-80">{STATE_LABEL[st]}</span>
          </button>
        );
      })}

      {/* 2D map controls: zoom in / out / reset (44px targets) */}
      <div className="absolute right-2 top-8 z-20 flex flex-col gap-1">
        <button type="button" aria-label="Zoom in on 2D agent map" onClick={() => setZoom((z) => Math.min(1.6, z + 0.2))} className="mc-touch rounded border border-white/15 bg-[#04121c]/85 px-2 font-mono text-sm text-[#5cc6da]">+</button>
        <button type="button" aria-label="Zoom out on 2D agent map" onClick={() => setZoom((z) => Math.max(0.7, z - 0.2))} className="mc-touch rounded border border-white/15 bg-[#04121c]/85 px-2 font-mono text-sm text-[#5cc6da]">−</button>
        <button type="button" aria-label="Reset 2D agent map zoom and pan" onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }} className="mc-touch rounded border border-white/15 bg-[#04121c]/85 px-2 font-mono text-[9px] text-[#8a9bb0]">1:1</button>
      </div>

      {/* corner readouts */}
      <span className="pointer-events-none absolute bottom-2 left-3 font-mono text-[10px] tracking-widest text-[#5b6b80]">
        DHAKA {dhakaTime(new Date(nowMs))}
      </span>
      <span className="pointer-events-none absolute bottom-2 right-3 font-mono text-[10px] tracking-widest text-[#5b6b80]">
        NODES {crons.length}
      </span>
      <span className="pointer-events-none absolute left-1/2 top-2 max-w-[84%] -translate-x-1/2 truncate font-mono text-[10px] tracking-[0.2em] text-[#5b6b80]">
        {selectedNode ? `TRACKING: ${(selectedNode.cron.title ?? selectedNode.cron.id).toUpperCase()}` : "CORE LINKED // NEWSFLOW"}
      </span>
    </div>
  );
}

/* ---------- timeline (24h) ---------- */

type RunBlock = { t: number; isNext: boolean };

function projectBlocks(c: CronItem, startMs: number, endMs: number): RunBlock[] {
  const out: RunBlock[] = [];
  const next = toMs(c.nextRunAt);
  if (next == null) return out;
  let step = cadenceIntervalMs(c.cadence);
  const last = toMs(c.lastRunAt);
  if (!step && last != null && next > last) step = next - last;
  let t = next;
  let first = true;
  // Cover the whole window even for 10-minute cadences (144 runs/day).
  const limit = step
    ? Math.max(1, Math.min(240, Math.ceil((endMs - next) / step) + 1))
    : 1;
  let guard = 0;
  while (guard < limit) {
    // The next-run block always shows (clamped to the window edge);
    // later repeats only when they land inside the window.
    if (t <= endMs && (first || t >= startMs)) out.push({ t, isNext: first });
    first = false;
    if (!step || t > endMs) break;
    t += step;
    guard++;
  }
  return out;
}

function Timeline24h({
  crons,
  codeMap,
  selectedId,
  hoverId,
  onSelect,
  onHover,
}: {
  crons: CronItem[];
  codeMap: Map<string, string>;
  selectedId: string | null;
  hoverId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
}) {
  // The NOW beam + countdown labels tick inside this component only.
  const nowMs = useNowMs(1_000);
  const startMs = nowMs - 3_600_000;
  const spanMs = 24 * 3_600_000;
  const endMs = startMs + spanMs;
  const nowPct = ((nowMs - startMs) / spanMs) * 100;
  const LABEL_W = 184; // label column (172) + gap (12)

  const rows = useMemo(() => {
    const withNext = crons.map((c) => ({ cron: c, next: toMs(c.nextRunAt) }));
    return withNext.sort((a, b) => {
      if (a.next == null && b.next == null)
        return (a.cron.title ?? a.cron.id).localeCompare(b.cron.title ?? b.cron.id);
      if (a.next == null) return 1;
      if (b.next == null) return -1;
      return a.next - b.next;
    });
  }, [crons]);

  const upcoming = useMemo(() => {
    const entries: { cron: CronItem; t: number }[] = [];
    for (const c of crons) {
      const next = toMs(c.nextRunAt);
      if (next == null) continue;
      entries.push({ cron: c, t: next });
      const step = cadenceIntervalMs(c.cadence);
      if (step && next + step <= endMs) entries.push({ cron: c, t: next + step });
    }
    return entries.sort((a, b) => a.t - b.t).slice(0, 16);
  }, [crons, endMs]);

  const hasRuns = rows.some((r) => r.next != null);
  const todayKey = dhakaDayKey(nowMs);
  const tomorrowKey = dhakaDayKey(nowMs + 86_400_000);

  if (!hasRuns) {
    return (
      <p className="px-4 py-10 text-center font-mono text-xs leading-relaxed text-[#8a9bb0]">
        No upcoming runs reported yet — schedules appear here once the worker
        sends their next run times.
      </p>
    );
  }

  return (
    <div>
      {/* ---- desktop / tablet: 24h strip ---- */}
      <div className="hidden md:block">
        {/* hour axis */}
        <div className="flex gap-3 px-4 pt-2" aria-hidden>
          <div style={{ width: 176 }} className="shrink-0" />
          <div className="relative h-5 flex-1">
            {Array.from({ length: 9 }, (_, i) => i * 3).map((h) => {
              const t = startMs + h * 3_600_000;
              return (
                <span
                  key={h}
                  className="absolute -translate-x-1/2 font-mono text-[9px] tracking-widest text-[#5b6b80]"
                  style={{ left: `${(h / 24) * 100}%` }}
                >
                  {dhakaClock(t)}
                </span>
              );
            })}
          </div>
        </div>
        <div className="relative px-4 pb-3">
          {/* gridlines + NOW beam, aligned to the track column */}
          <div
            className="pointer-events-none absolute inset-y-0 right-4"
            style={{ left: LABEL_W + 20 }}
            aria-hidden
          >
            {Array.from({ length: 25 }, (_, h) => (
              <span
                key={h}
                className="absolute inset-y-0 w-px bg-white/[0.045]"
                style={{ left: `${(h / 24) * 100}%` }}
              />
            ))}
            <span className="mc-now-line absolute inset-y-0 w-[2px]" style={{ left: `${nowPct}%` }} />
            <span
              className="absolute top-0 -translate-x-1/2 rounded-sm bg-[#5cc6da] px-1 py-px font-mono text-[8px] font-semibold tracking-[0.14em] text-[#04121c]"
              style={{ left: `${nowPct}%` }}
            >
              NOW
            </span>
          </div>
          <ul className="relative">
            {rows.map(({ cron: c, next }) => {
              const st = nodeState(c);
              const color = STATE_COLOR[st];
              const isSel = selectedId === c.id;
              const isHover = hoverId === c.id;
              const dimmed = selectedId !== null && !isSel;
              const blocks = projectBlocks(c, startMs, endMs);
              const last = toMs(c.lastRunAt);
              const failed = c.lastRunStatus === "failed";
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    aria-label={`${c.title ?? c.id}, ${cadencePlain(c.cadence)}, next run ${countdownLabel(next, nowMs)}`}
                    aria-pressed={isSel}
                    title={`${c.title ?? c.id} — ${cadencePlain(c.cadence)} — next ${dhakaStamp(c.nextRunAt)} Dhaka`}
                    onClick={() => onSelect(isSel ? null : c.id)}
                    onMouseEnter={() => onHover(c.id)}
                    onMouseLeave={() => onHover(null)}
                    onFocus={() => onHover(c.id)}
                    onBlur={() => onHover(null)}
                    className={`flex w-full touch-manipulation items-center gap-3 rounded-md px-1 py-1 text-left transition-opacity ${
                      isSel ? "bg-[#5cc6da]/10" : isHover ? "bg-white/[0.04]" : ""
                    }`}
                    style={{ opacity: dimmed ? 0.3 : 1 }}
                  >
                    <span className="flex min-w-0 shrink-0 items-center gap-2" style={{ width: 172 }}>
                      <span
                        className="flex h-7 min-w-7 shrink-0 items-center justify-center border px-1 font-mono text-[9px] font-semibold"
                        style={{
                          borderColor: `${color}77`,
                          color,
                          borderRadius: st === "pending" ? 4 : 999,
                          borderStyle: st === "pending" ? "dashed" : "solid",
                        }}
                      >
                        {codeMap.get(c.id) ?? baseCode(c)}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[11px] font-medium leading-tight">
                          {c.title ?? c.id}
                        </span>
                        <span className="block truncate font-mono text-[8.5px] leading-tight tabular-nums text-[#5b6b80]">
                          {cadencePlain(c.cadence)} ·{" "}
                          <span style={{ color }}>
                            {st === "running" ? "RUNNING NOW" : st === "pending" ? `QUEUED ${countdownLabel(next, nowMs)}` : countdownLabel(next, nowMs)}
                          </span>
                          {failed && st !== "running" && st !== "pending" ? <span className="text-[#e86a7c]"> · LAST FAILED</span> : null}
                        </span>
                      </span>
                    </span>
                    <span className="relative h-7 flex-1" aria-hidden>
                      {last != null && last >= startMs && last <= nowMs ? (
                        <span
                          className="absolute top-1/2 h-[10px] w-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full border bg-transparent"
                          style={{
                            left: `${((last - startMs) / spanMs) * 100}%`,
                            borderColor: failed ? "#e86a7c" : "rgba(255,255,255,0.25)",
                            boxShadow: failed ? "0 0 6px rgba(255,45,85,0.6)" : undefined,
                          }}
                        />
                      ) : null}
                      {st === "running" ? (
                        <span
                          className="mc-timeline-running absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm px-1.5 py-[3px] font-mono text-[8.5px] font-bold"
                          style={{
                            left: `${nowPct}%`,
                            background: color,
                            border: `1px solid ${color}`,
                            color: "#04121c",
                          }}
                        >
                          NOW · RUNNING
                        </span>
                      ) : null}
                      {blocks.map((b, bi) => {
                        const leftPct = Math.max(0, Math.min(100, ((b.t - startMs) / spanMs) * 100));
                        if (b.isNext) {
                          if (st === "running") return null;
                          const isPending = st === "pending";
                          return (
                            <span
                              key={bi}
                              className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm px-1.5 py-[3px] font-mono text-[8.5px] font-semibold tabular-nums ${isPending ? "mc-timeline-pending" : ""}`}
                              style={{
                                left: `${leftPct}%`,
                                background: isPending ? "transparent" : `${color}26`,
                                border: `1px ${isPending ? "dashed" : "solid"} ${color}`,
                                color,
                                boxShadow: isPending ? `inset 0 0 8px ${color}22` : `0 0 8px ${color}55`,
                              }}
                            >
                              {isPending ? `PENDING ${countdownLabel(b.t, nowMs)}` : countdownLabel(b.t, nowMs)}
                            </span>
                          );
                        }
                        return (
                          <span
                            key={bi}
                            className="absolute top-1/2 w-[5px] -translate-x-1/2 -translate-y-1/2 rounded-[2px]"
                            style={{
                              left: `${leftPct}%`,
                              height: 13,
                              background: `${color}59`,
                            }}
                          />
                        );
                      })}
                      {next == null ? (
                        <span className="absolute left-0 top-1/2 -translate-y-1/2 font-mono text-[9px] tracking-widest text-[#5b6b80]">
                          NO RUN SCHEDULED
                        </span>
                      ) : null}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* ---- phone: chronological upcoming list ---- */}
      <div className="md:hidden">
        <ul className="divide-y divide-white/5 px-2 pb-2">
          {upcoming.map(({ cron: c, t }, i) => {
            const st = nodeState(c);
            const color = STATE_COLOR[st];
            const isSel = selectedId === c.id;
            const dimmed = selectedId !== null && !isSel;
            const dayKey = dhakaDayKey(t);
            return (
              <li key={`${c.id}-${t}-${i}`}>
                <button
                  type="button"
                  aria-label={`${c.title ?? c.id}, ${STATE_LABEL[st]}, runs ${countdownLabel(t, nowMs)}`}
                  aria-pressed={isSel}
                  onClick={() => onSelect(isSel ? null : c.id)}
                  className={`flex w-full touch-manipulation items-center gap-3 rounded-md px-2 py-2.5 text-left transition-opacity ${
                    isSel ? "bg-[#5cc6da]/10" : ""
                  }`}
                  style={{ opacity: dimmed ? 0.3 : 1 }}
                >
                  <span className="flex shrink-0 flex-col items-center rounded border border-white/10 bg-white/[0.03] px-2 py-1">
                    <span className="font-mono text-[11px] font-semibold text-[#e6f1ff]">
                      {dhakaClock(t)}
                    </span>
                    <span className="font-mono text-[7.5px] tracking-[0.14em] text-[#5b6b80]">
                      {dayKey === todayKey ? "TODAY" : dayKey === tomorrowKey ? "TOMORROW" : dhakaStamp(new Date(t).toISOString()).slice(0, 6).toUpperCase()}
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium leading-tight">
                      {c.title ?? c.id}
                    </span>
                    <span className="block truncate font-mono text-[9.5px] tabular-nums text-[#5b6b80]">
                      {cadencePlain(c.cadence)} ·{" "}
                      <span style={{ color }}>{countdownLabel(t, nowMs)}</span>
                    </span>
                  </span>
                  <span
                    className="flex shrink-0 items-center gap-1.5 font-mono text-[8.5px] tracking-widest"
                    style={{ color }}
                  >
                    <StatusIcon state={st} />
                    {STATE_LABEL[st]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/* ---------- boot overlay ---------- */

function BootOverlay() {
  const lines = [
    "MISSION CONTROL OS — HUD BUILD 3.0",
    "> WEBGL CORE ......... ONLINE",
    "> ORBITAL TRACKER .... ONLINE",
    "> BLOOM PIPELINE ..... SYNCED",
    "> AGENT FLEET ........ LOCKED",
  ];
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[#04070c]"
      style={{ animation: "mc-boot-out 0.45s ease 1.3s forwards" }}
    >
      <div className="w-[min(420px,86vw)] font-mono text-[11px] leading-6 text-[#5cc6da]">
        {lines.map((l, i) => (
          <p key={l} className="mc-fade-in" style={{ animationDelay: `${i * 130}ms` }}>
            {l}
          </p>
        ))}
        <p className="mc-blink mt-2 text-[#4ecf8f]">▮ ESTABLISHING UPLINK…</p>
      </div>
    </div>
  );
}

/* ---------- status toast ---------- */

type StatusToast = {
  id: number;
  title: string;
  message: string;
  tone: "danger" | "info";
  cronId: string | null;
  extra: number;
};

/* ---------- pass C: palette, narrative cards, pins ---------- */

const STATE_RANK: Record<NodeState, number> = {
  failed: 0,
  running: 1,
  pending: 2,
  paused: 3,
  active: 4,
  disabled: 5,
};

const STATE_GLYPH: Record<NodeState, string> = {
  active: "●",
  running: "▶",
  pending: "◐",
  paused: "▮",
  failed: "✕",
  disabled: "○",
};

const FILTER_ORDER = [
  "all",
  "active",
  "running",
  "pending",
  "paused",
  "failed",
  "disabled",
  "issues",
  "standby",
] as const;
type FleetFilter = (typeof FILTER_ORDER)[number];

/** Subsequence fuzzy match: >0 score on match, -1 on no match. */
function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      qi += 1;
      streak += 1;
      score += 1 + streak * 0.4;
      if (i === 0 || t[i - 1] === " " || t[i - 1] === "-" || t[i - 1] === "_")
        score += 2;
    } else {
      streak = 0;
    }
  }
  return qi === q.length ? score : -1;
}

/** Link free-text (an attention line) to the schedule it names, if any. */
function matchCronForText(text: string, crons: CronItem[]): CronItem | null {
  const t = text.toLowerCase();
  const byTitle = crons
    .filter((c) => c.title && t.includes(c.title.toLowerCase()))
    .sort((a, b) => (b.title ?? "").length - (a.title ?? "").length)[0];
  if (byTitle) return byTitle;
  return crons.find((c) => t.includes(c.id.toLowerCase())) ?? null;
}

/** Distinct runs for a unit across the snapshot history, newest first. */
function runsFor(
  history: Snapshot[],
  id: string,
  limit = 10,
): { at: string; st: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const s of history) {
    const c = (s.crons ?? []).find((x) => x.id === id);
    if (c?.lastRunAt && !seen.has(c.lastRunAt)) {
      seen.set(c.lastRunAt, c.lastRunStatus ?? null);
    }
  }
  return [...seen.entries()]
    .slice(0, limit)
    .map(([at, st]) => ({ at, st }));
}

/**
 * The "why it matters" line for a failing unit — assembled only from
 * real history: failure streaks, last success, and failures that
 * landed within 2 minutes of another unit's failure. Undefined when
 * the data says nothing.
 */
function failureWhy(
  c: CronItem,
  crons: CronItem[],
  history: Snapshot[],
  nowMs: number,
): string | undefined {
  const parts: string[] = [];
  const runs = runsFor(history, c.id, 12);
  let streak = 0;
  for (const r of runs) {
    if (r.st === "failed") streak += 1;
    else break;
  }
  if (streak >= 2) parts.push(`Failed ${streak} times in a row`);
  const lastOk = runs.find((r) => r.st === "completed");
  if (lastOk) parts.push(`last success ${rel(lastOk.at, nowMs)}`);
  else if (runs.length > 0 && streak === runs.length)
    parts.push("no success in recent history");
  const myFail = toMs(c.lastRunAt);
  if (myFail != null && c.lastRunStatus === "failed") {
    const other = crons.find((o) => {
      if (o.id === c.id || o.lastRunStatus !== "failed") return false;
      const t = toMs(o.lastRunAt);
      return t != null && Math.abs(t - myFail) <= 120_000;
    });
    if (other)
      parts.push(
        `failed within 2 min of ${other.title ?? other.id} — possibly related`,
      );
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

type AttentionEntry = { severity: "action" | "warn" | "info"; text: string };

type AttCard = {
  key: string;
  severity: "action" | "warn" | "info";
  what: string;
  why?: string;
  cronId: string | null;
  actionLabel: string | null;
};

/**
 * Narrative attention cards: failures, correlated failures (via the
 * why line), and anomalies (disabled but still scheduled) become
 * WHAT → WHY → ACTION cards. Everything else stays a quiet list row.
 */
function buildAttentionCards(
  attention: AttentionEntry[],
  crons: CronItem[],
  history: Snapshot[],
  nowMs: number,
): {
  cards: AttCard[];
  quiet: { index: number; severity: AttentionEntry["severity"]; text: string }[];
} {
  const cards: AttCard[] = [];
  const promoted = new Set<number>();
  const covered = new Set<string>();
  attention.forEach((a, i) => {
    const c = matchCronForText(a.text, crons);
    if (!c) return;
    if (c.lastRunStatus === "failed") {
      cards.push({
        key: `att-${i}`,
        severity: a.severity,
        what: a.text,
        why: failureWhy(c, crons, history, nowMs),
        cronId: c.id,
        actionLabel: `Inspect ${c.title ?? c.id}`,
      });
      promoted.add(i);
      covered.add(c.id);
    } else if (nodeState(c) === "disabled" && c.nextRunAt) {
      cards.push({
        key: `att-${i}`,
        severity: "warn",
        what: a.text,
        why: `Still scheduled ${rel(c.nextRunAt, nowMs)} (${dhakaStamp(c.nextRunAt)} Dhaka) while the unit is disabled`,
        cronId: c.id,
        actionLabel: `Inspect ${c.title ?? c.id}`,
      });
      promoted.add(i);
      covered.add(c.id);
    }
  });
  for (const c of crons) {
    if (covered.has(c.id)) continue;
    if (c.lastRunStatus === "failed") {
      cards.push({
        key: `fail-${c.id}`,
        severity: "action",
        what: `${c.title ?? c.id} failed its last run${c.lastRunAt ? ` · ${dhakaStamp(c.lastRunAt)} Dhaka` : ""}`,
        why: failureWhy(c, crons, history, nowMs),
        cronId: c.id,
        actionLabel: `Inspect ${c.title ?? c.id}`,
      });
    } else if (nodeState(c) === "disabled" && c.nextRunAt) {
      cards.push({
        key: `anom-${c.id}`,
        severity: "warn",
        what: `${c.title ?? c.id} is disabled but still has a run scheduled`,
        why: `Next run ${rel(c.nextRunAt, nowMs)} (${dhakaStamp(c.nextRunAt)} Dhaka) is on the books while the unit is disabled`,
        cronId: c.id,
        actionLabel: `Inspect ${c.title ?? c.id}`,
      });
    }
  }
  const quiet = attention
    .map((a, index) => ({ ...a, index }))
    .filter((a) => !promoted.has(a.index));
  return { cards, quiet };
}

function downloadCsv(filename: string, rows: string[][]) {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const body = rows.map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(
    new Blob([body], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/* ---------- command palette ---------- */

type PaletteGroupName = "Navigation" | "Inspection" | "Filters" | "Time Travel";

type PaletteItem = {
  key: string;
  group: PaletteGroupName;
  kind:
    | "task"
    | "view"
    | "attention"
    | "copy"
    | "export"
    | "filter"
    | "sound"
    | "timetravel"
    | "help";
  title: string;
  sub?: string;
  searchText: string;
  cron?: CronItem;
  state?: NodeState;
  recent?: boolean;
  run: () => void;
};

const KIND_BADGE: Record<PaletteItem["kind"], string> = {
  task: "TASK",
  view: "VIEW",
  attention: "ALERT",
  copy: "COPY",
  export: "CSV",
  filter: "FILTER",
  sound: "SOUND",
  timetravel: "TIME",
  help: "HELP",
};

function CommandPalette(props: {
  open: boolean;
  query: string;
  onQuery: (q: string) => void;
  groups: { name: PaletteGroupName; items: PaletteItem[] }[];
  flat: PaletteItem[];
  activeIndex: number;
  onActive: (i: number) => void;
  onPick: (item: PaletteItem, pin: boolean) => void;
  onClose: () => void;
  onOpenHelp: () => void;
  previewItem: PaletteItem | null;
  previewRuns: { at: string; st: string | null }[];
  previewLogs: string[];
  pinnedIds: string[];
}) {
  const {
    open,
    query,
    onQuery,
    groups,
    flat,
    activeIndex,
    onActive,
    onPick,
    onClose,
    onOpenHelp,
    previewItem,
    previewRuns,
    previewLogs,
    pinnedIds,
  } = props;
  // Preview countdowns tick inside the palette only.
  const nowMs = useNowMs(1_000);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pressTimer = useRef<number | null>(null);
  const longPressed = useRef(false);
  const touchY = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 40);
    return () => window.clearTimeout(t);
  }, [open ]);

  useEffect(() => {
    if (!open) return;
    document
      .getElementById(`mc-pal-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, activeIndex]);

  if (!open) return null;

  const activeItem = flat[activeIndex] ?? null;

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (flat.length > 0)
        onActive(Math.min(flat.length - 1, activeIndex + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      onActive(Math.max(0, activeIndex - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = flat[activeIndex];
      if (item) onPick(item, e.metaKey || e.ctrlKey);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (/^[1-9]$/.test(e.key) && query === "") {
      const item = flat[Number(e.key) - 1];
      if (item) {
        e.preventDefault();
        onPick(item, false);
      }
    } else if (e.key === "?" && query === "") {
      e.preventDefault();
      onOpenHelp();
    }
  };

  const startPress = (item: PaletteItem) => {
    longPressed.current = false;
    if (!item.cron) return;
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true;
      onPick(item, true);
    }, 520);
  };
  const endPress = () => {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  const onTouchStart = (e: ReactTouchEvent) => {
    touchY.current = e.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    const y = e.touches[0]?.clientY;
    if (touchY.current != null && y != null && y - touchY.current > 72) {
      touchY.current = null;
      onClose();
    }
  };

  const previewCron = previewItem?.cron ?? null;

  return (
    <div className="fixed inset-0 z-[60]">
      <button
        type="button"
        aria-label="Close command palette"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="mc-palette mc-palette-premium relative flex h-full w-full flex-col sm:mx-auto sm:mt-[7vh] sm:h-auto sm:max-h-[84vh] sm:max-w-2xl sm:rounded-xl"
        onKeyDown={onKeyDown}
      >
        <div
          className="mc-palette-head px-4 pt-3 sm:pt-4"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
        >
          <div
            className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/15 sm:hidden"
            aria-hidden
          />
          <div className="flex items-center gap-2 pb-3">
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
              className="shrink-0 text-[#5cc6da]"
            >
              <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
              <path d="M20 20L16.5 16.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              aria-label="Search schedules, views, filters and actions"
              aria-expanded="true"
              aria-controls="mc-palette-list"
              aria-activedescendant={
                activeItem ? `mc-pal-${activeIndex}` : undefined
              }
              placeholder="Search schedules, views, actions…"
              className="min-w-0 flex-1 bg-transparent font-mono text-sm text-[#e6f1ff] outline-none placeholder:text-[#5b6b80]"
            />
            <span className="mc-kbd hidden sm:inline">ESC</span>
            <button
              type="button"
              aria-label="Close search"
              onClick={onClose}
              className="mc-touch flex items-center justify-center rounded border border-white/15 bg-white/5 px-2.5 font-mono text-xs text-[#c7d6ea]"
            >
              ✕
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col sm:grid sm:grid-cols-[1fr_250px]">
          <ul
            id="mc-palette-list"
            role="listbox"
            aria-label="Search results"
            className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
          >
            {flat.length === 0 ? (
              <li className="px-3 py-8 text-center font-mono text-xs leading-relaxed text-[#8a9bb0]">
                No matches{query ? ` for “${query}”` : ""}. Try a schedule
                name, “failed”, “timeline”, or “sound”.
              </li>
            ) : (
              groups.map((g) => (
                <li key={g.name} role="presentation">
                  <p className="px-3 pb-1 pt-3 font-mono text-[9px] tracking-[0.24em] text-[#5b6b80]">
                    {g.name.toUpperCase()}
                  </p>
                  <ul>
                    {g.items.map((item) => {
                      const idx = flat.indexOf(item);
                      const isActive = idx === activeIndex;
                      const st = item.state;
                      return (
                        <li
                          key={item.key}
                          id={`mc-pal-${idx}`}
                          role="option"
                          aria-selected={isActive}
                        >
                          <button
                            type="button"
                            tabIndex={-1}
                            aria-label={`${item.title}${item.sub ? `. ${item.sub}` : ""}`}
                            onMouseEnter={() => onActive(idx)}
                            onClick={() => {
                              if (longPressed.current) {
                                longPressed.current = false;
                                return;
                              }
                              onPick(item, false);
                            }}
                            onPointerDown={() => startPress(item)}
                            onPointerUp={endPress}
                            onPointerLeave={endPress}
                            onContextMenu={(e) => {
                              if (item.cron) e.preventDefault();
                            }}
                            className={`flex w-full touch-manipulation items-center gap-2.5 rounded-md px-3 py-2.5 text-left ${
                              isActive ? "bg-[#5cc6da]/12" : ""
                            }`}
                          >
                            {item.cron && st ? (
                              <span className="flex shrink-0 items-center gap-1.5">
                                <span
                                  className="h-2 w-2 rounded-full"
                                  style={{
                                    background: STATE_COLOR[st],
                                    boxShadow: `0 0 6px ${STATE_COLOR[st]}`,
                                  }}
                                  aria-hidden
                                />
                                <span
                                  aria-hidden
                                  className="font-mono text-[10px]"
                                  style={{ color: STATE_COLOR[st] }}
                                >
                                  {STATE_GLYPH[st]}
                                </span>
                              </span>
                            ) : (
                              <span className="w-[46px] shrink-0 font-mono text-[8.5px] tracking-widest text-[#5b6b80]">
                                {KIND_BADGE[item.kind]}
                              </span>
                            )}
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium leading-tight">
                                {item.title}
                              </span>
                              {item.sub ? (
                                <span className="block truncate font-mono text-[9.5px] leading-tight text-[#5b6b80]">
                                  {item.sub}
                                </span>
                              ) : null}
                            </span>
                            {item.recent ? (
                              <span className="shrink-0 rounded border border-[#5cc6da]/40 bg-[#5cc6da]/10 px-1.5 py-0.5 font-mono text-[8px] tracking-widest text-[#5cc6da]">
                                RECENTLY VIEWED
                              </span>
                            ) : null}
                            {item.cron && pinnedIds.includes(item.cron.id) ? (
                              <span className="shrink-0 font-mono text-[8px] tracking-widest text-[#e8a84d]">
                                PINNED
                              </span>
                            ) : null}
                            {idx < 9 ? (
                              <span className="mc-kbd shrink-0">{idx + 1}</span>
                            ) : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))
            )}
          </ul>

          <div className="max-h-[38%] shrink-0 overflow-y-auto border-t border-white/10 px-4 py-3 sm:max-h-none sm:border-l sm:border-t-0">
            {previewCron && previewItem ? (
              <div>
                <p className="mc-hud-label">Preview</p>
                <p className="mt-2 truncate text-sm font-semibold">
                  {previewItem.title}
                </p>
                <p className="truncate font-mono text-[10px] text-[#5b6b80]">
                  {previewCron.id}
                </p>
                <div className="mt-2">{statusBadge(previewCron)}</div>
                <dl className="mt-3 space-y-1.5 font-mono text-[11px]">
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-[#5b6b80]">CADENCE</dt>
                    <dd className="text-right">
                      {cadencePlain(previewCron.cadence)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-[#5b6b80]">NEXT RUN</dt>
                    <dd className="tabular-nums text-right text-[#5cc6da]">
                      {countdownLabel(toMs(previewCron.nextRunAt), nowMs)}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-[#5b6b80]">LAST RESULT</dt>
                    <dd className="text-right">
                      {previewCron.lastRunStatus ?? "no run yet"}
                    </dd>
                  </div>
                </dl>
                <p className="mc-hud-label mt-3">Recent runs</p>
                {previewRuns.length === 0 ? (
                  <p className="mt-1.5 font-mono text-[11px] text-[#8a9bb0]">
                    No runs in recent snapshots.
                  </p>
                ) : (
                  <div
                    className="mt-2 flex items-end gap-1"
                    role="img"
                    aria-label={`Last ${previewRuns.length} runs: ${previewRuns.map((r) => r.st ?? "unknown").join(", ")}`}
                  >
                    {previewRuns.map((r) => (
                      <span
                        key={r.at}
                        title={`${dhakaStamp(r.at)} · ${r.st ?? "unknown"}`}
                        className="w-3 rounded-sm"
                        style={{
                          height:
                            r.st === "completed" || r.st === "failed"
                              ? 16
                              : r.st === "skipped"
                                ? 10
                                : 6,
                          background:
                            r.st === "completed"
                              ? "#4ecf8f"
                              : r.st === "failed"
                                ? "#e86a7c"
                                : r.st === "skipped"
                                  ? "#e8a84d"
                                  : "#3a4a5f",
                        }}
                      />
                    ))}
                  </div>
                )}
                <p className="mc-hud-label mt-3">Last log lines</p>
                {previewLogs.length === 0 ? (
                  <p className="mt-1.5 font-mono text-[11px] text-[#8a9bb0]">
                    No activity lines for this unit yet.
                  </p>
                ) : (
                  <ul className="mt-1.5 space-y-1">
                    {previewLogs.map((l, i) => (
                      <li
                        key={i}
                        className="font-mono text-[10.5px] leading-relaxed text-[#8a9bb0]"
                      >
                        {l}
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-3 font-mono text-[9px] tracking-widest text-[#5b6b80]">
                  ENTER OPEN · ⌘+ENTER PIN
                </p>
              </div>
            ) : previewItem ? (
              <div>
                <p className="mc-hud-label">Preview</p>
                <p className="mt-2 text-sm font-semibold leading-snug">
                  {previewItem.title}
                </p>
                {previewItem.sub ? (
                  <p className="mt-1 font-mono text-[11px] leading-relaxed text-[#8a9bb0]">
                    {previewItem.sub}
                  </p>
                ) : null}
                <p className="mt-3 font-mono text-[9px] leading-relaxed tracking-widest text-[#5b6b80]">
                  ENTER TO APPLY — NAVIGATION & INSPECTION ONLY, NOTHING HERE
                  CHANGES THE BACKEND
                </p>
              </div>
            ) : (
              <div>
                <p className="mc-hud-label">Preview</p>
                <p className="mt-2 font-mono text-[11px] leading-relaxed text-[#8a9bb0]">
                  Highlight a result to preview it here. Tasks show status,
                  recent runs, and log lines.
                </p>
              </div>
            )}
          </div>
        </div>

        <p className="hidden border-t border-white/10 px-4 py-2 font-mono text-[9px] tracking-widest text-[#5b6b80] sm:block">
          ↑↓ NAVIGATE · ENTER OPEN · ⌘+ENTER PIN · 1–9 QUICK SELECT (EMPTY
          SEARCH) · ESC CLOSE
        </p>
      </div>
    </div>
  );
}

function ShortcutsHelp({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) return null;
  const rows: [string, string][] = [
    ["1 / 2 / 3 / 6", "Switch stage: 3D orbit · 2D orbit · 24H timeline · Activity"],
    ["4 / 5", "Open Reliability Center · Improvement Center"],
    ["⌘K / Ctrl+K", "Open or close the command palette"],
    ["Ctrl+Shift+D", "Open system diagnostics (performance, quality tiers, flags)"],
    ["?", "Open this shortcut help"],
    ["F", "Cycle the fleet status filter"],
    ["↑ ↓", "Move through palette results — the preview follows"],
    ["Enter", "Open the highlighted result"],
    ["⌘+Enter", "Pin the highlighted task to the dashboard (palette stays open)"],
    ["1–9", "Quick-select a visible result (when the search box is empty)"],
    ["← →", "Cycle the selected unit in the fleet"],
    ["Esc", "Close one layer: help, palette, time travel, then selection"],
    ["Long-press", "Pin a task from the palette on touch devices"],
  ];
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close shortcuts help"
        className="absolute inset-0 bg-black/70 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="mc-palette relative max-h-[86vh] w-full max-w-md overflow-y-auto border border-[#5cc6da]/25 bg-[#071018] p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <h2
            className="text-sm tracking-[0.22em]"
            style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}
          >
            KEYBOARD SHORTCUTS
          </h2>
          <button
            type="button"
            autoFocus
            aria-label="Close shortcuts help"
            onClick={onClose}
            className="mc-touch flex items-center justify-center rounded border border-white/15 bg-white/5 px-2.5 font-mono text-xs text-[#c7d6ea]"
          >
            ✕
          </button>
        </div>
        <dl className="mt-4 space-y-2.5">
          {rows.map(([key, desc]) => (
            <div key={key} className="flex items-baseline gap-3">
              <dt className="w-28 shrink-0">
                <span className="mc-kbd">{key}</span>
              </dt>
              <dd className="font-mono text-[11px] leading-relaxed text-[#c7d6ea]">
                {desc}
              </dd>
            </div>
          ))}
        </dl>
        <p className="mt-4 font-mono text-[10px] leading-relaxed text-[#5b6b80]">
          The palette navigates and inspects only — it never starts, stops,
          or edits a schedule.
        </p>
      </div>
    </div>
  );
}

/* ---------- redesign pass: Next Up / current task / activity / drawer ---------- */

function NextUpPanel({
  crons,
  codeMap,
  onSelect,
}: {
  crons: CronItem[];
  codeMap: Map<string, string>;
  onSelect: (id: string) => void;
}) {
  const nowMs = useNowMs(1_000);
  const upcoming = useMemo(() => {
    return crons
      .map((c) => ({ c, t: toMs(c.nextRunAt) }))
      .filter((x): x is { c: CronItem; t: number } => x.t !== null && x.t > nowMs)
      .sort((a, b) => a.t - b.t)
      .slice(0, 4);
  }, [crons, nowMs]);
  return (
    <section aria-label="Next up" className="mc-glass mc-fade-in relative p-4">
      <Corners />
      <h2 className="mc-hud-label mc-head">Next Up</h2>
      {upcoming.length === 0 ? (
        <p className="mt-3 font-mono text-xs leading-relaxed text-[#8a9bb0]">
          NO ACTIVE MISSIONS — system ready, waiting for agent activity. Upcoming
          runs appear here the moment the scheduler reports them.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {upcoming.map(({ c, t }, i) => {
            const st = nodeState(c);
            const color = STATE_COLOR[st];
            const hero = i === 0;
            return (
              <li key={c.id}>
                <button
                  type="button"
                  aria-label={`Inspect next up: ${c.title ?? c.id}, runs ${countdownLabel(t, nowMs)}`}
                  onClick={() => onSelect(c.id)}
                  className={`mc-touch flex w-full touch-manipulation items-center gap-3 rounded-lg border px-3 py-2.5 text-left ${
                    hero
                      ? "mc-nextup-hero border-[#5cc6da]/25 bg-[#5cc6da]/[0.05]"
                      : "border-white/[0.06] bg-white/[0.02] hover:bg-white/[0.04]"
                  }`}
                >
                  <span
                    className="flex h-9 min-w-9 shrink-0 items-center justify-center border px-1 font-mono text-[10px] font-semibold"
                    style={{ borderColor: `${color}66`, color, borderRadius: 6 }}
                  >
                    {codeMap.get(c.id) ?? baseCode(c)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate font-medium leading-tight ${hero ? "text-[15px]" : "text-[13px]"}`}>
                      {c.title ?? c.id}
                    </span>
                    <span className="block font-mono text-[9.5px] tabular-nums text-[#5b6b80]">
                      {dhakaClock(t)} Dhaka · {cadencePlain(c.cadence)}
                    </span>
                  </span>
                  <span
                    className={`shrink-0 font-mono tabular-nums ${hero ? "text-base font-semibold" : "text-xs"}`}
                    style={{ color: hero ? "#5cc6da" : color }}
                  >
                    {countdownLabel(t, nowMs)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function CurrentTaskStrip({
  crons,
  onSelect,
}: {
  crons: CronItem[];
  onSelect: (id: string) => void;
}) {
  const running = crons.filter((c) => nodeState(c) === "running");
  const pending = crons.filter((c) => nodeState(c) === "pending");
  const lead = running[0] ?? pending[0] ?? null;
  if (!lead) {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-white/[0.06] bg-white/[0.02] px-4 py-2.5"
      >
        <span className="font-mono text-[9px] tracking-[0.22em] text-[#5b6b80]">CURRENT TASK</span>
        <span className="font-mono text-[11px] text-[#8a9bb0]">
          NO ACTIVE MISSIONS — system ready, waiting for agent activity
        </span>
      </div>
    );
  }
  const isRunning = nodeState(lead) === "running";
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-4 py-2.5"
      style={{
        borderColor: isRunning ? "rgba(92,198,218,0.3)" : "rgba(111,195,216,0.25)",
        background: isRunning ? "rgba(92,198,218,0.06)" : "rgba(111,195,216,0.04)",
      }}
    >
      <span className="font-mono text-[9px] tracking-[0.22em] text-[#5b6b80]">CURRENT TASK</span>
      <button
        type="button"
        aria-label={`Inspect current task ${lead.title ?? lead.id}`}
        onClick={() => onSelect(lead.id)}
        className="mc-touch min-w-0 truncate text-left text-[13px] font-medium text-[#e8eef5] underline decoration-[#5cc6da]/40 underline-offset-4"
      >
        {lead.title ?? lead.id}
      </button>
      <span
        className="flex items-center gap-1.5 font-mono text-[9px] tracking-widest"
        style={{ color: STATE_COLOR[nodeState(lead)] }}
      >
        <StatusIcon state={nodeState(lead)} />
        {isRunning ? "EXECUTING NOW" : "QUEUED — RUNS NEXT"}
      </span>
      {running.length + pending.length > 1 ? (
        <span className="font-mono text-[9px] text-[#5b6b80]">
          +{running.length + pending.length - 1} MORE IN FLIGHT
        </span>
      ) : null}
    </div>
  );
}

type ActivityFilter = "all" | "runs" | "failures" | "status" | "newsflow" | "attention" | "journal";

function ActivityStream({
  timeline,
  journalEntries,
  crons,
  onSelect,
}: {
  timeline: TimelineEvent[];
  journalEntries: AttentionEntry[];
  crons: CronItem[];
  onSelect: (id: string) => void;
}) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const events = useMemo(() => {
    const fromTimeline = timeline.map((e) => ({
      key: e.key,
      at: e.at,
      kind: e.kind as string,
      label: KIND_META[e.kind].label,
      color: KIND_META[e.kind].color,
      text: e.text,
    }));
    const fromJournal = journalEntries.map((j, i) => ({
      key: `journal-${i}`,
      at: "",
      kind: "journal",
      label: "LOG",
      color: "#8a9bb0",
      text: j.text,
    }));
    const merged = [...fromTimeline, ...fromJournal];
    return merged.filter((e) => {
      if (filter === "all") return true;
      if (filter === "runs") return e.kind === "run-ok";
      if (filter === "failures") return e.kind === "run-fail";
      return e.kind === filter;
    });
  }, [timeline, journalEntries, filter]);
  const chips: Array<{ key: ActivityFilter; label: string }> = [
    { key: "all", label: "ALL" },
    { key: "runs", label: "RUNS" },
    { key: "failures", label: "FAILURES" },
    { key: "status", label: "STATUS" },
    { key: "newsflow", label: "NEWSFLOW" },
    { key: "attention", label: "ATTENTION" },
    { key: "journal", label: "JOURNAL" },
  ];
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 px-4 pt-3" role="group" aria-label="Filter activity stream">
        {chips.map((ch) => {
          const on = filter === ch.key;
          return (
            <button
              key={ch.key}
              type="button"
              aria-label={`Show ${ch.label.toLowerCase()} activity`}
              aria-pressed={on}
              onClick={() => setFilter(ch.key)}
              className={`mc-touch touch-manipulation rounded-full border px-3 py-2 font-mono text-[9px] tracking-widest ${
                on
                  ? "border-[#5cc6da]/60 bg-[#5cc6da]/15 text-[#5cc6da]"
                  : "border-white/10 bg-white/[0.03] text-[#8a9bb0]"
              }`}
            >
              {ch.label}
            </button>
          );
        })}
      </div>
      {events.length === 0 ? (
        <p className="px-4 py-10 text-center font-mono text-xs leading-relaxed text-[#8a9bb0]">
          No events in this stream yet — snapshot changes and journal entries
          land here in real time as the fleet works.
        </p>
      ) : (
        <ol className="max-h-[560px] space-y-1 overflow-y-auto px-3 py-3">
          {events.map((e, i) => {
            const match = matchCronForText(e.text, crons);
            return (
              <li key={e.key} className="mc-feed-item" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
                <button
                  type="button"
                  aria-label={match ? `Inspect ${match.title ?? match.id} from activity: ${e.text}` : `Activity event: ${e.text}`}
                  onClick={() => {
                    if (match) onSelect(match.id);
                  }}
                  className="flex w-full touch-manipulation items-baseline gap-3 rounded-md px-2 py-2 text-left hover:bg-white/[0.03]"
                >
                  <span
                    className="w-10 shrink-0 text-center font-mono text-[9px] font-semibold tracking-widest"
                    style={{ color: e.color }}
                  >
                    {e.label}
                  </span>
                  <span className="w-[86px] shrink-0 font-mono text-[10px] tabular-nums text-[#5b6b80]">
                    {e.at ? dhakaStamp(e.at) : "JOURNAL"}
                  </span>
                  <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-[#c7d6ea]">{e.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function AgentDetailDrawer({
  cron,
  code,
  index,
  total,
  runs,
  onClose,
  onStep,
}: {
  cron: CronItem;
  code: string;
  index: number;
  total: number;
  runs: { at: string; st: string | null }[];
  onClose: () => void;
  onStep: (dir: 1 | -1) => void;
}) {
  const nowMs = useNowMs(1_000);
  const st = nodeState(cron);
  return (
    <div className="fixed inset-0 z-[55]" role="dialog" aria-modal="true" aria-label={`Agent detail: ${cron.title ?? cron.id}`}>
      <button
        type="button"
        aria-label="Close agent detail"
        className="mc-backdrop absolute inset-0 bg-black/60 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <section className="mc-drawer mc-depth-4-strong absolute inset-x-0 bottom-0 max-h-[82vh] overflow-y-auto rounded-t-2xl p-5 md:inset-x-auto md:bottom-auto md:right-0 md:top-0 md:h-full md:max-h-none md:w-[400px] md:rounded-none md:rounded-l-2xl">
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-white/15 md:hidden" aria-hidden />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="mc-hud-label">Agent Detail</p>
            <h2 className="mt-1 text-lg leading-tight tracking-wide" style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>
              {(cron.title ?? cron.id).toUpperCase()}
            </h2>
            <p className="truncate font-mono text-[11px] text-[#5b6b80]">
              {code} · {cron.id}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="font-mono text-[10px] text-[#5b6b80]">{index + 1}/{total}</span>
            <button type="button" aria-label="Previous agent" onClick={() => onStep(-1)} className="mc-touch rounded border border-white/15 bg-white/5 px-2.5 font-mono text-[12px] text-[#c7d6ea]">‹</button>
            <button type="button" aria-label="Next agent" onClick={() => onStep(1)} className="mc-touch rounded border border-white/15 bg-white/5 px-2.5 font-mono text-[12px] text-[#c7d6ea]">›</button>
            <button type="button" aria-label="Close agent detail, back to overview" onClick={onClose} className="mc-touch rounded border border-white/15 bg-white/5 px-2.5 font-mono text-[12px] text-[#c7d6ea]">✕</button>
          </div>
        </div>
        <div className="mt-3">{statusBadge(cron)}</div>
        {st === "pending" ? (
          <p className="mt-3 rounded border border-[#6fc3d8]/35 bg-[#6fc3d8]/[0.07] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#a5f3fc]">
            QUEUED — runs next{cron.nextRunAt ? `, fires ${rel(cron.nextRunAt, nowMs)} (${dhakaStamp(cron.nextRunAt)} Dhaka)` : ""}.
          </p>
        ) : null}
        {st === "running" ? (
          <p className="mt-3 rounded border border-[#5cc6da]/40 bg-[#5cc6da]/[0.08] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#cffafe]">
            RUNNING — executing now{cron.lastRunAt ? ` since ~${rel(cron.lastRunAt, nowMs)} (${dhakaStamp(cron.lastRunAt)} Dhaka)` : ""}. Live progress arrives with the next snapshot.
          </p>
        ) : null}
        <p className="mt-3 font-mono text-[11px] leading-relaxed text-[#8a9bb0]">
          Current task: {cron.title ?? cron.id} · {cadencePlain(cron.cadence).toLowerCase()}
          {cron.nextRunAt ? ` · next ${countdownLabel(toMs(cron.nextRunAt), nowMs)}` : ""}
        </p>
        <dl className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded border border-white/8 bg-white/[0.02] p-3">
            <dt className="font-mono text-[10px] tracking-widest text-[#8a9bb0]">SCHEDULE</dt>
            <dd className="mt-1 font-mono text-sm text-[#e6f1ff]">{cadencePlain(cron.cadence)}</dd>
            <dd className="font-mono text-[10px] text-[#5b6b80]">{cron.cadence ?? "—"}</dd>
          </div>
          <div className="rounded border border-white/8 bg-white/[0.02] p-3">
            <dt className="font-mono text-[10px] tracking-widest text-[#8a9bb0]">LAST RESULT</dt>
            <dd className="mt-1 flex items-center gap-2 font-mono text-sm text-[#e6f1ff]">
              {runDot(cron.lastRunStatus)}
              {cron.lastRunStatus ?? "no run yet"}
            </dd>
          </div>
          <div className="rounded border border-white/8 bg-white/[0.02] p-3">
            <dt className="font-mono text-[10px] tracking-widest text-[#8a9bb0]">LAST RUN</dt>
            <dd className="mt-1 font-mono text-sm tabular-nums text-[#e6f1ff]">{rel(cron.lastRunAt, nowMs)}</dd>
            <dd className="font-mono text-[10px] text-[#5b6b80]">{dhakaStamp(cron.lastRunAt)} Dhaka</dd>
          </div>
          <div className="rounded border border-white/8 bg-white/[0.02] p-3">
            <dt className="font-mono text-[10px] tracking-widest text-[#8a9bb0]">NEXT RUN</dt>
            <dd className="mt-1 font-mono text-sm tabular-nums text-[#5cc6da]">{countdownLabel(toMs(cron.nextRunAt), nowMs)}</dd>
            <dd className="font-mono text-[10px] text-[#5b6b80]">{dhakaStamp(cron.nextRunAt)} Dhaka</dd>
          </div>
        </dl>
        <h3 className="mc-hud-label mt-5">Recent outcomes</h3>
        {runs.length === 0 ? (
          <p className="mt-2 font-mono text-xs text-[#8a9bb0]">No runs recorded in recent snapshots.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {runs.map((r) => (
              <li key={r.at} className="flex items-center justify-between rounded border border-white/5 bg-white/[0.02] px-2.5 py-1.5 font-mono text-[11px]">
                <span className="flex items-center gap-2 text-[#c7d6ea]">
                  {runDot(r.st)}
                  {r.st ?? "finished"}
                </span>
                <span className="tabular-nums text-[#5b6b80]">
                  {dhakaStamp(r.at)} · {rel(r.at, nowMs)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ---------- app ---------- */

export function App() {
  const queryClient = useQueryClient();
  // Render-time clock only. The 200ms tick no longer lives here: the
  // header clock, freshness readouts and each stage own isolated
  // tickers (useNowMs), so this tree re-renders on data changes and
  // interaction — not five times a second.
  const nowMs = Date.now();
  const [centerView, setCenterView] = useState<CenterView>("ops");
  /* Evolving system: versioned visual config + adaptive tiers +
     diagnostics. Default config reproduces the pre-pass visuals
     exactly; diagnostics opens only via Ctrl+Shift+D or the palette. */
  const visual = useVisualConfig();
  const [diagOpen, setDiagOpen] = useState(false);
  perfMonitor.recordRender("App");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fleetFilter, setFleetFilter] = useState<FleetFilter>("all");
  const [fleetQuery, setFleetQuery] = useState("");
  /* ----- Pass C state: palette, help, pins, cards, time travel ----- */
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState("");
  const [debQ, setDebQ] = useState("");
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [previewItem, setPreviewItem] = useState<PaletteItem | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pins, setPins] = useState<{ id: string; title: string }[]>([]);
  const [dismissedCards, setDismissedCards] = useState<string[]>([]);
  const [timeTravelAt, setTimeTravelAt] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const recentRef = useRef<Map<string, number>>(new Map());
  const searchBtnRef = useRef<HTMLButtonElement | null>(null);
  const stickyBarRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const stageWrapRef = useRef<HTMLDivElement | null>(null);
  // Parallax is written straight to the layer elements on mousemove
  // (transform only, GPU-friendly) — never through React state.
  const envParallaxRef = useRef<HTMLDivElement | null>(null);

  // Palette re-ranks on a ~200ms debounce; the top result is pre-selected.
  useEffect(() => {
    const t = window.setTimeout(() => setDebQ(paletteQuery), 200);
    return () => window.clearTimeout(t);
  }, [paletteQuery]);
  useEffect(() => {
    setPaletteIndex(0);
  }, [debQ, paletteOpen]);
  useEffect(() => {
    if (paletteOpen) setAnnounce("Command palette open");
  }, [paletteOpen]);

  // Measure the sticky status bar so the mobile filter carousel can
  // stick directly beneath it.
  useEffect(() => {
    const el = stickyBarRef.current;
    const root = rootRef.current;
    if (!el || !root) return;
    const apply = () =>
      root.style.setProperty("--mc-header-h", `${el.offsetHeight}px`);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Stage views: 3D WebGL orbit (default on wide screens), flat 2D orbit
  // (default where the 3D orbit can't fit), and the 24h Timeline.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const stored = window.sessionStorage.getItem("mc-view");
      if (stored === "3d" || stored === "2d" || stored === "timeline" || stored === "activity") return stored;
    } catch {
      /* fall through to the viewport-based default */
    }
    // No stored choice yet: where the complete 3D orbit cannot fit the
    // frame (narrow stage), start on the fitted 2D stage instead — the
    // 3D view stays one tap away in the stage header.
    return typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(max-width: 640px)").matches
      ? "2d"
      : "3d";
  });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const [soundOn, setSoundOn] = useState(false);
  const audioRef = useRef<AudioContext | null>(null);
  // Play the boot sequence once per session; repeat visits go straight
  // to the live wall instead of replaying the 2s intro.
  const [booted, setBooted] = useState<boolean>(() => {
    try {
      return window.sessionStorage.getItem("mc-boot-seen") === "1";
    } catch {
      return false;
    }
  });
  const detailRef = useRef<HTMLElement | null>(null);

  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  useEffect(() => {
    if (booted) return;
    if (reducedMotion) {
      setBooted(true);
      return;
    }
    const t = setTimeout(() => setBooted(true), 1900);
    return () => clearTimeout(t);
  }, [booted, reducedMotion]);

  useEffect(() => {
    if (!booted) return;
    try {
      window.sessionStorage.setItem("mc-boot-seen", "1");
    } catch {
      /* private mode — the boot simply replays next visit */
    }
  }, [booted]);

  // On phone the detail panel sits below the stage: bring it into view
  // when a node is tapped so the tap visibly does something.
  useEffect(() => {
    if (!selectedId) return;
    if (typeof window === "undefined" || window.innerWidth >= 1024) return;
    const t = window.setTimeout(() => {
      detailRef.current?.scrollIntoView({
        behavior: reducedMotion ? "auto" : "smooth",
        block: "start",
      });
    }, 60);
    return () => window.clearTimeout(t);
  }, [selectedId, reducedMotion]);

  const dash = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => measureAction("getDashboard", () => api.getDashboard({})),
    // Poll every 30s while healthy; while the uplink is down (no data
    // yet, or a refresh is failing) probe every 5s so the wall recovers
    // on its own the moment the actions endpoint answers again.
    refetchInterval: (query) => (query.state.status === "error" ? 5_000 : 30_000),
    // Ride out brief endpoint blips (deploys, DB locks) instead of
    // dead-ending on the first failure.
    retry: 5,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 15_000),
    refetchOnWindowFocus: true,
  });

  const journal = useQuery({
    queryKey: ["journal"],
    queryFn: () => measureAction("loadJournal", () => api.loadJournal({})),
    refetchInterval: 60_000,
    retry: 3,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
  });
  const journalEntries = journal.data?.entries ?? [];

  // Improvement verification activity feeds the LEARNING core state.
  // Read-only poll; failure simply means "no learning signal", never an error UI.
  const improvementsForCore = useQuery({
    queryKey: ["improvements-core"],
    queryFn: () => measureAction("listImprovements", () => api.listImprovements({})),
    refetchInterval: 30_000,
    retry: 1,
  });
  const hasLearning =
    (improvementsForCore.data?.items ?? []).some((i) => i.status === "testing") ?? false;

  const resolveMut = useMutation({
    mutationFn: (args: { index: number; targetKey?: string }) =>
      api.resolveAttention(args),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const data: Dashboard | undefined = dash.data;
  const ingestHealth = data?.ingestHealth;
  const dataQuality = data?.dataQuality ?? "ok";
  const degradedRowId = data?.degradedRowId ?? null;
  const isDegraded = dataQuality === "degraded";
  const liveLatest = useMemo(() => asSnapshot(data?.latest), [data]);
  const history = useMemo(
    () =>
      (data?.history ?? [])
        .map(asSnapshot)
        .filter((v): v is Snapshot => v !== null),
    [data],
  );
  const lastGood = history[0] ?? null;
  // When degraded, the newest row is unreadable: latest stays null on
  // the wire and the wall shows the last good snapshot, explicitly
  // labeled — never silently promoted.
  const displayLatest = isDegraded ? lastGood : liveLatest;
  // Time travel (read-only): display a past snapshot from real history
  // while the live wall keeps tracking the newest one underneath.
  const travelSnap = useMemo(
    () =>
      timeTravelAt
        ? (history.find((s) => s.takenAt === timeTravelAt) ?? null)
        : null,
    [history, timeTravelAt],
  );
  const latest = travelSnap ?? displayLatest;

  const takenAtMs = latest?.takenAt ? new Date(latest.takenAt).getTime() : NaN;
  // Render-time staleness for the header chips; the precise ticking
  // "updated Xs ago" readout lives in FreshnessText/FreshnessTrack.
  const ageSec = ageSecAt(
    nowMs,
    takenAtMs,
    ingestHealth?.lastIngestAt ?? null,
    ingestHealth?.ageSec ?? null,
  );
  // Worker pushes every 10 minutes; flag stale only once a full push
  // window (plus grace) has been missed.
  const isStale = ageSec !== null && ageSec > 900;
  const staleLabel =
    ageSec === null
      ? ""
      : ageSec >= 3600
        ? `LAST UPDATE ${Math.floor(ageSec / 3600)}H AGO`
        : `LAST UPDATE ${Math.max(1, Math.round(ageSec / 60))}M AGO`;

  const crons = latest?.crons ?? [];
  const activeCount = crons.filter((c) => nodeState(c) === "active").length;
  const pendingCount = crons.filter((c) => nodeState(c) === "pending").length;
  const runningCount = crons.filter((c) => nodeState(c) === "running").length;
  const failedCount = crons.filter((c) => c.lastRunStatus === "failed").length;
  const standbyCount = crons.filter((c) => nodeState(c) === "disabled").length;
  const attention = latest?.attention ?? [];
  const timeline = useMemo(() => buildTimeline(history), [history]);
  const onlinePct = crons.length > 0 ? (activeCount + runningCount) / crons.length : 0;

  const sortedCrons = useMemo(() => {
    const score = (c: CronItem) => {
      const st = nodeState(c);
      if (st === "failed") return 0;
      if (st === "running") return 1;
      if (st === "pending") return 2;
      if (st === "active") return 3;
      if (st === "paused") return 4;
      return 5;
    };
    return [...crons].sort(
      (a, b) =>
        score(a) - score(b) ||
        (a.title ?? a.id).localeCompare(b.title ?? b.id),
    );
  }, [crons]);

  const selectedCron = useMemo(
    () => crons.find((c) => c.id === selectedId) ?? null,
    [crons, selectedId],
  );

  const codeMap = useMemo(() => buildCodeMap(crons), [crons]);

  // The next unit to fire: soonest future nextRunAt across the fleet.
  const nextUp = useMemo(() => {
    let best: CronItem | null = null;
    let bestT = Number.POSITIVE_INFINITY;
    for (const c of crons) {
      if (!c.nextRunAt) continue;
      const t = new Date(c.nextRunAt).getTime();
      if (Number.isNaN(t) || t <= nowMs) continue;
      if (t < bestT) {
        bestT = t;
        best = c;
      }
    }
    return best;
  }, [crons, nowMs]);

  /* ----- 3D stage data + sound cues ----- */

  const sceneNodes = useMemo<SceneNode[]>(
    () =>
      sortedCrons.map((c) => ({
        id: c.id,
        code: codeMap.get(c.id) ?? baseCode(c),
        title: c.title ?? c.id,
        state: nodeState(c),
        isNext: c.id === nextUp?.id,
        cadenceMs: cadenceIntervalMs(c.cadence),
        lastRunMs: toMs(c.lastRunAt),
        nextRunMs: toMs(c.nextRunAt),
      })),
    [sortedCrons, codeMap, nextUp],
  );

  // Snapshot identity: changes exactly when the worker pushes fresh data.
  const snapshotKey = latest?.takenAt ?? null;
  // The ingest watch always tracks the LIVE snapshot, even while the
  // wall is time-travelling through history.
  const liveKey = liveLatest?.takenAt ?? null;
  const liveCrons = liveLatest?.crons ?? [];

  /* ----- cross-snapshot watch (ingest flash + status-flip toast) ----- */

  const seenSnapKeyRef = useRef<string | null>(null);
  const prevCronStatesRef = useRef<Map<string, NodeState> | null>(null);
  const toastSeqRef = useRef(0);
  const [flashNonce, setFlashNonce] = useState(0);
  const [toast, setToast] = useState<StatusToast | null>(null);

  useEffect(() => {
    if (!liveKey) return;
    const seenKey = seenSnapKeyRef.current;
    if (seenKey === liveKey) return;
    seenSnapKeyRef.current = liveKey;
    const curr = new Map<string, NodeState>();
    for (const c of liveCrons) curr.set(c.id, nodeState(c));
    const prev = prevCronStatesRef.current;
    prevCronStatesRef.current = curr;
    // First snapshot this session: seed the baseline only — never toast
    // the wall's initial state.
    if (seenKey === null || !prev || prev.size === 0) return;
    // A fresh snapshot landed: gentle status-bar flash (the core/beam
    // pulse rides the same key through the stage).
    setFlashNonce((n) => n + 1);
    // Notable flips only: a unit newly failed, or a queued unit that
    // just started running. Routine ingests with no flips stay silent.
    const flips: { cron: CronItem; from: NodeState; to: NodeState }[] = [];
    for (const c of liveCrons) {
      const from = prev.get(c.id);
      const to = nodeState(c);
      if (!from || from === to) continue;
      if (to === "failed" || (from === "pending" && to === "running")) {
        flips.push({ cron: c, from, to });
      }
    }
    if (flips.length === 0) return;
    flips.sort((a, b) => (b.to === "failed" ? 1 : 0) - (a.to === "failed" ? 1 : 0));
    const top = flips[0];
    if (!top) return;
    toastSeqRef.current += 1;
    setToast({
      id: toastSeqRef.current,
      title: top.cron.title ?? top.cron.id,
      message: top.to === "failed" ? "last run failed" : "started running",
      tone: top.to === "failed" ? "danger" : "info",
      cronId: top.cron.id,
      extra: flips.length - 1,
    });
  }, [liveKey, liveCrons]);

  // Toasts are short-lived: one at a time, auto-dismissed after ~6s.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);
  const show3d = viewMode === "3d" && !webglFailed;

  // AI core state — truthful mapping only (see deriveCoreState).
  // Until the first snapshot exists this is NO_SIGNAL (a
  // non-operational presentation, not one of the six states); the 3D
  // scene receives a SceneNodeState tint, while the 2D core and the
  // health-strip chip render the full label + motion class.
  const aiCoreState = useMemo<CoreVisual>(
    () =>
      deriveCoreState({
        newsflowStatus: latest?.newsflow?.status,
        newsflowWarnings: latest?.newsflow?.warnings,
        crons,
        hasLearning,
        hasSnapshot: latest != null,
      }),
    [latest, crons, hasLearning],
  );
  const coreMeta = CORE_META[aiCoreState];
  const coreSceneState = useMemo<NodeState>(() => {
    // Map the six-state core onto the 3D scene's node palette without
    // inventing new geometry: ERROR→failed, EXECUTING→running,
    // THINKING→pending, LEARNING→active (violet tint is applied via
    // the core label + glow overlay), WAITING→paused, ONLINE→active.
    // NO SIGNAL has no signal at all → the scene's dimmest node state.
    if (aiCoreState === "NO_SIGNAL") return "disabled";
    if (aiCoreState === "ERROR") return "failed";
    if (aiCoreState === "EXECUTING") return "running";
    if (aiCoreState === "THINKING") return "pending";
    if (aiCoreState === "WAITING") return "paused";
    return "active";
  }, [aiCoreState]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem("mc-view", viewMode);
    } catch {
      /* private mode — the choice simply doesn't persist */
    }
  }, [viewMode]);

  const blip = (freq: number, delay = 0, dur = 0.08) => {
    if (!soundOn) return;
    try {
      if (!audioRef.current) {
        const AC =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return;
        audioRef.current = new AC();
      }
      const ctx = audioRef.current;
      if (ctx.state === "suspended") void ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      const t0 = ctx.currentTime + delay;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.035, t0 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    } catch {
      /* audio is garnish — never let it break selection */
    }
  };

  const prevFailedCount = useRef<number | null>(null);
  useEffect(() => {
    if (prevFailedCount.current !== null && failedCount > prevFailedCount.current && soundOn) {
      blip(196, 0, 0.1);
      blip(147, 0.13, 0.14);
    }
    prevFailedCount.current = failedCount;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failedCount, soundOn]);

  const handleSelect = (id: string | null) => {
    setSelectedId(id);
    if (id) recentRef.current.set(id, Date.now());
    if (!soundOn) return;
    if (id === null) {
      blip(392, 0, 0.06);
      return;
    }
    const c = crons.find((x) => x.id === id);
    if (!c) return;
    const st = nodeState(c);
    blip(
      st === "failed"
        ? 180
        : st === "paused"
          ? 520
          : st === "running"
            ? 1180
            : st === "pending"
              ? 660
              : st === "active"
                ? 880
                : 330,
      0,
      0.07,
    );
  };

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    if (next) {
      // Prime the context inside the tap gesture, then confirm audibly.
      try {
        if (!audioRef.current) {
          const AC =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          if (AC) audioRef.current = new AC();
        }
        if (audioRef.current?.state === "suspended") void audioRef.current.resume();
        const ctx = audioRef.current;
        if (ctx) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = "square";
          osc.frequency.value = 880;
          gain.gain.setValueAtTime(0.0001, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.035, ctx.currentTime + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.09);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start();
          osc.stop(ctx.currentTime + 0.12);
        }
      } catch {
        /* toggle still flips; blips just stay silent */
      }
    }
  };

  /* ----- Pass C actions: palette, pins, filters, time travel ----- */

  const closePalette = () => {
    setPaletteOpen(false);
    setPaletteQuery("");
    window.setTimeout(() => searchBtnRef.current?.focus(), 30);
  };

  const scrollToId = (id: string) => {
    document.getElementById(id)?.scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "start",
    });
  };

  const pinTask = (c: CronItem) => {
    setPins((prev) =>
      prev.some((p) => p.id === c.id)
        ? prev
        : [...prev, { id: c.id, title: c.title ?? c.id }],
    );
    setAnnounce(`Pinned ${c.title ?? c.id} to the dashboard`);
  };

  const copyText = (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text);
        setAnnounce("Copied task ID");
        return;
      }
      throw new Error("clipboard unavailable");
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setAnnounce("Copied task ID");
      } catch {
        setAnnounce("Copy failed — the task ID is in the detail card");
      }
      ta.remove();
    }
  };

  // Keyboard: ⌘K/Ctrl+K toggles the palette; Esc unwinds exactly one
  // layer (help → palette → time travel → center → selection); "?" opens help;
  // "f" cycles the fleet filters; 1/2/3 switch stage views, 4/5 open the
  // Reliability / Improvement centers; arrows cycle the
  // fleet. The palette dialog handles its own keys while open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        setDiagOpen((o) => !o);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setHelpOpen(false);
        setPaletteOpen((o) => !o);
        return;
      }
      if (paletteOpen) return;
      if (diagOpen) return;
      if (e.key === "Escape") {
        if (helpOpen) {
          setHelpOpen(false);
          return;
        }
        if (travelSnap) {
          setTimeTravelAt(null);
          setAnnounce("Back to live data");
          return;
        }
        if (centerView !== "ops") {
          setCenterView("ops");
          setAnnounce("Back to operations");
          return;
        }
        if (selectedId) setSelectedId(null);
        return;
      }
      if (helpOpen) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (target?.isContentEditable ?? false)
      ) {
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen(true);
        return;
      }
      if (e.key === "f" || e.key === "F") {
        e.preventDefault();
        const idx = FILTER_ORDER.indexOf(fleetFilter);
        const next = FILTER_ORDER[(idx + 1) % FILTER_ORDER.length] ?? "all";
        setFleetFilter(next);
        setAnnounce(`Fleet filter: ${next}`);
        return;
      }
      if (
        (e.key === "1" || e.key === "2" || e.key === "3" || e.key === "6") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        setCenterView("ops");
        setViewMode(
          e.key === "1" ? "3d" : e.key === "2" ? "2d" : e.key === "3" ? "timeline" : "activity",
        );
        return;
      }
      if (
        (e.key === "4" || e.key === "5") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        setCenterView(e.key === "4" ? "reliability" : "improvements");
        return;
      }
      if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && sortedCrons.length > 0) {
        const idx = sortedCrons.findIndex((c) => c.id === selectedId);
        const dir = e.key === "ArrowRight" ? 1 : -1;
        const nextIdx =
          idx < 0
            ? dir === 1
              ? 0
              : sortedCrons.length - 1
            : (idx + dir + sortedCrons.length) % sortedCrons.length;
        const next = sortedCrons[nextIdx];
        if (next) setSelectedId(next.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, sortedCrons, paletteOpen, helpOpen, travelSnap, fleetFilter, centerView, diagOpen]);

  const issueCount = useMemo(
    () => crons.filter((c) => c.lastRunStatus === "failed" || c.status === "paused").length,
    [crons],
  );
  const pausedCount = crons.filter((c) => nodeState(c) === "paused").length;
  const disabledCount = crons.filter((c) => nodeState(c) === "disabled").length;

  const visibleFleet = useMemo(() => {
    const q = fleetQuery.trim().toLowerCase();
    const byFilter = (() => {
      if (fleetFilter === "all") return sortedCrons;
      return sortedCrons.filter((c) => {
        const st = nodeState(c);
        if (fleetFilter === "active") return st === "active";
        if (fleetFilter === "pending") return st === "pending";
        if (fleetFilter === "running") return st === "running";
        if (fleetFilter === "paused") return st === "paused";
        if (fleetFilter === "failed") return st === "failed";
        if (fleetFilter === "disabled") return st === "disabled";
        if (fleetFilter === "issues") return st === "failed" || st === "paused";
        return st === "disabled";
      });
    })();
    if (!q) return byFilter;
    return byFilter.filter(
      (c) =>
        (c.title ?? "").toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        (codeMap.get(c.id) ?? "").toLowerCase().includes(q),
    );
  }, [sortedCrons, fleetFilter, fleetQuery, codeMap]);

  /* ----- command palette data: real snapshot content only ----- */

  function buildPaletteItems(): {
    groups: { name: PaletteGroupName; items: PaletteItem[] }[];
    flat: PaletteItem[];
  } {
    const q = debQ;
    const nav: PaletteItem[] = [];
    const insp: PaletteItem[] = [];
    const filt: PaletteItem[] = [];
    const trav: PaletteItem[] = [];
    const recentBoost = (id: string) => {
      const t = recentRef.current.get(id);
      return t != null && nowMs - t < 30_000;
    };

    // Tasks — static ranking: failed, running, pending, paused, active,
    // disabled; a task viewed in the last 30s floats to the top.
    const scored: { item: PaletteItem; score: number }[] = [];
    for (const c of crons) {
      const st = nodeState(c);
      const text = `${c.title ?? ""} ${c.id} ${codeMap.get(c.id) ?? ""} ${STATE_LABEL[st]}`;
      const score = fuzzyScore(q, text);
      if (score < 0) continue;
      scored.push({
        score,
        item: {
          key: `task-${c.id}`,
          group: "Navigation",
          kind: "task",
          title: c.title ?? c.id,
          sub: `${cadencePlain(c.cadence)} · ${
            st === "running"
              ? "RUNNING NOW"
              : st === "pending"
                ? `QUEUED ${countdownLabel(toMs(c.nextRunAt), nowMs).toUpperCase()}`
                : countdownLabel(toMs(c.nextRunAt), nowMs).toUpperCase()
          }`,
          searchText: text,
          cron: c,
          state: st,
          recent: recentBoost(c.id),
          run: () => {
            handleSelect(c.id);
            closePalette();
            setAnnounce(`Jumped to ${c.title ?? c.id}`);
          },
        },
      });
    }
    scored.sort((a, b) => {
      const ra = a.item.recent ? -1 : STATE_RANK[a.item.state ?? "disabled"];
      const rb = b.item.recent ? -1 : STATE_RANK[b.item.state ?? "disabled"];
      return ra - rb || b.score - a.score || a.item.title.localeCompare(b.item.title);
    });
    const shownTasks = scored.slice(0, q ? 8 : 5).map((s) => s.item);
    nav.push(...shownTasks);

    // Views + jumps
    const viewDefs: { key: string; title: string; mode: ViewMode; text: string }[] = [
      { key: "view-3d", title: "Go to 3D orbit", mode: "3d", text: "go to 3d orbit view stage" },
      { key: "view-2d", title: "Go to 2D orbit", mode: "2d", text: "go to 2d orbit view stage" },
      { key: "view-tl", title: "Go to 24H timeline", mode: "timeline", text: "go to timeline 24h view schedule" },
      { key: "view-act", title: "Go to Activity stream", mode: "activity", text: "go to activity stream feed events journal live" },
    ];
    for (const v of viewDefs) {
      if (fuzzyScore(q, `${v.title} ${v.text}`) < 0) continue;
      nav.push({
        key: v.key,
        group: "Navigation",
        kind: "view",
        title: v.title,
        sub: viewMode === v.mode ? "Current view" : "Switch stage view",
        searchText: v.text,
        run: () => {
          setCenterView("ops");
          setViewMode(v.mode);
          closePalette();
          setAnnounce(v.title);
        },
      });
    }
    const jumpDefs: { key: string; title: string; el: string; text: string }[] = [
      { key: "jump-fleet", title: "Go to fleet list", el: "fleet-panel", text: "go to fleet list schedules units" },
      { key: "jump-attention", title: "Go to attention", el: "attention-panel", text: "go to attention alerts cards" },
      { key: "jump-activity", title: "Go to activity log", el: "activity-log", text: "go to activity log signal feed" },
      { key: "jump-journal", title: "Go to journal", el: "journal", text: "go to journal durable log" },
    ];
    const centerDefs: {
      key: string;
      title: string;
      center: CenterView;
      text: string;
    }[] = [
      {
        key: "center-reliability",
        title: "Go to Reliability Center",
        center: "reliability",
        text: "go to reliability center failed overdue recovered",
      },
      {
        key: "center-improvements",
        title: "Go to Improvement Center",
        center: "improvements",
        text: "go to improvement center propose verified lifecycle",
      },
    ];
    for (const cd of centerDefs) {
      if (fuzzyScore(q, `${cd.title} ${cd.text}`) < 0) continue;
      nav.push({
        key: cd.key,
        group: "Navigation",
        kind: "view",
        title: cd.title,
        sub: centerView === cd.center ? "Current section" : "Switch dashboard section",
        searchText: cd.text,
        run: () => {
          setCenterView(cd.center);
          closePalette();
          setAnnounce(cd.title);
        },
      });
    }
    for (const j of jumpDefs) {
      if (fuzzyScore(q, `${j.title} ${j.text}`) < 0) continue;
      nav.push({
        key: j.key,
        group: "Navigation",
        kind: "view",
        title: j.title,
        sub: "Scroll into view",
        searchText: j.text,
        run: () => {
          setCenterView("ops");
          closePalette();
          window.setTimeout(() => scrollToId(j.el), 60);
        },
      });
    }

    // Attention items — jump to the linked schedule, or to the panel.
    attention.forEach((a, i) => {
      if (!q && a.severity !== "action") return;
      const text = `${a.text} attention alert ${a.severity}`;
      if (fuzzyScore(q, text) < 0) return;
      const c = matchCronForText(a.text, crons);
      nav.push({
        key: `patt-${i}`,
        group: "Navigation",
        kind: "attention",
        title: a.text.length > 64 ? `${a.text.slice(0, 64)}…` : a.text,
        sub: c
          ? `Attention · ${a.severity.toUpperCase()} · linked to ${c.title ?? c.id}`
          : `Attention · ${a.severity.toUpperCase()}`,
        searchText: text,
        cron: c ?? undefined,
        state: c ? nodeState(c) : undefined,
        run: () => {
          if (c) handleSelect(c.id);
          else scrollToId("attention-panel");
          closePalette();
        },
      });
    });

    nav.push({
      key: "help",
      group: "Navigation",
      kind: "help",
      title: "Keyboard shortcuts",
      sub: "Open the shortcut help overlay",
      searchText: "keyboard shortcuts help keys",
      run: () => {
        closePalette();
        setHelpOpen(true);
      },
    });
    nav.push({
      key: "diagnostics",
      group: "Navigation",
      kind: "help",
      title: "System diagnostics",
      sub: "Performance, quality tiers, feature flags (Ctrl+Shift+D)",
      searchText: "system diagnostics performance fps quality tier flags visual config rollback auditor",
      run: () => {
        closePalette();
        setDiagOpen(true);
      },
    });

    // Inspection — read-only details, copy, export. Never mutates.
    for (const t of shownTasks.slice(0, 3)) {
      const c = t.cron;
      if (!c) continue;
      insp.push({
        key: `copy-${c.id}`,
        group: "Inspection",
        kind: "copy",
        title: `Copy task ID · ${c.title ?? c.id}`,
        sub: c.id,
        searchText: `copy task id ${c.title ?? ""} ${c.id}`,
        cron: c,
        state: nodeState(c),
        run: () => {
          copyText(c.id);
          closePalette();
        },
      });
      insp.push({
        key: `runs-${c.id}`,
        group: "Inspection",
        kind: "export",
        title: `Export runs CSV · ${c.title ?? c.id}`,
        sub: "Download this unit's recent runs",
        searchText: `export runs csv download ${c.title ?? ""} ${c.id}`,
        cron: c,
        state: nodeState(c),
        run: () => {
          downloadCsv(`runs-${c.id}.csv`, [
            ["run_time_dhaka", "status"],
            ...runsFor(history, c.id, 12).map((r) => [
              dhakaStamp(r.at),
              r.st ?? "",
            ]),
          ]);
          setAnnounce(`Exported runs for ${c.title ?? c.id}`);
          closePalette();
        },
      });
    }
    if (fuzzyScore(q, "export activity log csv download") >= 0) {
      insp.push({
        key: "export-activity",
        group: "Inspection",
        kind: "export",
        title: "Export activity log CSV",
        sub: `${timeline.length} events from snapshot history`,
        searchText: "export activity log csv download",
        run: () => {
          downloadCsv("mission-control-activity.csv", [
            ["time_dhaka", "kind", "event"],
            ...timeline.map((e) => [
              dhakaStamp(e.at),
              KIND_META[e.kind].label,
              e.text,
            ]),
          ]);
          setAnnounce("Exported activity log CSV");
          closePalette();
        },
      });
    }

    // Filters — session-scoped and reversible.
    const filterDefs: { key: FleetFilter; label: string; text: string }[] = [
      { key: "all", label: "Show all schedules", text: "show all schedules filter" },
      { key: "failed", label: "Show failed", text: "show failed filter issues" },
      { key: "issues", label: "Show issues (failed + paused)", text: "show issues failed paused filter" },
      { key: "running", label: "Show running", text: "show running filter" },
      { key: "pending", label: "Show pending", text: "show pending filter queued" },
      { key: "paused", label: "Show paused", text: "show paused filter standby amber" },
      { key: "disabled", label: "Show disabled", text: "show disabled filter off gray" },
      { key: "active", label: "Show active", text: "show active filter" },
      { key: "standby", label: "Show standby / disabled", text: "show standby disabled filter" },
    ];
    for (const f of filterDefs) {
      if (fuzzyScore(q, `${f.label} ${f.text}`) < 0) continue;
      filt.push({
        key: `filter-${f.key}`,
        group: "Filters",
        kind: "filter",
        title: f.label,
        sub: fleetFilter === f.key ? "Current fleet filter" : "Filter the fleet list",
        searchText: f.text,
        run: () => {
          setFleetFilter(f.key);
          scrollToId("fleet-panel");
          closePalette();
          setAnnounce(f.label);
        },
      });
    }
    if (fuzzyScore(q, "toggle sound mute audio beep") >= 0) {
      filt.push({
        key: "sound",
        group: "Filters",
        kind: "sound",
        title: soundOn ? "Toggle sound off" : "Toggle sound on",
        sub: `Interface sounds are ${soundOn ? "ON" : "OFF"}`,
        searchText: "toggle sound mute audio beep",
        run: () => {
          toggleSound();
          closePalette();
        },
      });
    }

    // Time travel — only offsets a real history snapshot can answer.
    if (travelSnap) {
      trav.push({
        key: "tt-exit",
        group: "Time Travel",
        kind: "timetravel",
        title: "Back to live",
        sub: `Currently viewing ${dhakaStamp(travelSnap.takenAt)} Dhaka`,
        searchText: "exit time travel back to live now",
        run: () => {
          setTimeTravelAt(null);
          closePalette();
          setAnnounce("Back to live data");
        },
      });
    }
    for (const off of [10, 30, 60, 120]) {
      const target = nowMs - off * 60_000;
      const cand = history.find((s) => {
        const t = toMs(s.takenAt);
        return t != null && t <= target && target - t <= 20 * 60_000;
      });
      if (!cand || !cand.takenAt || cand.takenAt === liveLatest?.takenAt)
        continue;
      if (travelSnap && cand.takenAt === travelSnap.takenAt) continue;
      const candAt = cand.takenAt;
      trav.push({
        key: `tt-${off}`,
        group: "Time Travel",
        kind: "timetravel",
        title: `Timeline: ${off} minutes ago`,
        sub: `Snapshot ${dhakaStamp(candAt)} Dhaka · read-only`,
        searchText: `time travel ${off} minutes ago timeline past history`,
        run: () => {
          setTimeTravelAt(candAt);
          setViewMode("timeline");
          closePalette();
          setAnnounce(`Viewing snapshot from ${dhakaStamp(candAt)} Dhaka`);
        },
      });
    }

    const groups = (
      [
        ["Navigation", nav],
        ["Inspection", insp],
        ["Filters", filt],
        ["Time Travel", trav],
      ] as [PaletteGroupName, PaletteItem[]][]
    )
      .filter(([, items]) => items.length > 0)
      .map(([name, items]) => ({ name, items }));
    return { groups, flat: groups.flatMap((g) => g.items) };
  }

  const paletteData = buildPaletteItems();
  const paletteGroups = paletteData.groups;
  const paletteFlat = paletteData.flat;
  const activePaletteKey = paletteFlat[paletteIndex]?.key ?? null;

  // Highlight → preview after a 200ms debounce (non-destructive).
  useEffect(() => {
    if (!paletteOpen) {
      setPreviewItem(null);
      return;
    }
    const item =
      paletteFlat.find((p) => p.key === activePaletteKey) ?? null;
    const t = window.setTimeout(() => setPreviewItem(item), 200);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen, activePaletteKey]);

  useEffect(() => {
    if (paletteIndex > 0 && paletteIndex >= paletteFlat.length) {
      setPaletteIndex(Math.max(0, paletteFlat.length - 1));
    }
  }, [paletteFlat.length, paletteIndex]);

  useEffect(() => {
    if (!previewItem) return;
    setAnnounce(
      previewItem.state
        ? `${previewItem.title} — ${STATE_LABEL[previewItem.state]}`
        : previewItem.title,
    );
  }, [previewItem]);

  const handlePalettePick = (item: PaletteItem, pin: boolean) => {
    if (pin) {
      if (item.cron) pinTask(item.cron);
      return;
    }
    item.run();
  };

  const previewRuns = useMemo(
    () => (previewItem?.cron ? runsFor(history, previewItem.cron.id, 10) : []),
    [history, previewItem],
  );
  const previewLogs = useMemo(() => {
    const c = previewItem?.cron;
    if (!c) return [];
    const title = c.title ?? c.id;
    return timeline
      .filter((e) => e.text.includes(title) || e.text.includes(c.id))
      .slice(0, 3)
      .map((e) => `${dhakaStamp(e.at)} — ${e.text}`);
  }, [timeline, previewItem]);

  // Keep the active fleet filter chip in view on small screens.
  useEffect(() => {
    if (typeof window === "undefined" || window.innerWidth >= 1024) return;
    document
      .querySelector<HTMLElement>("[data-mc-filter-active='true']")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [fleetFilter]);

  /* ----- narrative attention cards ----- */
  const attentionView = buildAttentionCards(attention, crons, history, nowMs);
  const visibleCards = attentionView.cards.filter(
    (cd) => !dismissedCards.includes(cd.key),
  );
  const attentionOpenCount = visibleCards.length + attentionView.quiet.length;

  const selectedIndex = useMemo(
    () => sortedCrons.findIndex((c) => c.id === selectedId),
    [sortedCrons, selectedId],
  );

  const stepSelection = (dir: 1 | -1) => {
    if (sortedCrons.length === 0) return;
    const idx = selectedIndex;
    const nextIdx =
      idx < 0
        ? dir === 1
          ? 0
          : sortedCrons.length - 1
        : (idx + dir + sortedCrons.length) % sortedCrons.length;
    const next = sortedCrons[nextIdx];
    if (next) handleSelect(next.id);
  };


  const selectedRuns = useMemo(() => {
    if (!selectedCron) return [];
    const seen = new Map<string, string | null>();
    for (const s of history) {
      const c = (s.crons ?? []).find((x) => x.id === selectedCron.id);
      if (c?.lastRunAt && !seen.has(c.lastRunAt)) {
        seen.set(c.lastRunAt, c.lastRunStatus ?? null);
      }
    }
    return [...seen.entries()]
      .slice(0, 5)
      .map(([at, st]) => ({ at, st }));
  }, [history, selectedCron]);

  const nf = latest?.newsflow;

  // The fitted 2D stage renders instantly; the 3D scene swaps in as its
  // chunk (three.js) arrives — and it doubles as the WebGL fallback.
  const orbitalStage = (
    <OrbitalStage
      crons={sortedCrons}
      codeMap={codeMap}
      selectedId={selectedCron?.id ?? null}
      nextId={nextUp?.id ?? null}
      onSelect={handleSelect}
      coreLabel={aiCoreState}
      coreVisual={aiCoreState}
      animate={!reducedMotion}
      hoverId={hoverId}
      onHoverNode={setHoverId}
      pulseKey={snapshotKey}
    />
  );

  return (
    <div
      ref={rootRef}
      className="mc-root relative min-h-screen"
      style={{ background: "var(--depth-0-bg)", color: "var(--text)" }}
      onMouseMove={(e) => {
        if (reducedMotion) return;
        const el = stageWrapRef.current;
        const env = envParallaxRef.current;
        if (!el && !env) return;
        const r = (el ?? env)?.getBoundingClientRect();
        if (!r) return;
        const nx = Math.max(
          -1,
          Math.min(1, (e.clientX - r.left) / Math.max(1, r.width) - 0.5),
        );
        const ny = Math.max(
          -1,
          Math.min(1, (e.clientY - r.top) / Math.max(1, r.height) - 0.5),
        );
        // Transform-only writes straight to the layers (the CSS
        // transition on .mc-parallax-layer smooths them); no React
        // re-render is involved in pointer motion.
        if (env) env.style.transform = `translate3d(${nx * 6}px, ${ny * 4}px, 0)`;
        if (el) el.style.transform = `translate3d(${nx * 3}px, ${ny * 2}px, 0)`;
      }}
      onMouseLeave={() => {
        if (envParallaxRef.current) envParallaxRef.current.style.transform = "";
        if (stageWrapRef.current) stageWrapRef.current.style.transform = "";
      }}
    >
      {/* Depth 1–2 environment: ambient glow + quiet technical grid + vignette/fog.
          Purely atmospheric; all motion is transform/opacity and collapses
          under prefers-reduced-motion. */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden>
        <div className="mc-env-glow absolute inset-0" />
        <div className="mc-env-grid absolute inset-0 opacity-70" />
        <div ref={envParallaxRef} className="mc-parallax-layer absolute inset-0">
          {/* faint drifting particles — CSS only, GPU-cheap */}
          {[
            { l: "10%", t: "74%", s: 2.5, d: "30s", x: "14px", delay: "0s" },
            { l: "38%", t: "84%", s: 2, d: "34s", x: "-10px", delay: "-12s" },
            { l: "66%", t: "78%", s: 2.5, d: "31s", x: "10px", delay: "-6s" },
            { l: "88%", t: "88%", s: 2, d: "36s", x: "-12px", delay: "-20s" },
          ].map((p, i) => (
            <span
              key={i}
              className="mc-particle"
              style={
                {
                  left: p.l,
                  top: p.t,
                  width: p.s,
                  height: p.s,
                  animationDuration: p.d,
                  animationDelay: p.delay,
                  "--drift-x": p.x,
                } as CSSProperties
              }
            />
          ))}
        </div>
        <div className="mc-env-vignette absolute inset-0" />
        <div className="mc-env-fog absolute inset-x-0 bottom-0 h-[38vh]" />
      </div>
      {/* CRT layer */}
      <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden" aria-hidden>
        <div className="mc-scanlines absolute inset-0" />
        <div className="mc-scanbar absolute inset-x-0 top-0" />
      </div>
      {!booted ? <BootOverlay /> : null}

      {/* Left icon rail (desktop): real navigation only — every item
          switches a real view or scrolls to a real panel. */}
      <nav
        aria-label="Primary"
        className="fixed bottom-0 left-0 top-0 z-30 hidden w-[76px] flex-col items-center gap-1 border-r border-white/[0.06] bg-[#05080d]/92 py-4 backdrop-blur-md lg:flex"
      >
        {(
          [
            { key: "ops", label: "OPS", glyph: "⌂", active: centerView === "ops" && viewMode !== "activity" && viewMode !== "timeline", run: () => { setCenterView("ops"); setViewMode("3d"); } },
            { key: "activity", label: "ACTIVITY", glyph: "≋", active: centerView === "ops" && viewMode === "activity", run: () => { setCenterView("ops"); setViewMode("activity"); } },
            { key: "timeline", label: "24H", glyph: "◷", active: centerView === "ops" && viewMode === "timeline", run: () => { setCenterView("ops"); setViewMode("timeline"); } },
            { key: "reliability", label: "RELIAB.", glyph: "✓", active: centerView === "reliability", run: () => setCenterView("reliability") },
            { key: "improve", label: "IMPROVE", glyph: "✦", active: centerView === "improvements", run: () => setCenterView("improvements") },
            { key: "fleet", label: "FLEET", glyph: "▦", active: false, run: () => { setCenterView("ops"); scrollToId("fleet-panel"); } },
            { key: "journal", label: "LOGS", glyph: "≡", active: false, run: () => { setCenterView("ops"); scrollToId("journal"); } },
          ] as Array<{ key: string; label: string; glyph: string; active: boolean; run: () => void }>
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            aria-label={`Open ${item.label.toLowerCase()}`}
            aria-pressed={item.active}
            onClick={item.run}
            className={`mc-touch flex w-14 flex-col items-center justify-center gap-0.5 rounded-lg border py-2 font-mono ${
              item.active
                ? "border-[#5cc6da]/45 bg-[#5cc6da]/12 text-[#5cc6da]"
                : "border-transparent text-[#7d8fa3] hover:bg-white/[0.04] hover:text-[#c7d6ea]"
            }`}
          >
            <span aria-hidden className="text-base leading-none">{item.glyph}</span>
            <span className="text-[7.5px] tracking-[0.14em]">{item.label}</span>
          </button>
        ))}
        <div className="mt-auto w-14 rounded-lg border border-[#5cc6da]/20 bg-[#5cc6da]/[0.05] px-2 py-2.5 text-center">
          <p className="font-mono text-[8px] font-semibold tracking-[0.18em] text-[#5cc6da]">AI CORE</p>
          <p className="mt-1 font-mono text-[7.5px] leading-relaxed text-[#7d8fa3]">
            {crons.length} AGENTS
            <br />
            ON WATCH
          </p>
        </div>
        <p className="mt-2 font-mono text-[7px] tracking-[0.2em] text-[#3d4c61]">MC 3.0</p>
      </nav>

      <div className="relative z-10 mx-auto w-full max-w-[1440px] px-3 pb-10 sm:px-5 lg:pl-[92px]">
        {/* Sticky status bar: clock + freshness stay in reach while scrolling */}
        <div ref={stickyBarRef} className="sticky top-0 z-30 -mx-3 bg-[#05080d]/88 px-3 pb-3 pt-4 backdrop-blur-md sm:-mx-5 sm:px-5">
        {/* Topbar — one clear eye path: title + core state first, counters demoted */}
        <header className="mc-fade-in flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
          <div className="flex items-center gap-3">
            <span className="mc-live-dot h-2 w-2 rounded-full bg-[#5cc6da]" aria-hidden />
            <div className="min-w-0">
              <h1
                className="truncate text-[15px] tracking-[0.14em] text-[#e8eef5] sm:text-lg"
                style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
              >
                MISSION CONTROL
              </h1>
              <p className="hidden font-mono text-[8.5px] tracking-[0.28em] text-[#5b6b80] sm:block">
                AUTONOMOUS AGENT OPERATIONS
              </p>
            </div>
            <span
              aria-label={isStale || isDegraded ? "Live indicator dimmed — data is not live" : "Live"}
              className={`rounded border px-1.5 py-0.5 font-mono text-[10px] tracking-widest ${
                isStale || isDegraded
                  ? "border-white/10 bg-white/[0.03] text-[#5b6b80] opacity-50"
                  : "border-[#5cc6da]/30 bg-[#5cc6da]/10 text-[#5cc6da]"
              }`}
            >
              LIVE
            </span>
            {isStale && (
              <span className="tabular-nums rounded border border-[#e8a84d]/45 bg-[#e8a84d]/10 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-[#e8a84d]">
                STALE — {staleLabel}
              </span>
            )}
            {isDegraded && (
              <span
                role="alert"
                className="tabular-nums rounded border border-dashed border-[#e86a7c]/70 bg-[#e86a7c]/15 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-[#ff8fab]"
              >
                DATA DEGRADED{degradedRowId != null ? ` — ROW #${degradedRowId}` : ""}
              </span>
            )}
            {dash.isError && data ? (
              <span
                role="status"
                className="tabular-nums rounded border border-[#e86a7c]/45 bg-[#e86a7c]/10 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-[#e86a7c]"
              >
                LINK DOWN — RETRYING
              </span>
            ) : null}
            <button
              ref={searchBtnRef}
              type="button"
              aria-label="Open command palette"
              onClick={() => setPaletteOpen(true)}
              className="mc-touch mc-interactive flex min-w-[44px] items-center gap-2 rounded border border-[#5cc6da]/35 bg-[#5cc6da]/10 px-3 py-2 font-mono text-[10px] tracking-widest text-[#5cc6da] md:min-w-[220px] lg:min-w-[300px]"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden>
                <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2.4" />
                <path d="M20 20L16.5 16.5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
              </svg>
              <span className="hidden text-left normal-case tracking-normal text-[#7d8fa3] sm:inline md:flex-1">
                Search agents, tasks, logs…
              </span>
              <span className="mc-kbd hidden md:inline">⌘K</span>
            </button>
            <button
              type="button"
              aria-label="Open keyboard shortcuts help"
              onClick={() => setHelpOpen(true)}
              className="mc-touch mc-interactive flex items-center justify-center rounded border border-white/15 bg-white/[0.03] px-3 py-2 font-mono text-[11px] text-[#8a9bb0]"
            >
              ?
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] tabular-nums text-[#7d8fa3]">
            {latest ? (
              <>
                <span>
                  ACTIVE <span className="text-[#4ecf8f]"><TweenedNumber value={activeCount} reducedMotion={reducedMotion} /></span>
                </span>
                {pendingCount > 0 ? (
                  <span>
                    PENDING <span className="text-[#6fc3d8]"><TweenedNumber value={pendingCount} reducedMotion={reducedMotion} /></span>
                  </span>
                ) : null}
                {runningCount > 0 ? (
                  <span>
                    RUNNING <span className="text-[#5cc6da]"><TweenedNumber value={runningCount} reducedMotion={reducedMotion} /></span>
                  </span>
                ) : null}
                <span>
                  STANDBY <span className="text-[#e8a84d]"><TweenedNumber value={standbyCount} reducedMotion={reducedMotion} /></span>
                </span>
                <button
                  type="button"
                  aria-label={`Alerts: ${attention.length + failedCount}. Jump to attention panel`}
                  onClick={() => scrollToId("attention-panel")}
                  className="mc-touch rounded px-1 py-1 text-left"
                >
                  ALERT{" "}
                  <span className={attention.length + failedCount > 0 ? "text-[#e86a7c]" : "text-[#4ecf8f]"}>
                    <TweenedNumber value={attention.length + failedCount} reducedMotion={reducedMotion} />
                  </span>
                </button>
              </>
            ) : null}
            <DhakaClock />
            <FreshnessText
              takenAtMs={takenAtMs}
              lastIngestAt={ingestHealth?.lastIngestAt ?? null}
              ingestAgeSecFallback={ingestHealth?.ageSec ?? null}
              snapshotKey={snapshotKey}
              hasLatest={latest != null}
            />
          </div>
        </header>
        {latest ? (
          <FreshnessTrack
            takenAtMs={takenAtMs}
            lastIngestAt={ingestHealth?.lastIngestAt ?? null}
            ingestAgeSecFallback={ingestHealth?.ageSec ?? null}
          />
        ) : null}
        {/* Health strip — catalog grouping: two large pills on top
            (CORE, INGEST), one quiet row below (DATA · JOURNAL · LINK) */}
        <div
          role="region"
          aria-label="System health"
          className="mc-depth-3 mt-3 rounded-xl px-4 py-3"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="mc-hud-label mr-1">Health</span>
          {/* Core chip: NO SIGNAL until the first snapshot exists —
              a wrong state is worse than no state. */}
          <span
            className={`mc-core-chip ${aiCoreState === "NO_SIGNAL" ? "mc-core-chip-nosignal" : ""}`}
            role="status"
            aria-label={
              aiCoreState === "NO_SIGNAL"
                ? "AI core: no signal — waiting for first snapshot"
                : `AI core state: ${aiCoreState}. ${coreMeta.desc}`
            }
            style={{ color: coreMeta.color, background: coreMeta.bg, borderColor: coreMeta.border }}
          >
            <span
              className="mc-core-dot"
              aria-hidden
              style={{
                background: coreMeta.color,
                boxShadow: aiCoreState === "NO_SIGNAL" ? "none" : `0 0 4px ${coreMeta.color}`,
              }}
            />
            CORE · {aiCoreState === "NO_SIGNAL" ? "NO SIGNAL" : aiCoreState}
          </span>
          <span
            className="flex items-center gap-1.5 font-mono text-[10px] tracking-widest"
            aria-label={`Ingestion ${ageSec === null ? "awaiting data" : isStale ? "stale" : "live"}`}
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{
                background: ageSec === null ? "#5b6b80" : isStale ? "#e8a84d" : "#4ecf8f",
                boxShadow: `0 0 6px ${ageSec === null ? "#5b6b80" : isStale ? "#e8a84d" : "#4ecf8f"}`,
              }}
            />
            <span className="text-[#5b6b80]">INGEST</span>
            <span style={{ color: ageSec === null ? "#8a9bb0" : isStale ? "#e8a84d" : "#4ecf8f" }}>
              {ageSec === null ? "AWAITING" : isStale ? "STALE" : "LIVE"}
            </span>
          </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1.5 border-t border-white/[0.05] pt-2">
          <span
            className="flex items-center gap-1.5 font-mono text-[10px] tracking-widest"
            aria-label={`Data quality ${isDegraded ? "degraded" : "ok"}`}
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{
                background: isDegraded ? "#e86a7c" : "#4ecf8f",
                boxShadow: `0 0 6px ${isDegraded ? "#e86a7c" : "#4ecf8f"}`,
              }}
            />
            <span className="text-[#5b6b80]">DATA</span>
            <span style={{ color: isDegraded ? "#ff8fab" : "#4ecf8f" }}>
              {isDegraded ? "DEGRADED" : "OK"}
            </span>
          </span>
          <span
            className="flex items-center gap-1.5 font-mono text-[10px] tracking-widest"
            aria-label={`Journal ${journal.isError ? "unavailable" : journal.isPending ? "loading" : "ok"}`}
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{
                background: journal.isError ? "#e86a7c" : journal.isPending ? "#5b6b80" : "#4ecf8f",
                boxShadow: `0 0 6px ${journal.isError ? "#e86a7c" : journal.isPending ? "#5b6b80" : "#4ecf8f"}`,
              }}
            />
            <span className="text-[#5b6b80]">JOURNAL</span>
            <span style={{ color: journal.isError ? "#ff8fab" : journal.isPending ? "#8a9bb0" : "#4ecf8f" }}>
              {journal.isError ? "UNAVAILABLE" : journal.isPending ? "LOADING" : "OK"}
            </span>
          </span>
          <span
            className="flex items-center gap-1.5 font-mono text-[10px] tracking-widest"
            aria-label={`Dashboard link ${dash.isError ? "retrying" : "ok"}`}
          >
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{
                background: dash.isError ? "#e8a84d" : "#4ecf8f",
                boxShadow: `0 0 6px ${dash.isError ? "#e8a84d" : "#4ecf8f"}`,
              }}
            />
            <span className="text-[#5b6b80]">LINK</span>
            <span style={{ color: dash.isError ? "#e8a84d" : "#4ecf8f" }}>
              {dash.isError ? "RETRYING" : "OK"}
            </span>
          </span>
          </div>
        </div>
        {isDegraded ? (
          <div
            role="alert"
            className="mt-2 rounded border border-dashed border-[#e86a7c]/60 bg-[#e86a7c]/10 px-3 py-2"
          >
            <p className="font-mono text-[11px] tracking-widest text-[#ff8fab]">
              DATA DEGRADED — newest snapshot unreadable
              {degradedRowId != null ? ` (row #${degradedRowId})` : ""}
            </p>
            <p className="mt-1 font-mono text-[11px] leading-relaxed text-[#c7d6ea]">
              {lastGood
                ? `Showing the last good snapshot (${dhakaStamp(lastGood.takenAt)} Dhaka) — labeled as last good, not live. The next good ingest clears this automatically.`
                : "No readable snapshot is available yet. The next good ingest clears this automatically."}
            </p>
          </div>
        ) : null}
        <p
          className="mt-2 hidden text-center font-mono text-[9.5px] tracking-[0.22em] text-[#5b6b80] md:block"
          aria-hidden="true"
        >
          1 3D · 2 2D · 3 24H · 6 ACTIVITY · 4 RELIABILITY · 5 IMPROVE · ⌘K SEARCH · ? KEYS
        </p>
        {travelSnap ? (
          <div
            className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded border border-[#e8a84d]/45 bg-[#e8a84d]/10 px-3 py-2"
            role="status"
          >
            <span className="font-mono text-[10px] tracking-widest text-[#e8a84d]">
              TIME TRAVEL · VIEWING {dhakaStamp(travelSnap.takenAt)} DHAKA ·
              READ-ONLY
            </span>
            <button
              type="button"
              aria-label="Exit time travel, back to live data"
              onClick={() => {
                setTimeTravelAt(null);
                setAnnounce("Back to live data");
              }}
              className="mc-touch rounded border border-[#e8a84d]/50 bg-[#e8a84d]/10 px-3 py-1 font-mono text-[10px] tracking-widest text-[#e8a84d]"
            >
              BACK TO LIVE
            </button>
          </div>
        ) : null}
        {flashNonce > 0 ? (
          <div
            key={flashNonce}
            aria-hidden
            className="mc-ingest-flash pointer-events-none absolute inset-x-0 bottom-0 h-[2px]"
          />
        ) : null}
        </div>

        <div
          role="tablist"
          aria-label="Dashboard sections"
          className="mt-3 flex flex-wrap gap-1.5"
        >
          {(
            [
              { key: "ops", label: "OPERATIONS" },
              { key: "reliability", label: "RELIABILITY" },
              { key: "improvements", label: "IMPROVEMENTS" },
            ] as Array<{ key: CenterView; label: string }>
          ).map((t) => {
            const isOn = centerView === t.key;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                id={`mc-tab-${t.key}`}
                aria-selected={isOn}
                aria-label={`Show ${t.label.toLowerCase()} section`}
                aria-pressed={isOn}
                onClick={() => setCenterView(t.key)}
                className={`mc-touch mc-interactive touch-manipulation rounded-full border px-4 py-2 font-mono text-[10px] tracking-widest transition-colors ${
                  isOn
                    ? "border-[#5cc6da]/60 bg-[#5cc6da]/15 text-[#5cc6da]"
                    : "border-white/10 bg-white/[0.03] text-[#8a9bb0] hover:bg-white/[0.07]"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>

        {centerView === "reliability" ? (
          <ReliabilityCenter />
        ) : centerView === "improvements" ? (
          <ImprovementCenter />
        ) : dash.isPending ? (
          <div className="mc-glass relative mt-6 p-6" role="status" aria-label="Loading dashboard">
            <Corners />
            <div className="space-y-3">
              <div className="mc-skeleton mc-skeleton-line w-40" />
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="mc-skeleton mc-skeleton-block" />
                <div className="mc-skeleton mc-skeleton-block" />
                <div className="mc-skeleton mc-skeleton-block" />
              </div>
              <div className="mc-skeleton mc-skeleton-line w-2/3" />
              <div className="mc-skeleton mc-skeleton-line w-1/2" />
            </div>
            <p className="mt-4 font-mono text-xs text-[#8a9bb0]">
              ESTABLISHING UPLINK<span className="mc-blink">…</span>
            </p>
          </div>
        ) : dash.isError && !data ? (
          <div className="mc-glass relative mt-6 p-10 text-center">
            <Corners />
            <p className="font-mono text-sm text-[#e86a7c]">UPLINK FAILED — dashboard did not load.</p>
            <p className="mx-auto mt-2 max-w-sm font-mono text-xs leading-relaxed text-[#8a9bb0]">
              Retrying automatically every few seconds — the wall comes back on its own when the uplink answers.
            </p>
            <button
              type="button"
              aria-label="Retry loading dashboard"
              onClick={() => void dash.refetch()}
              className="mt-4 rounded border border-[#5cc6da]/40 bg-[#5cc6da]/10 px-4 py-2 font-mono text-xs tracking-widest text-[#5cc6da]"
            >
              RETRY NOW
            </button>
          </div>
        ) : !latest ? (
          <div className="mc-glass mc-fade-in relative mt-6 p-10 text-center">
            <Corners />
            {isDegraded ? (
              <>
                <p className="font-mono text-sm tracking-widest text-[#ff8fab]">
                  DATA DEGRADED — newest snapshot unreadable
                  {degradedRowId != null ? ` (row #${degradedRowId})` : ""}
                </p>
                <p className="mx-auto mt-2 max-w-sm font-mono text-xs leading-relaxed text-[#8a9bb0]">
                  No readable snapshot is available yet. The next good ingest clears this automatically — nothing is silently substituted.
                </p>
              </>
            ) : (
              <>
                {/* NO SIGNAL presentation: dim, desaturated, static —
                    no sweep, no pulse. Nothing asserts a state here. */}
                <div className="relative mx-auto mb-5 h-28 w-28 opacity-70">
                  <div className="absolute inset-0 rounded-full border border-[#64768c]/30" aria-hidden />
                  <div className="absolute inset-[22%] rounded-full border border-[#64768c]/22" aria-hidden />
                  <div className="absolute inset-[40%] rounded-full border border-[#64768c]/18" aria-hidden />
                  <span className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#64768c]" aria-hidden />
                </div>
                <p className="font-mono text-[10px] tracking-[0.3em] text-[#7d8ea3]">
                  CORE · NO SIGNAL
                </p>
                <h2
                  className="mt-2 text-sm tracking-[0.25em] text-[#9db2c8]"
                  style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}
                >
                  AWAITING FIRST UPLINK
                </h2>
                <p className="mx-auto mt-2 max-w-sm font-mono text-xs leading-relaxed text-[#8a9bb0]">
                  The worker pushes a snapshot every 10 minutes. This wall lights up automatically — no refresh needed.
                </p>
                <p className="mt-4 font-mono text-[11px] text-[#5b6b80]">
                  POLLING EVERY 30S · SNAPSHOT CADENCE 10M
                </p>
              </>
            )}
          </div>
        ) : (
          <>
            <main className="mc-layout-grid mt-4">
              {/* Center stage */}
              <MissionErrorBoundary label="Stage view">
              <section
                aria-label="Agent fleet stage"
                className="mc-glass mc-area-stage relative order-1"
                style={{ animationDelay: "40ms" }}
              >
                <Corners />
                <div className="mc-core-glow pointer-events-none absolute inset-0" aria-hidden />
                <div className="mc-head relative flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-3">
                  <h2 className="mc-hud-label min-w-0 flex-[1_1_9rem] sm:flex-none">
                    {viewMode === "timeline"
                      ? "Timeline // Next 24 Hours"
                      : viewMode === "activity"
                        ? "Activity // Live Event Stream"
                        : "Orbital Ops // Agent Fleet"}
                  </h2>
                  <div className="flex flex-wrap items-center gap-2">
                    <Waveform />
                    <span className="hidden font-mono text-[10px] tracking-widest text-[#8a9bb0] sm:inline">
                      SYS <span className="text-[#4ecf8f]"><TweenedNumber value={Math.round(onlinePct * 100)} reducedMotion={reducedMotion} />%</span>
                    </span>
                    <div
                      className="flex items-center gap-1"
                      role="group"
                      aria-label="Stage view and sound"
                    >
                      <button
                        type="button"
                        aria-label="Use 3D orbital view"
                        aria-pressed={show3d}
                        onClick={() => {
                          setWebglFailed(false);
                          setViewMode("3d");
                        }}
                        className={`touch-manipulation mc-touch mc-interactive rounded-sm border px-3 py-2 font-mono text-[9.5px] tracking-widest transition-colors ${
                          show3d
                            ? "border-[#5cc6da]/60 bg-[#5cc6da]/15 text-[#5cc6da]"
                            : "border-white/10 bg-white/[0.03] text-[#8a9bb0]"
                        }`}
                      >
                        3D
                      </button>
                      <button
                        type="button"
                        aria-label="Use flat 2D orbital view"
                        aria-pressed={viewMode === "2d" || webglFailed}
                        onClick={() => setViewMode("2d")}
                        className={`touch-manipulation mc-touch mc-interactive rounded-sm border px-3 py-2 font-mono text-[9.5px] tracking-widest transition-colors ${
                          viewMode === "2d" || webglFailed
                            ? "border-[#5cc6da]/60 bg-[#5cc6da]/15 text-[#5cc6da]"
                            : "border-white/10 bg-white/[0.03] text-[#8a9bb0]"
                        }`}
                      >
                        2D
                      </button>
                      <button
                        type="button"
                        aria-label="Use 24 hour timeline view"
                        aria-pressed={viewMode === "timeline"}
                        onClick={() => setViewMode("timeline")}
                        className={`touch-manipulation mc-touch mc-interactive rounded-sm border px-3 py-2 font-mono text-[9.5px] tracking-widest transition-colors ${
                          viewMode === "timeline"
                            ? "border-[#5cc6da]/60 bg-[#5cc6da]/15 text-[#5cc6da]"
                            : "border-white/10 bg-white/[0.03] text-[#8a9bb0]"
                        }`}
                      >
                        24H
                      </button>
                      <button
                        type="button"
                        aria-label="Use activity stream view"
                        aria-pressed={viewMode === "activity"}
                        onClick={() => setViewMode("activity")}
                        className={`touch-manipulation mc-touch mc-interactive rounded-sm border px-3 py-2 font-mono text-[9.5px] tracking-widest transition-colors ${
                          viewMode === "activity"
                            ? "border-[#5cc6da]/60 bg-[#5cc6da]/15 text-[#5cc6da]"
                            : "border-white/10 bg-white/[0.03] text-[#8a9bb0]"
                        }`}
                      >
                        ACT
                      </button>
                      <button
                        type="button"
                        aria-label={soundOn ? "Mute interface sounds" : "Enable interface sounds"}
                        aria-pressed={soundOn}
                        onClick={toggleSound}
                        className={`touch-manipulation mc-touch mc-interactive rounded-sm border px-3 py-2 font-mono text-[9.5px] tracking-widest transition-colors ${
                          soundOn
                            ? "border-[#4ecf8f]/50 bg-[#4ecf8f]/10 text-[#4ecf8f]"
                            : "border-white/10 bg-white/[0.03] text-[#8a9bb0]"
                        }`}
                      >
                        SND {soundOn ? "ON" : "OFF"}
                      </button>
                    </div>
                  </div>
                </div>
                <div ref={stageWrapRef} className="mc-parallax-layer relative overflow-hidden">
                  {viewMode === "activity" ? (
                    <ActivityStream
                      timeline={timeline}
                      journalEntries={journalEntries}
                      crons={sortedCrons}
                      onSelect={handleSelect}
                    />
                  ) : viewMode === "timeline" ? (
                    <Timeline24h
                      crons={sortedCrons}
                      codeMap={codeMap}
                      selectedId={selectedCron?.id ?? null}
                      hoverId={hoverId}
                      onSelect={handleSelect}
                      onHover={setHoverId}
                    />
                  ) : show3d ? (
                    <Suspense fallback={orbitalStage}>
                      <OrbitalScene3D
                        key={`${visual.effectiveTier}-${Object.values(visual.config.modules).join("")}-${Object.values(visual.config.flags).join("")}`}
                        nodes={sceneNodes}
                        selectedId={selectedCron?.id ?? null}
                        coreState={coreSceneState}
                        coreVisual={aiCoreState}
                        coreLabel={aiCoreState}
                        animate={!reducedMotion}
                        qualityTier={visual.effectiveTier}
                        visualConfig={visual.config}
                        onSceneFps={(fps) => perfMonitor.recordSceneFps(fps)}
                        trackingLabel={
                          selectedCron
                            ? `TRACKING: ${(selectedCron.title ?? selectedCron.id).toUpperCase()}`
                            : "CORE LINKED // NEWSFLOW"
                        }
                        highlightId={hoverId}
                        syncPulseKey={snapshotKey}
                        onSelect={handleSelect}
                        onHover={setHoverId}
                        onWebglFail={() => setWebglFailed(true)}
                      />
                    </Suspense>
                  ) : (
                    orbitalStage
                  )}
                  {selectedCron && viewMode !== "timeline" ? (
                    <div
                      key={selectedCron.id}
                      aria-hidden
                      className="mc-select-flash pointer-events-none absolute inset-0 z-20"
                    />
                  ) : null}
                </div>
                {/* Below the universe, in brief order: current task,
                    then the failed-agent alert, then Next Up (rail). */}
                <div className="px-4 pt-3">
                  <CurrentTaskStrip crons={sortedCrons} onSelect={handleSelect} />
                </div>
                {failedCount > 0 ? (
                  <div className="px-4 pt-3">
                    <button
                      type="button"
                      aria-label={`Failed agent alert: ${failedCount} unit${failedCount === 1 ? "" : "s"} failed the last run. Inspect the first failed unit`}
                      onClick={() => {
                        const f = sortedCrons.find((c) => c.lastRunStatus === "failed");
                        if (f) handleSelect(f.id);
                      }}
                      className="mc-alert-panel mc-touch flex w-full touch-manipulation items-center gap-3 rounded-lg border border-[#e86a7c]/35 bg-[#e86a7c]/[0.06] px-3 py-2.5 text-left"
                    >
                      <span className="mc-status mc-status-danger shrink-0">
                        <SeverityIcon severity="action" />
                        FAILED
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[#f3c2cb]">
                        {sortedCrons.find((c) => c.lastRunStatus === "failed")?.title ?? "A unit"} failed its last run
                        {(() => {
                          const f = sortedCrons.find((c) => c.lastRunStatus === "failed");
                          return f?.lastRunAt ? ` · ${dhakaStamp(f.lastRunAt)} Dhaka` : "";
                        })()}
                      </span>
                      <span className="shrink-0 font-mono text-[9px] tracking-widest text-[#e86a7c]">INSPECT →</span>
                    </button>
                  </div>
                ) : null}
                {viewMode === "activity" ? null : viewMode === "timeline" ? (
                  <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 font-mono text-[10px] tracking-widest text-[#8a9bb0]">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-[10px] w-[5px] rounded-[2px] bg-[#5cc6da]/60" aria-hidden /> SCHEDULED RUN
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-[10px] w-[14px] rounded-[2px] border border-dashed border-[#6fc3d8]" aria-hidden /> PENDING (QUEUED)
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-[10px] w-[14px] rounded-[2px] bg-[#5cc6da] shadow-[0_0_6px_#5cc6da]" aria-hidden /> RUNNING NOW
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-[10px] w-[10px] rounded-full border border-[#e86a7c]" aria-hidden /> LAST RUN FAILED
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-[2px] w-4 bg-[#5cc6da] shadow-[0_0_6px_#5cc6da]" aria-hidden /> NOW
                    </span>
                    {nextUp ? (
                      <span className="ml-auto min-w-0 max-w-full truncate text-[#e6f1ff]">
                        NEXT: <span className="text-[#5cc6da]">{nextUp.title ?? nextUp.id}</span> ·{" "}
                        {countdownLabel(toMs(nextUp.nextRunAt), nowMs)} · {cadencePlain(nextUp.cadence)}
                      </span>
                    ) : null}
                  </div>
                ) : (
                <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 font-mono text-[10px] tracking-widest text-[#8a9bb0]">
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#4ecf8f]" /> ACTIVE
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#5cc6da] shadow-[0_0_6px_#5cc6da]" /> RUNNING
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-[2px] border border-dashed border-[#6fc3d8]" /> PENDING
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#e8a84d]" /> PAUSED
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#e86a7c]" /> FAILED
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#5b6b80]" /> DISABLED
                  </span>
                  {nextUp ? (
                    <span className="ml-auto min-w-0 max-w-full truncate text-[#e6f1ff]">
                      NEXT UP <span className="text-[#5cc6da]">{nextUp.title ?? nextUp.id}</span> ·{" "}
                      {rel(nextUp.nextRunAt, nowMs)}
                    </span>
                  ) : (
                    <span className="ml-auto">TAP A NODE FOR DETAIL</span>
                  )}
                </div>
                )}
              </section>
              </MissionErrorBoundary>

              {/* Left rail: fleet list */}
              <MissionErrorBoundary label="Fleet list">
              <aside
                id="fleet-panel"
                aria-label="Fleet list"
                className="mc-glass mc-fade-in mc-area-fleet relative order-3 scroll-mt-28"
                style={{ animationDelay: "100ms" }}
              >
                <Corners />
                <div className="mc-head flex items-center justify-between px-4 pt-3">
                  <h2 className="mc-hud-label">Fleet // Schedules</h2>
                  <span className="font-mono text-[10px] text-[#5b6b80]">{crons.length} UNITS</span>
                </div>
                <div className="px-4 pt-3">
                  <label htmlFor="mc-fleet-search" className="sr-only">Search fleet by name</label>
                  <input
                    id="mc-fleet-search"
                    value={fleetQuery}
                    onChange={(e) => setFleetQuery(e.target.value)}
                    placeholder="Search agents by name or code…"
                    className="w-full rounded border border-white/12 bg-white/[0.03] px-3 py-2.5 font-mono text-sm text-[#e6f1ff] outline-none placeholder:text-[#5b6b80]"
                  />
                </div>
                <div className="mc-filter-bar mc-filter-scroll flex flex-wrap gap-1.5 px-4 pt-2.5" role="group" aria-label="Filter fleet by status">
                  {(
                    [
                      { key: "all", label: "ALL", count: crons.length },
                      { key: "active", label: "ACTIVE", count: activeCount },
                      { key: "pending", label: "PENDING", count: pendingCount },
                      { key: "running", label: "RUNNING", count: runningCount },
                      { key: "paused", label: "PAUSED", count: pausedCount },
                      { key: "failed", label: "FAILED", count: failedCount },
                      { key: "disabled", label: "DISABLED", count: disabledCount },
                      { key: "issues", label: "ISSUES", count: issueCount },
                      {
                        key: "standby",
                        label: "STANDBY",
                        count: standbyCount,
                      },
                    ] as const
                  ).map((f) => {
                    const isOn = fleetFilter === f.key;
                    return (
                      <button
                        key={f.key}
                        type="button"
                        data-mc-filter-active={isOn ? "true" : undefined}
                        aria-label={`Show ${f.label.toLowerCase()} schedules (${f.count})`}
                        aria-pressed={isOn}
                        onClick={() => setFleetFilter(f.key)}
                        className={`touch-manipulation mc-touch mc-interactive rounded-full border px-3 py-2 font-mono text-[9.5px] tracking-widest transition-colors ${
                          isOn
                            ? "border-[#5cc6da]/60 bg-[#5cc6da]/15 text-[#5cc6da]"
                            : "border-white/10 bg-white/[0.03] text-[#8a9bb0] hover:bg-white/[0.07]"
                        }`}
                      >
                        {f.label} <span className="opacity-70"><TweenedNumber value={f.count} reducedMotion={reducedMotion} /></span>
                      </button>
                    );
                  })}
                </div>
                {visibleFleet.length === 0 ? (
                  <p className="px-4 py-6 text-center font-mono text-xs leading-relaxed text-[#8a9bb0]">
                    {sortedCrons.length === 0 ? (
                      <>
                        No schedules in this snapshot yet. The fleet fills in on the next worker push — recent changes land in the{" "}
                        <a href="#activity-log" className="text-[#5cc6da] underline decoration-[#5cc6da]/40 underline-offset-2">Activity Log</a>.
                      </>
                    ) : (
                      <>
                        No units match this filter. Try another filter above, or see what changed in the{" "}
                        <a href="#activity-log" className="text-[#5cc6da] underline decoration-[#5cc6da]/40 underline-offset-2">Activity Log</a>.
                      </>
                    )}
                  </p>
                ) : (
                  <>
                  <div
                    aria-hidden
                    className="mt-3 hidden grid-cols-[minmax(0,1fr)_176px_112px] items-center gap-3 border-b border-white/[0.07] px-5 pb-2 font-mono text-[9px] tracking-[0.18em] text-[#5b6b80] lg:grid"
                  >
                    <span>AGENT</span>
                    <span>LAST RUN</span>
                    <span>STATUS</span>
                  </div>
                  <ul className="mt-3 max-h-[560px] divide-y divide-white/[0.04] overflow-y-auto px-2 pb-3">
                    {visibleFleet.map((c) => {
                      const st = nodeState(c);
                      const color = STATE_COLOR[st];
                      const isSel = selectedCron?.id === c.id;
                      return (
                        <li key={c.id}>
                          <button
                            type="button"
                            aria-label={`Inspect ${c.title ?? c.id}`}
                            aria-pressed={isSel}
                            title={c.title ?? c.id}
                            onClick={() => handleSelect(isSel ? null : c.id)}
                            onMouseEnter={() => setHoverId(c.id)}
                            onMouseLeave={() => setHoverId(null)}
                            onFocus={() => setHoverId(c.id)}
                            onBlur={() => setHoverId(null)}
                            className={`flex min-h-[56px] w-full touch-manipulation items-start gap-3 rounded-lg px-3 py-3 text-left transition-colors ${
                              isSel
                                ? "bg-[#5cc6da]/[0.08]"
                                : st === "failed"
                                  ? "bg-[#e86a7c]/[0.04] hover:bg-[#e86a7c]/[0.07]"
                                  : "hover:bg-white/[0.025] active:bg-white/[0.05]"
                            }`}
                          >
                            <span
                              className="flex h-9 min-w-9 shrink-0 items-center justify-center border px-1 font-mono text-[10px] font-semibold tabular-nums"
                              style={{
                                borderColor: `${color}66`,
                                color,
                                background: `${color}0d`,
                                borderRadius: st === "pending" ? 6 : 999,
                                borderStyle: st === "pending" ? "dashed" : "solid",
                              }}
                            >
                              {codeMap.get(c.id) ?? baseCode(c)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block text-[14px] font-medium leading-snug text-[#e8eef5] [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2] overflow-hidden">
                                {c.title ?? c.id}
                              </span>
                              <span className="mt-1 block font-mono text-[10px] leading-relaxed tabular-nums text-[#7d8fa3]">
                                {cadencePlain(c.cadence)} ·{" "}
                                {st === "running" ? (
                                  <span style={{ color }}>Running now</span>
                                ) : st === "pending" ? (
                                  <span style={{ color }}>Queued {rel(c.nextRunAt, nowMs)}</span>
                                ) : (
                                  <>
                                    next{" "}
                                    <span
                                      className={`tabular-nums${
                                        c.nextRunAt &&
                                        new Date(c.nextRunAt).getTime() - nowMs <= 10 * 60_000 &&
                                        new Date(c.nextRunAt).getTime() > nowMs
                                          ? " text-[#e8a84d]"
                                          : " text-[#a8b8c8]"
                                      }`}
                                    >
                                      {rel(c.nextRunAt, nowMs)}
                                    </span>
                                  </>
                                )}
                              </span>
                            </span>
                            <span className="hidden w-44 shrink-0 font-mono text-[10px] tabular-nums text-[#5b6b80] lg:block">
                              LAST {rel(c.lastRunAt, nowMs).toUpperCase()}
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              <span
                                className="flex items-center gap-1.5 font-mono text-[9px] font-medium tracking-wide"
                                style={{ color }}
                              >
                                <StatusIcon state={st} />
                                <span>{STATE_LABEL[st]}</span>
                              </span>
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  </>
                )}
              </aside>
              </MissionErrorBoundary>

              {/* Right column: detail + newsflow + attention */}
              <div className="mc-area-side order-2 flex flex-col gap-4">
                {selectedCron != null && selectedCron.id === "__drawer_now__" ? (
                  <section
                    ref={detailRef}
                    aria-label={`Detail for ${selectedCron.title ?? selectedCron.id}`}
                    className="mc-glass mc-fade-in mc-panel-scan relative scroll-mt-28 p-4"
                    key={selectedCron.id}
                  >
                    <Corners />
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="mc-hud-label">Unit Detail</p>
                        <h2
                          className="mt-1 truncate text-base tracking-wide"
                          style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}
                        >
                          {(selectedCron.title ?? selectedCron.id).toUpperCase()}
                        </h2>
                        <p className="truncate font-mono text-[11px] text-[#5b6b80]">{selectedCron.id}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="font-mono text-[10px] text-[#5b6b80]">
                          {selectedIndex + 1}/{sortedCrons.length}
                        </span>
                        <button
                          type="button"
                          aria-label="Previous unit"
                          onClick={() => stepSelection(-1)}
                          className="rounded border border-white/15 bg-white/5 px-2 py-1 font-mono text-[11px] text-[#c7d6ea]"
                        >
                          ‹
                        </button>
                        <button
                          type="button"
                          aria-label="Next unit"
                          onClick={() => stepSelection(1)}
                          className="rounded border border-white/15 bg-white/5 px-2 py-1 font-mono text-[11px] text-[#c7d6ea]"
                        >
                          ›
                        </button>
                        <button
                          type="button"
                          aria-label="Close unit detail, back to overview"
                          onClick={() => handleSelect(null)}
                          className="rounded border border-white/15 bg-white/5 px-2 py-1 font-mono text-[11px] text-[#c7d6ea]"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                    <div className="mt-3">{statusBadge(selectedCron)}</div>
                    {nodeState(selectedCron) === "pending" ? (
                      <p className="mt-3 rounded border border-[#6fc3d8]/35 bg-[#6fc3d8]/[0.07] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#a5f3fc]">
                        QUEUED — runs next. This run is waiting in the scheduler queue
                        {selectedCron.nextRunAt ? ` and fires ${rel(selectedCron.nextRunAt, nowMs)} (${dhakaStamp(selectedCron.nextRunAt)} Dhaka)` : ""}.
                      </p>
                    ) : null}
                    {nodeState(selectedCron) === "running" ? (
                      <p className="mt-3 rounded border border-[#5cc6da]/40 bg-[#5cc6da]/[0.08] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#cffafe]">
                        RUNNING — executing now
                        {selectedCron.lastRunAt ? ` since ~${rel(selectedCron.lastRunAt, nowMs)} (${dhakaStamp(selectedCron.lastRunAt)} Dhaka)` : ""}. Live progress arrives with the next snapshot.
                      </p>
                    ) : null}
                    <dl className="mt-4 grid grid-cols-2 gap-3">
                      <div className="rounded border border-white/8 bg-white/[0.02] p-3">
                        <dt className="font-mono text-[10px] tracking-widest text-[#8a9bb0]">CADENCE</dt>
                        <dd className="mt-1 font-mono text-sm text-[#e6f1ff]">{selectedCron.cadence ?? "—"}</dd>
                      </div>
                      <div className="rounded border border-white/8 bg-white/[0.02] p-3">
                        <dt className="font-mono text-[10px] tracking-widest text-[#8a9bb0]">LAST RESULT</dt>
                        <dd className="mt-1 flex items-center gap-2 font-mono text-sm text-[#e6f1ff]">
                          {runDot(selectedCron.lastRunStatus)}
                          {selectedCron.lastRunStatus ?? "no run yet"}
                        </dd>
                      </div>
                      <div className="rounded border border-white/8 bg-white/[0.02] p-3">
                        <dt className="font-mono text-[10px] tracking-widest text-[#8a9bb0]">LAST RUN</dt>
                        <dd className="mt-1 font-mono text-sm text-[#e6f1ff]">{rel(selectedCron.lastRunAt, nowMs)}</dd>
                        <dd className="font-mono text-[10px] text-[#5b6b80]">{dhakaStamp(selectedCron.lastRunAt)} Dhaka</dd>
                      </div>
                      <div className="rounded border border-white/8 bg-white/[0.02] p-3">
                        <dt className="font-mono text-[10px] tracking-widest text-[#8a9bb0]">NEXT RUN</dt>
                        <dd className="mt-1 font-mono text-sm text-[#5cc6da]">{rel(selectedCron.nextRunAt, nowMs)}</dd>
                        <dd className="font-mono text-[10px] text-[#5b6b80]">{dhakaStamp(selectedCron.nextRunAt)} Dhaka</dd>
                      </div>
                    </dl>
                    <h3 className="mc-hud-label mt-4">Recent Runs</h3>
                    {selectedRuns.length === 0 ? (
                      <p className="mt-2 font-mono text-xs text-[#8a9bb0]">No runs recorded in recent snapshots.</p>
                    ) : (
                      <ul className="mt-2 space-y-1.5">
                        {selectedRuns.map((r) => (
                          <li
                            key={r.at}
                            className="flex items-center justify-between rounded border border-white/5 bg-white/[0.02] px-2.5 py-1.5 font-mono text-[11px]"
                          >
                            <span className="flex items-center gap-2 text-[#c7d6ea]">
                              {runDot(r.st)}
                              {r.st ?? "finished"}
                            </span>
                            <span className="text-[#5b6b80]">
                              {dhakaStamp(r.at)} · {rel(r.at, nowMs)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                ) : (
                  <section aria-label="Mission overview" className="mc-glass mc-fade-in relative p-4">
                    <Corners />
                    <h2 className="mc-hud-label mc-head">Overview // Systems</h2>
                    <div className="mt-3 flex items-center gap-4">
                      <div className="relative">
                        <Gauge value={onlinePct} color={onlinePct >= 0.5 ? "#4ecf8f" : "#e8a84d"} />
                        <span className="absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold">
                          <TweenedNumber value={Math.round(onlinePct * 100)} reducedMotion={reducedMotion} />%
                        </span>
                      </div>
                      <div className="font-mono text-[11px] leading-5 text-[#8a9bb0]">
                        <p>
                          <span className="text-[#4ecf8f]"><TweenedNumber value={activeCount} reducedMotion={reducedMotion} /></span> ACTIVE
                        </p>
                        <p>
                          <span className="text-[#6fc3d8]"><TweenedNumber value={pendingCount} reducedMotion={reducedMotion} /></span> PENDING
                        </p>
                        <p>
                          <span className="text-[#5cc6da]"><TweenedNumber value={runningCount} reducedMotion={reducedMotion} /></span> RUNNING
                        </p>
                        <p>
                          <span className="text-[#e8a84d]"><TweenedNumber value={standbyCount} reducedMotion={reducedMotion} /></span> STANDBY
                        </p>
                        <p>
                          <span className={failedCount > 0 ? "text-[#e86a7c]" : "text-[#8a9bb0]"}><TweenedNumber value={failedCount} reducedMotion={reducedMotion} /></span>{" "}
                          FAILED LAST RUN
                        </p>
                        <p>
                          <span className={attention.length > 0 ? "text-[#e86a7c]" : "text-[#4ecf8f]"}>
                            <TweenedNumber value={attention.length} reducedMotion={reducedMotion} />
                          </span>{" "}
                          ATTENTION
                        </p>
                      </div>
                    </div>
                    <p className="mt-3 font-mono text-[11px] leading-relaxed text-[#5b6b80]">
                      SELECT A NODE ON THE ORBITAL STAGE OR A UNIT IN THE FLEET LIST TO INSPECT IT.
                    </p>
                  </section>
                )}

                {/* NewsFlow */}
                <section aria-label="NewsFlow agent" className="mc-glass mc-fade-in relative p-4" style={{ animationDelay: "140ms" }}>
                  <Corners />
                  <h2 className="mc-hud-label mc-head">NewsFlow Agent</h2>
                  <div className="mt-3 flex flex-wrap items-center gap-3">
                    <span
                      className={`rounded-full px-3 py-1 font-mono text-sm font-semibold tracking-widest ${
                        nf?.status === "RUNNING"
                          ? "border border-[#4ecf8f]/40 bg-[#4ecf8f]/10 text-[#4ecf8f]"
                          : "border border-[#e8a84d]/40 bg-[#e8a84d]/10 text-[#e8a84d]"
                      }`}
                    >
                      {nf?.status ?? "UNKNOWN"}
                    </span>
                    <span className="min-w-0 truncate font-mono text-xs text-[#c7d6ea]">{nf?.target ?? "—"}</span>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded border border-white/8 bg-white/[0.02] p-2.5">
                      <p className="mc-stat-mid text-[#5cc6da]"><TweenedNumber value={nf?.pendingReview ?? 0} reducedMotion={reducedMotion} /></p>
                      <p className="mt-0.5 font-mono text-[9px] tracking-widest text-[#8a9bb0]">PENDING</p>
                    </div>
                    <div className="rounded border border-white/8 bg-white/[0.02] p-2.5">
                      <p className="mc-stat-mid text-[#4ecf8f]"><TweenedNumber value={nf?.published ?? 0} reducedMotion={reducedMotion} /></p>
                      <p className="mt-0.5 font-mono text-[9px] tracking-widest text-[#8a9bb0]">PUBLISHED</p>
                    </div>
                    <div className="rounded border border-white/8 bg-white/[0.02] p-2.5">
                      <p
                        className={`mc-stat-mid ${(nf?.warnings ?? 0) > 0 ? "text-[#e86a7c]" : "text-[#8a9bb0]"}`}
                      >
                        <TweenedNumber value={nf?.warnings ?? 0} reducedMotion={reducedMotion} />
                      </p>
                      <p className="mt-0.5 font-mono text-[9px] tracking-widest text-[#8a9bb0]">WARNINGS</p>
                    </div>
                  </div>
                  <p className="mt-3 font-mono text-[11px] leading-relaxed text-[#8a9bb0]">
                    Last post: {nf?.lastPostAt ? `${dhakaStamp(nf.lastPostAt)} (${rel(nf.lastPostAt, nowMs)})` : "—"}
                    {nf?.lastPostUrl ? (
                      <>
                        {" · "}
                        <a
                          href={nf.lastPostUrl}
                          target="_blank"
                          rel="noreferrer"
                          aria-label="Open last NewsFlow post"
                          className="whitespace-nowrap text-[#5cc6da] underline decoration-[#5cc6da]/40 underline-offset-2"
                        >
                          view post ↗
                        </a>
                      </>
                    ) : null}
                  </p>
                </section>

                {/* Live activity (right-rail, mockup position): newest
                    real snapshot events; failures read red. */}
                <section aria-label="Live activity" className="mc-glass mc-fade-in relative p-4">
                  <Corners />
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="mc-hud-label mc-head">Live Activity</h2>
                    <button
                      type="button"
                      aria-label="View all activity in the activity stream"
                      onClick={() => setViewMode("activity")}
                      className="mc-touch shrink-0 font-mono text-[9px] tracking-widest text-[#5cc6da]"
                    >
                      VIEW ALL →
                    </button>
                  </div>
                  {timeline.length === 0 ? (
                    <p className="mt-3 font-mono text-xs leading-relaxed text-[#8a9bb0]">
                      No activity yet — events stream in as snapshots land.
                    </p>
                  ) : (
                    <ol className="mt-3 space-y-1">
                      {timeline.slice(0, 6).map((e) => {
                        const meta = KIND_META[e.kind];
                        return (
                          <li key={e.key} className="mc-feed-item">
                            <button
                              type="button"
                              aria-label={`Activity: ${e.text}`}
                              onClick={() => {
                                const m = matchCronForText(e.text, sortedCrons);
                                if (m) handleSelect(m.id);
                              }}
                              className="flex w-full touch-manipulation items-baseline gap-2.5 rounded-md px-1.5 py-1.5 text-left hover:bg-white/[0.03]"
                            >
                              <span
                                className="w-9 shrink-0 text-center font-mono text-[9px] font-semibold tracking-widest"
                                style={{ color: meta.color }}
                              >
                                {meta.label}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-[12px] leading-snug text-[#c7d6ea]">
                                {e.text}
                              </span>
                              <span className="shrink-0 font-mono text-[9px] tabular-nums text-[#5b6b80]">
                                {dhakaStamp(e.at)}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </section>

                <NextUpPanel crons={sortedCrons} codeMap={codeMap} onSelect={handleSelect} />

                {/* Attention — narrative cards (failures, correlated
                    failures, anomalies) + a quiet list for the rest */}
                <section id="attention-panel" aria-label="Attention feed" className="mc-glass mc-fade-in relative scroll-mt-28 p-4" style={{ animationDelay: "200ms" }}>
                  <Corners />
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="mc-hud-label mc-head">Attention</h2>
                    {attentionOpenCount > 0 ? (
                      <span className="rounded-full border border-[#e86a7c]/40 bg-[#e86a7c]/10 px-2 py-0.5 font-mono text-[10px] tracking-widest text-[#e86a7c]">
                        {attentionOpenCount} OPEN
                      </span>
                    ) : null}
                  </div>
                  {visibleCards.length === 0 && attentionView.quiet.length === 0 ? (
                    <div className="mt-3">
                      <p className="flex items-center gap-2 font-mono text-xs text-[#4ecf8f]">
                        <span className="mc-status mc-status-ok"><span className="mc-status-icon" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5.5L4.2 7.5L8 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></span> OK</span>
                        All quiet — nothing needs you.
                      </p>
                      <p className="mt-2 font-mono text-[11px] leading-relaxed text-[#8a9bb0]">
                        When something needs a decision it lands here first. See what changed recently in the{" "}
                        <a href="#activity-log" className="text-[#5cc6da] underline decoration-[#5cc6da]/40 underline-offset-2">Activity Log</a>{" "}
                        below, or check the durable{" "}
                        <a href="#journal" className="text-[#5cc6da] underline decoration-[#5cc6da]/40 underline-offset-2">Journal</a>{" "}
                        for entries the worker keeps across snapshots.
                      </p>
                    </div>
                  ) : (
                    <>
                      {visibleCards.length > 0 ? (
                        <ul className="mt-3 space-y-2">
                          {visibleCards.map((card) => {
                            const border =
                              card.severity === "action"
                                ? "border-l-[#e86a7c]"
                                : card.severity === "warn"
                                  ? "border-l-[#e8a84d]"
                                  : "border-l-[#5cc6da]";
                            const label =
                              card.severity === "action" ? "ACTION" : card.severity === "warn" ? "WARN" : "INFO";
                            const labelColor =
                              card.severity === "action"
                                ? "text-[#e86a7c] bg-[#e86a7c]/10 border-[#e86a7c]/30"
                                : card.severity === "warn"
                                  ? "text-[#e8a84d] bg-[#e8a84d]/10 border-[#e8a84d]/30"
                                  : "text-[#5cc6da] bg-[#5cc6da]/10 border-[#5cc6da]/30";
                            const cardBg =
                              card.severity === "action"
                                ? "bg-[#e86a7c]/[0.05]"
                                : card.severity === "warn"
                                  ? "bg-[#e8a84d]/[0.04]"
                                  : "bg-white/[0.02]";
                            return (
                              <li
                                key={card.key}
                                className={`rounded-xl border border-white/[0.06] border-l-4 ${border} ${cardBg} p-4`}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <span className={`mc-status rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide ${labelColor}`}>
                                    <SeverityIcon severity={card.severity} />
                                    {label}{card.severity === "action" ? " — ACTION NEEDED" : ""}
                                  </span>
                                  <button
                                    type="button"
                                    aria-label={`Dismiss for this session: ${card.what}`}
                                    onClick={() =>
                                      setDismissedCards((prev) => [...prev, card.key])
                                    }
                                    className="mc-touch flex shrink-0 items-center justify-center rounded border border-white/15 bg-white/5 px-2 font-mono text-[11px] text-[#c7d6ea]"
                                  >
                                    ✕
                                  </button>
                                </div>
                                <p className="mt-2 text-[15px] font-medium leading-snug text-[#e8eef5]">{card.what}</p>
                                {card.why ? (
                                  <p className="mt-2 text-[13px] leading-relaxed text-[#9aa8ba]">
                                    <span className="font-semibold text-[#7d8fa3]">Why: </span>
                                    {card.why}
                                  </p>
                                ) : null}
                                {card.cronId && card.actionLabel ? (
                                  <button
                                    type="button"
                                    aria-label={`${card.actionLabel} — open the unit detail`}
                                    onClick={() => {
                                      if (card.cronId) handleSelect(card.cronId);
                                    }}
                                    className="mc-touch mt-2.5 rounded border border-[#5cc6da]/40 bg-[#5cc6da]/10 px-3 py-1.5 font-mono text-[10px] tracking-widest text-[#5cc6da]"
                                  >
                                    {card.actionLabel.toUpperCase()} →
                                  </button>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                      {attentionView.quiet.length > 0 ? (
                        <>
                          {visibleCards.length > 0 ? (
                            <h3 className="mc-hud-label mt-4">Also noted</h3>
                          ) : null}
                          <ul className="mt-3 space-y-2">
                            {attentionView.quiet.map((a) => {
                              const border =
                                a.severity === "action"
                                  ? "border-l-[#e86a7c]"
                                  : a.severity === "warn"
                                    ? "border-l-[#e8a84d]"
                                    : "border-l-[#5cc6da]";
                              const label =
                                a.severity === "action" ? "ACTION" : a.severity === "warn" ? "WARN" : "INFO";
                              const labelColor =
                                a.severity === "action"
                                  ? "text-[#e86a7c]"
                                  : a.severity === "warn"
                                    ? "text-[#e8a84d]"
                                    : "text-[#5cc6da]";
                              return (
                                <li
                                  key={`${a.index}-${a.text.slice(0, 24)}`}
                                  className={`flex items-start justify-between gap-3 rounded border border-white/8 border-l-4 ${border} bg-white/[0.02] p-3`}
                                >
                                  <div className="min-w-0">
                                    <span className={`mc-status font-mono text-[10px] tracking-widest ${labelColor}`}>
                                      <SeverityIcon severity={a.severity} />
                                      {label}
                                    </span>
                                    <p className="mt-0.5 text-sm leading-snug">{a.text}</p>
                                  </div>
                                  {!travelSnap ? (
                                    <button
                                      type="button"
                                      aria-label={`Dismiss attention item: ${a.text}`}
                                      disabled={resolveMut.isPending}
                                      onClick={() =>
                                        resolveMut.mutate({
                                          index: a.index,
                                          targetKey: targetKeyFor(a),
                                        })
                                      }
                                      className="mc-touch shrink-0 rounded border border-white/15 bg-white/5 px-2 py-1 font-mono text-[11px] text-[#c7d6ea] disabled:opacity-50"
                                    >
                                      Dismiss
                                    </button>
                                  ) : null}
                                </li>
                              );
                            })}
                          </ul>
                        </>
                      ) : null}
                    </>
                  )}
                </section>

                {/* Journal — durable entries from workspace/mission-control/attention.json */}
                <section id="journal" aria-label="Journal" className="mc-glass mc-fade-in relative scroll-mt-28 p-4" style={{ animationDelay: "230ms" }}>
                  <Corners />
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="mc-hud-label mc-head">Journal // Durable Log</h2>
                    <span className="font-mono text-[10px] text-[#5b6b80]">{journalEntries.length} ENTRIES</span>
                  </div>
                  <p className="mt-2 font-mono text-[11px] leading-relaxed text-[#8a9bb0]">
                    Kept on disk across snapshots — the record behind the live Attention feed above.
                  </p>
                  {journal.isPending ? (
                    <div className="mt-3 space-y-2" role="status" aria-label="Loading journal">
                      <div className="mc-skeleton mc-skeleton-line w-3/4" />
                      <div className="mc-skeleton mc-skeleton-line w-1/2" />
                    </div>
                  ) : journal.isError ? (
                    <div
                      role="alert"
                      className="mt-3 rounded border border-dashed border-[#e86a7c]/60 bg-[#e86a7c]/10 p-3"
                    >
                      <p className="font-mono text-xs tracking-widest text-[#ff8fab]">
                        JOURNAL UNAVAILABLE
                      </p>
                      <p className="mt-1 font-mono text-[11px] leading-relaxed text-[#c7d6ea]">
                        The durable log could not be read. Live snapshots above are unaffected — this clears when the journal file is readable again.
                      </p>
                      <button
                        type="button"
                        aria-label="Retry loading journal"
                        onClick={() => void journal.refetch()}
                        className="mc-touch mt-2 rounded border border-[#e86a7c]/50 bg-[#e86a7c]/10 px-3 py-1.5 font-mono text-[10px] tracking-widest text-[#ff8fab]"
                      >
                        RETRY
                      </button>
                    </div>
                  ) : journalEntries.length === 0 ? (
                    <p className="mt-3 font-mono text-xs leading-relaxed text-[#8a9bb0]">
                      No journal entries yet. When the worker writes one it appears here; live changes also flow into the{" "}
                      <a href="#activity-log" className="text-[#5cc6da] underline decoration-[#5cc6da]/40 underline-offset-2">Activity Log</a>{" "}
                      below.
                    </p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {journalEntries.map((a, i) => {
                        const border =
                          a.severity === "action"
                            ? "border-l-[#e86a7c]"
                            : a.severity === "warn"
                              ? "border-l-[#e8a84d]"
                              : "border-l-[#5cc6da]";
                        const label =
                          a.severity === "action" ? "ACTION" : a.severity === "warn" ? "WARN" : "INFO";
                        const labelColor =
                          a.severity === "action"
                            ? "text-[#e86a7c]"
                            : a.severity === "warn"
                              ? "text-[#e8a84d]"
                              : "text-[#5cc6da]";
                        return (
                          <li
                            key={`${i}-${a.text.slice(0, 24)}`}
                            className={`rounded border border-white/8 border-l-4 ${border} bg-white/[0.02] p-3`}
                          >
                            <span className={`mc-status font-mono text-[10px] tracking-widest ${labelColor}`}>
                              <SeverityIcon severity={a.severity} />
                              {label}
                            </span>
                            <p className="mt-0.5 text-sm leading-snug">{a.text}</p>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </div>
            </main>

            {/* Activity log */}
            <section
              id="activity-log"
              aria-label="Activity log"
              className="mc-glass mc-fade-in relative mt-4 scroll-mt-28 p-4 sm:p-5"
              style={{ animationDelay: "260ms" }}
            >
              <Corners />
              <div className="mc-head flex items-center justify-between">
                <h2 className="mc-hud-label">Activity Log // Signal Feed</h2>
                <span className="font-mono text-[10px] tracking-widest text-[#4ecf8f]">
                  <span className="mc-blink">▮</span> LIVE FEED
                </span>
              </div>
              {timeline.length === 0 ? (
                <p className="mt-4 font-mono text-xs leading-relaxed text-[#8a9bb0]">
                  No changes detected yet — the feed builds as new snapshots arrive. Anything that needs you shows up in{" "}
                  <a href="#journal" className="text-[#5cc6da] underline decoration-[#5cc6da]/40 underline-offset-2">Journal</a>{" "}
                  and the Attention panel above.
                </p>
              ) : (
                <ol className="mt-3 grid gap-x-8 gap-y-2 lg:grid-cols-2">
                  {timeline.slice(0, 12).map((e) => {
                    const meta = KIND_META[e.kind];
                    return (
                      <li key={e.key} className="flex items-baseline gap-3 font-mono text-xs">
                        <span
                          className="w-9 shrink-0 text-center text-[10px] font-semibold tracking-widest"
                          style={{ color: meta.color }}
                        >
                          {meta.label}
                        </span>
                        <span className="shrink-0 text-[11px] text-[#5b6b80]">{dhakaStamp(e.at)}</span>
                        <span className="min-w-0 leading-snug text-[#c7d6ea]" style={{ fontFamily: "var(--font-sans)" }}>
                          {e.text}
                        </span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>

            {latest.notes ? (
              <footer className="mc-glass mc-fade-in relative mt-4 p-4" style={{ animationDelay: "320ms" }}>
                <Corners />
                <p className="mc-hud-label mc-head">Notes</p>
                <p className="mt-1 text-sm leading-relaxed text-[#c7d6ea]">{latest.notes}</p>
              </footer>
            ) : null}

            <p className="mt-4 text-center font-mono text-[11px] text-[#5b6b80]">
              {isDegraded ? "LAST GOOD SNAPSHOT " : "SNAPSHOT "}
              {dhakaStamp(latest.takenAt)} DHAKA · AUTO-REFRESH 30S
            </p>
          </>
        )}
        {selectedCron ? (
          <AgentDetailDrawer
            cron={selectedCron}
            code={codeMap.get(selectedCron.id) ?? baseCode(selectedCron)}
            index={selectedIndex}
            total={sortedCrons.length}
            runs={selectedRuns}
            onClose={() => handleSelect(null)}
            onStep={stepSelection}
          />
        ) : null}
        {pins.length > 0 ? (
          <div
            className="fixed inset-x-3 bottom-3 z-40 sm:left-5 sm:right-auto sm:max-w-[72vw]"
            role="region"
            aria-label="Pinned tasks"
          >
            <div className="mc-glass flex items-center gap-2 overflow-x-auto px-3 py-2">
              <span className="mc-hud-label shrink-0">Pinned</span>
              {pins.map((p) => {
                const c = crons.find((x) => x.id === p.id);
                const st = c ? nodeState(c) : null;
                const color = st ? STATE_COLOR[st] : "#5b6b80";
                return (
                  <span
                    key={p.id}
                    className="flex shrink-0 items-center gap-1 rounded-full border border-white/15 bg-white/[0.04] py-1 pl-2.5 pr-1"
                  >
                    <button
                      type="button"
                      aria-label={`Jump to pinned task ${p.title}`}
                      onClick={() => {
                        if (c) handleSelect(c.id);
                      }}
                      className="flex items-center gap-1.5 font-mono text-[10px] tracking-wider text-[#c7d6ea]"
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{
                          background: color,
                          boxShadow: `0 0 6px ${color}`,
                        }}
                        aria-hidden
                      />
                      {p.title}
                    </button>
                    <button
                      type="button"
                      aria-label={`Unpin ${p.title}`}
                      onClick={() =>
                        setPins((prev) => prev.filter((x) => x.id !== p.id))
                      }
                      className="mc-touch flex items-center justify-center rounded-full px-1.5 font-mono text-[11px] text-[#8a9bb0]"
                    >
                      ✕
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        ) : null}
        {toast ? (
          <div
            key={toast.id}
            role="status"
            aria-live="polite"
            className="mc-toast-in mc-glass fixed inset-x-3 bottom-3 z-50 flex items-start gap-3 px-4 py-3 sm:left-auto sm:right-5 sm:w-[340px]"
            style={{
              borderColor: `${toast.tone === "danger" ? "#e86a7c" : "#5cc6da"}66`,
            }}
          >
            <span
              aria-hidden
              className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
              style={{
                background: toast.tone === "danger" ? "#e86a7c" : "#5cc6da",
                boxShadow: `0 0 8px ${toast.tone === "danger" ? "#e86a7c" : "#5cc6da"}`,
              }}
            />
            <button
              type="button"
              aria-label={`Inspect ${toast.title}`}
              onClick={() => {
                if (toast.cronId) handleSelect(toast.cronId);
                setToast(null);
              }}
              className="min-w-0 flex-1 text-left"
            >
              <span
                className="font-mono text-[9px] tracking-[0.22em]"
                style={{ color: toast.tone === "danger" ? "#e86a7c" : "#5cc6da" }}
              >
                {toast.tone === "danger" ? "STATUS ALERT" : "TASK STARTING"}
              </span>
              <span className="mt-0.5 block text-sm leading-snug">
                <span className="font-semibold">{toast.title}</span>{" "}
                {toast.message}
                {toast.extra > 0 ? ` · +${toast.extra} more` : ""}
              </span>
            </button>
            <button
              type="button"
              aria-label="Dismiss status notification"
              onClick={() => setToast(null)}
              className="shrink-0 rounded border border-white/15 bg-white/5 px-2 py-1 font-mono text-[11px] text-[#c7d6ea]"
            >
              ✕
            </button>
          </div>
        ) : null}
        <CommandPalette
          open={paletteOpen}
          query={paletteQuery}
          onQuery={setPaletteQuery}
          groups={paletteGroups}
          flat={paletteFlat}
          activeIndex={paletteIndex}
          onActive={setPaletteIndex}
          onPick={handlePalettePick}
          onClose={closePalette}
          onOpenHelp={() => {
            closePalette();
            setHelpOpen(true);
          }}
          previewItem={previewItem}
          previewRuns={previewRuns}
          previewLogs={previewLogs}
          pinnedIds={pins.map((p) => p.id)}
        />
        <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
        <DiagnosticsPanel
          open={diagOpen}
          onClose={() => setDiagOpen(false)}
          config={visual.config}
          stable={visual.stable}
          onApply={visual.applyConfig}
          onRollback={visual.rollback}
          effectiveTier={visual.effectiveTier}
          device={visual.device}
        />
        <div aria-live="polite" role="status" className="sr-only">
          {announce}
        </div>
      </div>
    </div>
  );
}
