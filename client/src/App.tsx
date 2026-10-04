import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import type { SceneNode } from "./OrbitalScene3D";

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

type ViewMode = "3d" | "2d" | "timeline";

function asSnapshot(v: unknown): Snapshot | null {
  if (typeof v === "object" && v !== null) return v as Snapshot;
  return null;
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
  active: "#00ff88",
  paused: "#ffb24d",
  disabled: "#5b6b80",
  failed: "#ff2d55",
  pending: "#22d3ee",
  running: "#00f0ff",
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
        <span className="inline-block h-2 w-2 rounded-full bg-[#00ff88] shadow-[0_0_6px_#00ff88]" aria-hidden />
        <span className="sr-only">completed</span>
      </span>
    );
  if (s === "failed")
    return (
      <span className="inline-flex items-center gap-1.5" title="failed">
        <span className="inline-block h-2 w-2 rounded-full bg-[#ff2d55] shadow-[0_0_6px_#ff2d55]" aria-hidden />
        <span className="sr-only">failed</span>
      </span>
    );
  if (s === "skipped")
    return (
      <span className="inline-flex items-center gap-1.5" title="skipped">
        <span className="inline-block h-2 w-2 rounded-full bg-[#ffb24d]" aria-hidden />
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
  "run-ok": { label: "OK", color: "#00ff88" },
  "run-fail": { label: "ERR", color: "#ff2d55" },
  status: { label: "INFO", color: "#8a9bb0" },
  newsflow: { label: "NF", color: "#00f0ff" },
  attention: { label: "WARN", color: "#ffb24d" },
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
        style={{ transition: "stroke-dashoffset 0.6s ease", filter: `drop-shadow(0 0 5px ${color})` }}
      />
    </svg>
  );
}

function Waveform() {
  const delays = [0, 0.18, 0.36, 0.1, 0.5, 0.28, 0.62, 0.05];
  const heights = [9, 15, 19, 12, 17, 10, 14, 8];
  return (
    <span className="flex h-5 items-end gap-[3px]" aria-hidden>
      {delays.map((d, i) => (
        <span
          key={i}
          className="mc-eq-bar w-[3px] rounded-sm bg-[#00f0ff]/70"
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
      const n = Math.max(24, Math.round((w * h) / 8500));
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
        g.globalAlpha = tw * 0.85;
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

function OrbitalStage({
  crons,
  codeMap,
  selectedId,
  nextId,
  onSelect,
  nowMs,
  coreLabel,
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
  nowMs: number;
  coreLabel: string;
  animate: boolean;
  hoverId?: string | null;
  onHoverNode?: (id: string | null) => void;
  pulseKey?: string | null;
}) {
  const [elapsed, setElapsed] = useState(0);
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
  useEffect(() => {
    if (!animate) return;
    let raf = 0;
    let acc = 0;
    let last = performance.now();
    const loop = (t: number) => {
      acc += (t - last) * (slowRef.current ? 0.1 : 1);
      last = t;
      setElapsed(acc);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [animate]);

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
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    setStageW(el.clientWidth);
    const ro = new ResizeObserver(() => setStageW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Node diameter (48px) + breathing room, expressed in stage-percent so
  // the separation pass works at any viewport width.
  const nodePct = stageW > 0 ? (53 / stageW) * 100 : 13;
  const maxR = 50 - nodePct / 2 - 0.5;

  const positions = useMemo(() => {
    const pts = placed.map((n) => {
      const speed = RING_SPEEDS[n.ring] ?? 0;
      const radius = RING_RADII[n.ring] ?? 40;
      const a = n.baseAngle + elapsed * speed;
      return { x: 50 + radius * Math.cos(a), y: 50 + radius * Math.sin(a) };
    });
    // Separation pass: nodes on adjacent rings pass through each other as
    // they orbit; on narrow stages that hides a node's code entirely.
    // Push overlapping pairs apart (recomputed from base positions every
    // frame, so the motion stays smooth and jitter-free).
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
  }, [placed, elapsed, nodePct, maxR]);

  const selectedIdx = placed.findIndex((n) => n.cron.id === selectedId);
  const selectedNode = selectedIdx >= 0 ? (placed[selectedIdx] ?? null) : null;
  const selectedPos = selectedIdx >= 0 ? (positions[selectedIdx] ?? null) : null;

  return (
    <div
      ref={stageRef}
      className="relative aspect-square w-full overflow-hidden"
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

      {/* radar sweep */}
      <div className="mc-radar-sweep pointer-events-none absolute inset-[3%] rounded-full" aria-hidden />

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
          const p = positions[idx] ?? { x: 50, y: 50 };
          const st = nodeState(n.cron);
          const isSel = n.cron.id === selectedId;
          return (
            <line
              key={`link-${n.cron.id}`}
              x1={50}
              y1={50}
              x2={p.x}
              y2={p.y}
              stroke={isSel ? "#00f0ff" : STATE_COLOR[st]}
              strokeOpacity={isSel ? 0.85 : st === "disabled" ? 0.10 : 0.28}
              strokeWidth={isSel ? 0.35 : 0.16}
            />
          );
        })}
        {selectedPos ? (
          <circle cx={selectedPos.x} cy={selectedPos.y} r={3.6} fill="none" stroke="#00f0ff" strokeWidth={0.3} />
        ) : null}
      </svg>

      {/* rotating dashed halos around the core */}
      <div
        className="mc-spin-slow pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[38%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-[#00f0ff]/25"
        aria-hidden
      />
      <div
        className="mc-spin-rev pointer-events-none absolute left-1/2 top-1/2 aspect-square w-[47%] -translate-x-1/2 -translate-y-1/2 rounded-full border border-[#00f0ff]/10"
        aria-hidden
      />

      {/* core = NewsFlow */}
      <button
        type="button"
        aria-label="Show mission overview"
        onClick={() => onSelect(null)}
        className={`absolute left-1/2 top-1/2 flex h-20 w-20 -translate-x-1/2 -translate-y-1/2 flex-col items-center justify-center rounded-full border border-[#00f0ff]/50 bg-[#04121c]/90 text-center shadow-[0_0_28px_rgba(0,240,255,0.35)] sm:h-24 sm:w-24 ${
          corePulse ? "mc-core-pulse" : ""
        }`}
      >
        <span className="mc-live-dot h-2 w-2 rounded-full bg-[#00f0ff]" aria-hidden />
        <span className="mt-1 font-mono text-[8px] tracking-[0.22em] text-[#8a9bb0]">CORE</span>
        <span className="max-w-[4.5rem] truncate px-1 font-mono text-[10px] font-semibold tracking-widest text-[#00f0ff]">
          {coreLabel}
        </span>
      </button>

      {/* orbiting agent nodes */}
      {placed.map((n, idx) => {
        const p = positions[idx] ?? { x: 50, y: 50 };
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
            type="button"
            aria-label={`${n.cron.title ?? n.cron.id}, ${STATE_LABEL[st]}${st === "pending" ? ", queued and waiting to execute" : st === "running" ? ", executing now" : ""}${isNext ? ", runs next" : ""}${isSel ? ", selected" : ""}`}
            aria-pressed={isSel}
            onClick={() => onSelect(isSel ? null : n.cron.id)}
            onMouseEnter={() => onHoverNode?.(n.cron.id)}
            onMouseLeave={() => onHoverNode?.(null)}
            onFocus={() => onHoverNode?.(n.cron.id)}
            onBlur={() => onHoverNode?.(null)}
            className={`mc-node-btn absolute flex h-12 w-12 -translate-x-1/2 -translate-y-1/2 touch-manipulation flex-col items-center justify-center rounded-full border bg-[#04121c]/92 font-mono backdrop-blur-sm ${
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
              left: `${p.x}%`,
              top: `${p.y}%`,
              borderColor: isSel ? "#00f0ff" : isNext ? "#e6f1ff" : `${color}88`,
              color,
              boxShadow: isSel
                ? "0 0 0 2px rgba(0,240,255,0.5), 0 0 22px rgba(0,240,255,0.55)"
                : isNext
                  ? `0 0 0 1.5px rgba(230,241,255,0.75), 0 0 14px ${color}66`
                  : st === "disabled"
                    ? "none"
                    : `0 0 12px ${color}55`,
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
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeDasharray={st === "pending" ? "4 3" : RING_C}
                  strokeDashoffset={st === "pending" ? 0 : RING_C * (1 - frac)}
                  style={{ transition: "stroke-dashoffset 1s linear", filter: `drop-shadow(0 0 3px ${color})` }}
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
  nowMs,
}: {
  crons: CronItem[];
  codeMap: Map<string, string>;
  selectedId: string | null;
  hoverId: string | null;
  onSelect: (id: string | null) => void;
  onHover: (id: string | null) => void;
  nowMs: number;
}) {
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
              className="absolute top-0 -translate-x-1/2 rounded-sm bg-[#00f0ff] px-1 py-px font-mono text-[8px] font-semibold tracking-[0.14em] text-[#04121c]"
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
                      isSel ? "bg-[#00f0ff]/10" : isHover ? "bg-white/[0.04]" : ""
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
                          {failed && st !== "running" && st !== "pending" ? <span className="text-[#ff2d55]"> · LAST FAILED</span> : null}
                        </span>
                      </span>
                    </span>
                    <span className="relative h-7 flex-1" aria-hidden>
                      {last != null && last >= startMs && last <= nowMs ? (
                        <span
                          className="absolute top-1/2 h-[10px] w-[10px] -translate-x-1/2 -translate-y-1/2 rounded-full border bg-transparent"
                          style={{
                            left: `${((last - startMs) / spanMs) * 100}%`,
                            borderColor: failed ? "#ff2d55" : "rgba(255,255,255,0.25)",
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
                    isSel ? "bg-[#00f0ff]/10" : ""
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
      <div className="w-[min(420px,86vw)] font-mono text-[11px] leading-6 text-[#00f0ff]">
        {lines.map((l, i) => (
          <p key={l} className="mc-fade-in" style={{ animationDelay: `${i * 130}ms` }}>
            {l}
          </p>
        ))}
        <p className="mc-blink mt-2 text-[#00ff88]">▮ ESTABLISHING UPLINK…</p>
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

/* ---------- app ---------- */

export function App() {
  const queryClient = useQueryClient();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [fleetFilter, setFleetFilter] = useState<"all" | "active" | "pending" | "running" | "issues" | "standby">("all");
  // Stage views: 3D WebGL orbit (default on wide screens), flat 2D orbit
  // (default where the 3D orbit can't fit), and the 24h Timeline.
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const stored = window.sessionStorage.getItem("mc-view");
      if (stored === "3d" || stored === "2d" || stored === "timeline") return stored;
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

  // Live clock: countdowns and the "updated Xs ago" line tick at
  // 200ms cadence (at most one text update per 200ms — no per-frame
  // thrash). Values are second-granular, so the visible digit changes
  // once a second, but never lags a minute/second boundary by more
  // than 200ms.
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 200);
    return () => clearInterval(t);
  }, []);

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
    queryFn: () => api.getDashboard({}),
    refetchInterval: 30_000,
  });

  const journal = useQuery({
    queryKey: ["journal"],
    queryFn: () => api.loadJournal({}),
    refetchInterval: 60_000,
  });
  const journalEntries = journal.data?.entries ?? [];

  const resolveMut = useMutation({
    mutationFn: (index: number) => api.resolveAttention({ index }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
  });

  const data: Dashboard | undefined = dash.data;
  const latest = useMemo(() => asSnapshot(data?.latest), [data]);
  const history = useMemo(
    () =>
      (data?.history ?? [])
        .map(asSnapshot)
        .filter((v): v is Snapshot => v !== null),
    [data],
  );

  const takenAtMs = latest?.takenAt ? new Date(latest.takenAt).getTime() : NaN;
  const ageSec = Number.isNaN(takenAtMs)
    ? null
    : Math.max(0, Math.round((nowMs - takenAtMs) / 1000));
  // Worker pushes every 10 minutes; flag stale only once a full push
  // window (plus grace) has been missed.
  const isStale = ageSec !== null && ageSec > 900;
  const staleLabel =
    ageSec === null
      ? ""
      : ageSec >= 3600
        ? `LAST UPDATE ${Math.floor(ageSec / 3600)}H AGO`
        : `LAST UPDATE ${Math.max(1, Math.round(ageSec / 60))}M AGO`;
  const freshPct =
    ageSec === null ? 0 : Math.min(100, Math.round((ageSec / 900) * 100));
  const freshness = (() => {
    if (ageSec === null) return "no snapshot yet";
    if (ageSec < 5) return "updated just now";
    if (ageSec < 60) return `updated ${ageSec}s ago`;
    if (ageSec < 3600) {
      const m = Math.floor(ageSec / 60);
      const s = ageSec % 60;
      return s > 0 ? `updated ${m}m ${s}s ago` : `updated ${m}m ago`;
    }
    return `updated ${Math.floor(ageSec / 3600)}h ago`;
  })();

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

  /* ----- cross-snapshot watch (ingest flash + status-flip toast) ----- */

  const seenSnapKeyRef = useRef<string | null>(null);
  const prevCronStatesRef = useRef<Map<string, NodeState> | null>(null);
  const toastSeqRef = useRef(0);
  const [flashNonce, setFlashNonce] = useState(0);
  const [toast, setToast] = useState<StatusToast | null>(null);

  useEffect(() => {
    if (!snapshotKey) return;
    const seenKey = seenSnapKeyRef.current;
    if (seenKey === snapshotKey) return;
    seenSnapKeyRef.current = snapshotKey;
    const curr = new Map<string, NodeState>();
    for (const c of crons) curr.set(c.id, nodeState(c));
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
    for (const c of crons) {
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
  }, [snapshotKey, crons]);

  // Toasts are short-lived: one at a time, auto-dismissed after ~6s.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 6000);
    return () => window.clearTimeout(t);
  }, [toast]);
  const show3d = viewMode === "3d" && !webglFailed;

  // The core IS the NewsFlow agent, so its glow follows NewsFlow's own
  // status (not the fleet's worst node — that made a RUNNING core burn
  // red whenever any schedule's last run failed).
  const coreSceneState = useMemo<NodeState>(() => {
    const s = (latest?.newsflow?.status ?? "").toUpperCase();
    if (s === "RUNNING") return "active";
    if (s) return "paused";
    return "disabled";
  }, [latest]);

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

  // Escape clears the selection; arrow keys cycle through the fleet
  // order so the wall can be driven entirely from the keyboard.
  // Keys 1/2/3 switch the stage view (3D / 2D / 24H timeline).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedId(null);
        return;
      }
      if (
        (e.key === "1" || e.key === "2" || e.key === "3") &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey
      ) {
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") {
          setViewMode(e.key === "1" ? "3d" : e.key === "2" ? "2d" : "timeline");
        }
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
  }, [selectedId, sortedCrons]);

  const issueCount = useMemo(
    () => crons.filter((c) => c.lastRunStatus === "failed" || c.status === "paused").length,
    [crons],
  );

  const visibleFleet = useMemo(() => {
    if (fleetFilter === "all") return sortedCrons;
    return sortedCrons.filter((c) => {
      const st = nodeState(c);
      if (fleetFilter === "active") return st === "active";
      if (fleetFilter === "pending") return st === "pending";
      if (fleetFilter === "running") return st === "running";
      if (fleetFilter === "issues") return st === "failed" || st === "paused";
      return st === "disabled";
    });
  }, [sortedCrons, fleetFilter]);

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
      nowMs={nowMs}
      coreLabel={nf?.status ?? "—"}
      animate={!reducedMotion}
      hoverId={hoverId}
      onHoverNode={setHoverId}
      pulseKey={snapshotKey}
    />
  );

  return (
    <div className="mc-root mc-grid-bg relative min-h-screen" style={{ background: "var(--bg)", color: "var(--text)" }}>
      {/* CRT layer */}
      <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden" aria-hidden>
        <div className="mc-scanlines absolute inset-0" />
        <div className="mc-scanbar absolute inset-x-0 top-0" />
      </div>
      {!booted ? <BootOverlay /> : null}

      <div className="relative z-10 mx-auto w-full max-w-[1440px] px-3 pb-10 sm:px-5">
        {/* Sticky status bar: clock + freshness stay in reach while scrolling */}
        <div className="sticky top-0 z-30 -mx-3 bg-[#04070c]/85 px-3 pb-2.5 pt-4 backdrop-blur-md sm:-mx-5 sm:px-5">
        {/* Topbar */}
        <header className="mc-fade-in flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex items-center gap-3">
            <span className="mc-live-dot h-2.5 w-2.5 rounded-full bg-[#00f0ff]" aria-hidden />
            <h1
              className="text-base tracking-[0.28em] text-[#e6f1ff] sm:text-xl"
              style={{ fontFamily: "var(--font-display)", fontWeight: 700 }}
            >
              MISSION CONTROL
            </h1>
            <span className="rounded border border-[#00f0ff]/30 bg-[#00f0ff]/10 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-[#00f0ff]">
              LIVE
            </span>
            {isStale && (
              <span className="tabular-nums rounded border border-[#ffb24d]/45 bg-[#ffb24d]/10 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-[#ffb24d]">
                STALE — {staleLabel}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px] text-[#8a9bb0]">
            {latest ? (
              <>
                <span>
                  ACTIVE <span className="text-[#00ff88]"><TweenedNumber value={activeCount} reducedMotion={reducedMotion} /></span>
                </span>
                {pendingCount > 0 ? (
                  <span>
                    PENDING <span className="text-[#22d3ee]"><TweenedNumber value={pendingCount} reducedMotion={reducedMotion} /></span>
                  </span>
                ) : null}
                {runningCount > 0 ? (
                  <span>
                    RUNNING <span className="text-[#00f0ff]"><TweenedNumber value={runningCount} reducedMotion={reducedMotion} /></span>
                  </span>
                ) : null}
                <span>
                  STANDBY <span className="text-[#ffb24d]"><TweenedNumber value={standbyCount} reducedMotion={reducedMotion} /></span>
                </span>
                <span>
                  ALERT{" "}
                  <span className={attention.length + failedCount > 0 ? "text-[#ff2d55]" : "text-[#00ff88]"}>
                    <TweenedNumber value={attention.length + failedCount} reducedMotion={reducedMotion} />
                  </span>
                </span>
              </>
            ) : null}
            <span aria-label="Current time in Dhaka" className="tabular-nums">DHAKA {dhakaTime(new Date(nowMs))}</span>
            <span
              key={snapshotKey ?? "awaiting"}
              aria-label="Data freshness"
              className={`mc-updated-pulse tabular-nums ${isStale ? "text-[#ffb24d]" : "text-[#00f0ff]"}`}
            >
              {latest ? freshness : "awaiting data"}
            </span>
          </div>
        </header>
        {latest ? (
          <div
            className="mc-fresh-track mt-2.5"
            role="img"
            aria-label={
              isStale
                ? "Snapshot is stale — more than 15 minutes old"
                : `Snapshot freshness window: ${freshPct}% elapsed`
            }
          >
            <div
              className="mc-fresh-fill"
              style={{
                width: `${freshPct}%`,
                background: isStale
                  ? "#ffb24d"
                  : freshPct > 66
                    ? "#ffb24d"
                    : "#00ff88",
              }}
            />
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

        {dash.isPending ? (
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
        ) : dash.isError ? (
          <div className="mc-glass relative mt-6 p-10 text-center">
            <Corners />
            <p className="font-mono text-sm text-[#ff2d55]">UPLINK FAILED — dashboard did not load.</p>
            <button
              type="button"
              aria-label="Retry loading dashboard"
              onClick={() => void dash.refetch()}
              className="mt-4 rounded border border-[#00f0ff]/40 bg-[#00f0ff]/10 px-4 py-2 font-mono text-xs tracking-widest text-[#00f0ff]"
            >
              RETRY
            </button>
          </div>
        ) : !latest ? (
          <div className="mc-glass mc-fade-in relative mt-6 p-10 text-center">
            <Corners />
            <div className="relative mx-auto mb-5 h-28 w-28">
              <div className="mc-radar-sweep absolute inset-0 rounded-full" aria-hidden />
              <div className="absolute inset-0 rounded-full border border-[#00f0ff]/25" aria-hidden />
              <div className="absolute inset-[22%] rounded-full border border-[#00f0ff]/20" aria-hidden />
              <div className="absolute inset-[40%] rounded-full border border-[#00f0ff]/15" aria-hidden />
              <span className="mc-live-dot absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#00f0ff]" aria-hidden />
            </div>
            <h2
              className="text-sm tracking-[0.25em]"
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
          </div>
        ) : (
          <>
            <main className="mc-layout-grid mt-4">
              {/* Center stage */}
              <section
                aria-label="Agent fleet stage"
                className="mc-glass mc-fade-in mc-area-stage relative"
                style={{ animationDelay: "40ms" }}
              >
                <Corners />
                <div className="mc-core-glow pointer-events-none absolute inset-0" aria-hidden />
                <div className="mc-head relative flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 pt-3">
                  <h2 className="mc-hud-label min-w-0 flex-[1_1_9rem] sm:flex-none">
                    {viewMode === "timeline" ? "Timeline // Next 24 Hours" : "Orbital Ops // Agent Fleet"}
                  </h2>
                  <div className="flex flex-wrap items-center gap-2">
                    <Waveform />
                    <span className="hidden font-mono text-[10px] tracking-widest text-[#8a9bb0] sm:inline">
                      SYS <span className="text-[#00ff88]"><TweenedNumber value={Math.round(onlinePct * 100)} reducedMotion={reducedMotion} />%</span>
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
                            ? "border-[#00f0ff]/60 bg-[#00f0ff]/15 text-[#00f0ff]"
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
                            ? "border-[#00f0ff]/60 bg-[#00f0ff]/15 text-[#00f0ff]"
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
                            ? "border-[#00f0ff]/60 bg-[#00f0ff]/15 text-[#00f0ff]"
                            : "border-white/10 bg-white/[0.03] text-[#8a9bb0]"
                        }`}
                      >
                        24H
                      </button>
                      <button
                        type="button"
                        aria-label={soundOn ? "Mute interface sounds" : "Enable interface sounds"}
                        aria-pressed={soundOn}
                        onClick={toggleSound}
                        className={`touch-manipulation mc-touch mc-interactive rounded-sm border px-3 py-2 font-mono text-[9.5px] tracking-widest transition-colors ${
                          soundOn
                            ? "border-[#00ff88]/50 bg-[#00ff88]/10 text-[#00ff88]"
                            : "border-white/10 bg-white/[0.03] text-[#8a9bb0]"
                        }`}
                      >
                        SND {soundOn ? "ON" : "OFF"}
                      </button>
                    </div>
                  </div>
                </div>
                <div className="relative">
                  {viewMode === "timeline" ? (
                    <Timeline24h
                      crons={sortedCrons}
                      codeMap={codeMap}
                      selectedId={selectedCron?.id ?? null}
                      hoverId={hoverId}
                      onSelect={handleSelect}
                      onHover={setHoverId}
                      nowMs={nowMs}
                    />
                  ) : show3d ? (
                    <Suspense fallback={orbitalStage}>
                      <OrbitalScene3D
                        nodes={sceneNodes}
                        selectedId={selectedCron?.id ?? null}
                        coreState={coreSceneState}
                        coreLabel={nf?.status ?? "—"}
                        animate={!reducedMotion}
                        hudTime={dhakaTime(new Date(nowMs))}
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
                {viewMode === "timeline" ? (
                  <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 font-mono text-[10px] tracking-widest text-[#8a9bb0]">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-[10px] w-[5px] rounded-[2px] bg-[#00f0ff]/60" aria-hidden /> SCHEDULED RUN
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-[10px] w-[14px] rounded-[2px] border border-dashed border-[#22d3ee]" aria-hidden /> PENDING (QUEUED)
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-[10px] w-[14px] rounded-[2px] bg-[#00f0ff] shadow-[0_0_6px_#00f0ff]" aria-hidden /> RUNNING NOW
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-[10px] w-[10px] rounded-full border border-[#ff2d55]" aria-hidden /> LAST RUN FAILED
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="h-[2px] w-4 bg-[#00f0ff] shadow-[0_0_6px_#00f0ff]" aria-hidden /> NOW
                    </span>
                    {nextUp ? (
                      <span className="ml-auto min-w-0 max-w-full truncate text-[#e6f1ff]">
                        NEXT: <span className="text-[#00f0ff]">{nextUp.title ?? nextUp.id}</span> ·{" "}
                        {countdownLabel(toMs(nextUp.nextRunAt), nowMs)} · {cadencePlain(nextUp.cadence)}
                      </span>
                    ) : null}
                  </div>
                ) : (
                <div className="relative flex flex-wrap items-center gap-x-4 gap-y-1 px-4 pb-3 font-mono text-[10px] tracking-widest text-[#8a9bb0]">
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#00ff88]" /> ACTIVE
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-[2px] border border-dashed border-[#22d3ee]" /> PENDING
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#00f0ff] shadow-[0_0_6px_#00f0ff]" /> RUNNING
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#ffb24d]" /> PAUSED
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#5b6b80]" /> DISABLED
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#ff2d55]" /> LAST RUN FAILED
                  </span>
                  {nextUp ? (
                    <span className="ml-auto min-w-0 max-w-full truncate text-[#e6f1ff]">
                      NEXT UP <span className="text-[#00f0ff]">{nextUp.title ?? nextUp.id}</span> ·{" "}
                      {rel(nextUp.nextRunAt, nowMs)}
                    </span>
                  ) : (
                    <span className="ml-auto">TAP A NODE FOR DETAIL</span>
                  )}
                </div>
                )}
              </section>

              {/* Left rail: fleet list */}
              <aside
                aria-label="Fleet list"
                className="mc-glass mc-fade-in mc-area-fleet relative"
                style={{ animationDelay: "100ms" }}
              >
                <Corners />
                <div className="mc-head flex items-center justify-between px-4 pt-3">
                  <h2 className="mc-hud-label">Fleet // Schedules</h2>
                  <span className="font-mono text-[10px] text-[#5b6b80]">{crons.length} UNITS</span>
                </div>
                <div className="flex flex-wrap gap-1.5 px-4 pt-2.5" role="group" aria-label="Filter fleet by status">
                  {(
                    [
                      { key: "all", label: "ALL", count: crons.length },
                      { key: "active", label: "ACTIVE", count: activeCount },
                      { key: "pending", label: "PENDING", count: pendingCount },
                      { key: "running", label: "RUNNING", count: runningCount },
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
                        aria-label={`Show ${f.label.toLowerCase()} schedules (${f.count})`}
                        aria-pressed={isOn}
                        onClick={() => setFleetFilter(f.key)}
                        className={`touch-manipulation mc-touch mc-interactive rounded-full border px-3 py-2 font-mono text-[9.5px] tracking-widest transition-colors ${
                          isOn
                            ? "border-[#00f0ff]/60 bg-[#00f0ff]/15 text-[#00f0ff]"
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
                        <a href="#activity-log" className="text-[#00f0ff] underline decoration-[#00f0ff]/40 underline-offset-2">Activity Log</a>.
                      </>
                    ) : (
                      <>
                        No units match this filter. Try another filter above, or see what changed in the{" "}
                        <a href="#activity-log" className="text-[#00f0ff] underline decoration-[#00f0ff]/40 underline-offset-2">Activity Log</a>.
                      </>
                    )}
                  </p>
                ) : (
                  <ul className="mt-2 max-h-[520px] divide-y divide-white/5 overflow-y-auto px-2 pb-2">
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
                            className={`flex w-full touch-manipulation items-center gap-3 rounded-md px-2 py-2.5 text-left transition-colors ${
                              isSel
                                ? "bg-[#00f0ff]/10"
                                : st === "failed"
                                  ? "bg-[#ff2d55]/[0.05] hover:bg-[#ff2d55]/[0.09]"
                                  : "hover:bg-white/[0.03] active:bg-white/[0.06]"
                            }`}
                          >
                            <span
                              className="flex h-8 min-w-8 shrink-0 items-center justify-center border px-1 font-mono text-[10px] font-semibold"
                              style={{
                                borderColor: `${color}77`,
                                color,
                                borderRadius: st === "pending" ? 6 : 999,
                                borderStyle: st === "pending" ? "dashed" : "solid",
                              }}
                            >
                              {codeMap.get(c.id) ?? baseCode(c)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[13px] font-medium leading-tight">
                                {c.title ?? c.id}
                              </span>
                              <span className="block truncate font-mono text-[10px] text-[#5b6b80]">
                                {c.cadence ?? "—"} ·{" "}
                                {st === "running" ? (
                                  <span style={{ color }}>RUNNING NOW</span>
                                ) : st === "pending" ? (
                                  <span style={{ color }}>QUEUED {rel(c.nextRunAt, nowMs)}</span>
                                ) : (
                                  <>
                                    next{" "}
                                    <span
                                      className={`tabular-nums${
                                        c.nextRunAt &&
                                        new Date(c.nextRunAt).getTime() - nowMs <= 10 * 60_000 &&
                                        new Date(c.nextRunAt).getTime() > nowMs
                                          ? " text-[#ffb24d]"
                                          : ""
                                      }`}
                                    >
                                      {rel(c.nextRunAt, nowMs)}
                                    </span>
                                  </>
                                )}
                              </span>
                            </span>
                            <span className="flex shrink-0 items-center gap-1.5">
                              <span
                                className="flex items-center gap-1 font-mono text-[8px] tracking-widest"
                                style={{ color }}
                              >
                                <StatusIcon state={st} />
                                <span className="hidden xl:inline">{STATE_LABEL[st]}</span>
                              </span>
                              <span
                                className="h-2 w-2 shrink-0 rounded-full"
                                style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                                aria-hidden
                              />
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </aside>

              {/* Right column: detail + newsflow + attention */}
              <div className="mc-area-side flex flex-col gap-4">
                {selectedCron ? (
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
                      <p className="mt-3 rounded border border-[#22d3ee]/35 bg-[#22d3ee]/[0.07] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#a5f3fc]">
                        QUEUED — runs next. This run is waiting in the scheduler queue
                        {selectedCron.nextRunAt ? ` and fires ${rel(selectedCron.nextRunAt, nowMs)} (${dhakaStamp(selectedCron.nextRunAt)} Dhaka)` : ""}.
                      </p>
                    ) : null}
                    {nodeState(selectedCron) === "running" ? (
                      <p className="mt-3 rounded border border-[#00f0ff]/40 bg-[#00f0ff]/[0.08] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#cffafe]">
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
                        <dd className="mt-1 font-mono text-sm text-[#00f0ff]">{rel(selectedCron.nextRunAt, nowMs)}</dd>
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
                        <Gauge value={onlinePct} color={onlinePct >= 0.5 ? "#00ff88" : "#ffb24d"} />
                        <span className="absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold">
                          <TweenedNumber value={Math.round(onlinePct * 100)} reducedMotion={reducedMotion} />%
                        </span>
                      </div>
                      <div className="font-mono text-[11px] leading-5 text-[#8a9bb0]">
                        <p>
                          <span className="text-[#00ff88]"><TweenedNumber value={activeCount} reducedMotion={reducedMotion} /></span> ACTIVE
                        </p>
                        <p>
                          <span className="text-[#22d3ee]"><TweenedNumber value={pendingCount} reducedMotion={reducedMotion} /></span> PENDING
                        </p>
                        <p>
                          <span className="text-[#00f0ff]"><TweenedNumber value={runningCount} reducedMotion={reducedMotion} /></span> RUNNING
                        </p>
                        <p>
                          <span className="text-[#ffb24d]"><TweenedNumber value={standbyCount} reducedMotion={reducedMotion} /></span> STANDBY
                        </p>
                        <p>
                          <span className={failedCount > 0 ? "text-[#ff2d55]" : "text-[#8a9bb0]"}><TweenedNumber value={failedCount} reducedMotion={reducedMotion} /></span>{" "}
                          FAILED LAST RUN
                        </p>
                        <p>
                          <span className={attention.length > 0 ? "text-[#ff2d55]" : "text-[#00ff88]"}>
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
                          ? "border border-[#00ff88]/40 bg-[#00ff88]/10 text-[#00ff88]"
                          : "border border-[#ffb24d]/40 bg-[#ffb24d]/10 text-[#ffb24d]"
                      }`}
                    >
                      {nf?.status ?? "UNKNOWN"}
                    </span>
                    <span className="min-w-0 truncate font-mono text-xs text-[#c7d6ea]">{nf?.target ?? "—"}</span>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded border border-white/8 bg-white/[0.02] p-2.5">
                      <p className="mc-stat-mid text-[#00f0ff]"><TweenedNumber value={nf?.pendingReview ?? 0} reducedMotion={reducedMotion} /></p>
                      <p className="mt-0.5 font-mono text-[9px] tracking-widest text-[#8a9bb0]">PENDING</p>
                    </div>
                    <div className="rounded border border-white/8 bg-white/[0.02] p-2.5">
                      <p className="mc-stat-mid text-[#00ff88]"><TweenedNumber value={nf?.published ?? 0} reducedMotion={reducedMotion} /></p>
                      <p className="mt-0.5 font-mono text-[9px] tracking-widest text-[#8a9bb0]">PUBLISHED</p>
                    </div>
                    <div className="rounded border border-white/8 bg-white/[0.02] p-2.5">
                      <p
                        className={`mc-stat-mid ${(nf?.warnings ?? 0) > 0 ? "text-[#ff2d55]" : "text-[#8a9bb0]"}`}
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
                          className="whitespace-nowrap text-[#00f0ff] underline decoration-[#00f0ff]/40 underline-offset-2"
                        >
                          view post ↗
                        </a>
                      </>
                    ) : null}
                  </p>
                </section>

                {/* Attention */}
                <section aria-label="Attention feed" className="mc-glass mc-fade-in relative p-4" style={{ animationDelay: "200ms" }}>
                  <Corners />
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="mc-hud-label mc-head">Attention</h2>
                    {attention.length > 0 ? (
                      <span className="rounded-full border border-[#ff2d55]/40 bg-[#ff2d55]/10 px-2 py-0.5 font-mono text-[10px] tracking-widest text-[#ff2d55]">
                        {attention.length} OPEN
                      </span>
                    ) : null}
                  </div>
                  {attention.length === 0 ? (
                    <div className="mt-3">
                      <p className="flex items-center gap-2 font-mono text-xs text-[#00ff88]">
                        <span className="mc-status mc-status-ok"><span className="mc-status-icon" aria-hidden="true"><svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M2 5.5L4.2 7.5L8 2.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></span> OK</span>
                        All clear — nothing needs you.
                      </p>
                      <p className="mt-2 font-mono text-[11px] leading-relaxed text-[#8a9bb0]">
                        When something needs a decision it lands here first. See what changed recently in the{" "}
                        <a href="#activity-log" className="text-[#00f0ff] underline decoration-[#00f0ff]/40 underline-offset-2">Activity Log</a>{" "}
                        below, or check the durable{" "}
                        <a href="#journal" className="text-[#00f0ff] underline decoration-[#00f0ff]/40 underline-offset-2">Journal</a>{" "}
                        for entries the worker keeps across snapshots.
                      </p>
                    </div>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {attention.map((a, i) => {
                        const border =
                          a.severity === "action"
                            ? "border-l-[#ff2d55]"
                            : a.severity === "warn"
                              ? "border-l-[#ffb24d]"
                              : "border-l-[#00f0ff]";
                        const label =
                          a.severity === "action" ? "ACTION" : a.severity === "warn" ? "WARN" : "INFO";
                        const labelColor =
                          a.severity === "action"
                            ? "text-[#ff2d55]"
                            : a.severity === "warn"
                              ? "text-[#ffb24d]"
                              : "text-[#00f0ff]";
                        return (
                          <li
                            key={`${i}-${a.text.slice(0, 24)}`}
                            className={`flex items-start justify-between gap-3 rounded border border-white/8 border-l-4 ${border} bg-white/[0.02] p-3`}
                          >
                            <div className="min-w-0">
                              <span className={`mc-status font-mono text-[10px] tracking-widest ${labelColor}`}>
                                <SeverityIcon severity={a.severity} />
                                {label}
                              </span>
                              <p className="mt-0.5 text-sm leading-snug">{a.text}</p>
                            </div>
                            <button
                              type="button"
                              aria-label={`Dismiss attention item: ${a.text}`}
                              disabled={resolveMut.isPending}
                              onClick={() => resolveMut.mutate(i)}
                              className="shrink-0 rounded border border-white/15 bg-white/5 px-2 py-1 font-mono text-[11px] text-[#c7d6ea] disabled:opacity-50"
                            >
                              Dismiss
                            </button>
                          </li>
                        );
                      })}
                    </ul>
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
                  ) : journalEntries.length === 0 ? (
                    <p className="mt-3 font-mono text-xs leading-relaxed text-[#8a9bb0]">
                      No journal entries yet. When the worker writes one it appears here; live changes also flow into the{" "}
                      <a href="#activity-log" className="text-[#00f0ff] underline decoration-[#00f0ff]/40 underline-offset-2">Activity Log</a>{" "}
                      below.
                    </p>
                  ) : (
                    <ul className="mt-3 space-y-2">
                      {journalEntries.map((a, i) => {
                        const border =
                          a.severity === "action"
                            ? "border-l-[#ff2d55]"
                            : a.severity === "warn"
                              ? "border-l-[#ffb24d]"
                              : "border-l-[#00f0ff]";
                        const label =
                          a.severity === "action" ? "ACTION" : a.severity === "warn" ? "WARN" : "INFO";
                        const labelColor =
                          a.severity === "action"
                            ? "text-[#ff2d55]"
                            : a.severity === "warn"
                              ? "text-[#ffb24d]"
                              : "text-[#00f0ff]";
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
                <span className="font-mono text-[10px] tracking-widest text-[#00ff88]">
                  <span className="mc-blink">▮</span> LIVE FEED
                </span>
              </div>
              {timeline.length === 0 ? (
                <p className="mt-4 font-mono text-xs leading-relaxed text-[#8a9bb0]">
                  No changes detected yet — the feed builds as new snapshots arrive. Anything that needs you shows up in{" "}
                  <a href="#journal" className="text-[#00f0ff] underline decoration-[#00f0ff]/40 underline-offset-2">Journal</a>{" "}
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
              SNAPSHOT {dhakaStamp(latest.takenAt)} DHAKA · AUTO-REFRESH 30S
            </p>
          </>
        )}
        {toast ? (
          <div
            key={toast.id}
            role="status"
            aria-live="polite"
            className="mc-toast-in mc-glass fixed inset-x-3 bottom-3 z-50 flex items-start gap-3 px-4 py-3 sm:left-auto sm:right-5 sm:w-[340px]"
            style={{
              borderColor: `${toast.tone === "danger" ? "#ff2d55" : "#00f0ff"}66`,
            }}
          >
            <span
              aria-hidden
              className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full"
              style={{
                background: toast.tone === "danger" ? "#ff2d55" : "#00f0ff",
                boxShadow: `0 0 8px ${toast.tone === "danger" ? "#ff2d55" : "#00f0ff"}`,
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
                style={{ color: toast.tone === "danger" ? "#ff2d55" : "#00f0ff" }}
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
      </div>
    </div>
  );
}
