import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/* Evolving-system infrastructure (2026-10-04 pass).
   Stability > performance > UX > visual innovation.
   Everything here is local, advisory, and reversible: no personal data,
   no automatic production changes, and the default visual config is
   exactly the pre-pass behaviour. */

export type QualityTier = "PERFORMANCE" | "BALANCED" | "HIGH" | "ULTRA";
export const TIER_ORDER: QualityTier[] = ["PERFORMANCE", "BALANCED", "HIGH", "ULTRA"];

export type TierParams = {
  particleCount: number;
  bloom: boolean;
  bloomStrength: number;
  pixelRatioCap: number;
  connectionAnimation: boolean;
  lighting: "basic" | "standard" | "advanced";
};

export const TIER_PARAMS: Record<QualityTier, TierParams> = {
  PERFORMANCE: { particleCount: 450, bloom: false, bloomStrength: 0, pixelRatioCap: 1, connectionAnimation: false, lighting: "basic" },
  BALANCED: { particleCount: 1200, bloom: false, bloomStrength: 0, pixelRatioCap: 1.25, connectionAnimation: true, lighting: "basic" },
  HIGH: { particleCount: 2400, bloom: true, bloomStrength: 0.18, pixelRatioCap: 1.75, connectionAnimation: true, lighting: "standard" },
  ULTRA: { particleCount: 3800, bloom: true, bloomStrength: 0.28, pixelRatioCap: 2, connectionAnimation: true, lighting: "advanced" },
};

export type FlagKey =
  | "ENABLE_3D_PARTICLES"
  | "ENABLE_DYNAMIC_ORBITS"
  | "ENABLE_ADVANCED_LIGHTING"
  | "ENABLE_ADAPTIVE_RENDERING";

export type ModuleKey =
  | "orbitalLayers"
  | "particleFields"
  | "dataStreams"
  | "holographicRings"
  | "energyPulses"
  | "backgroundGrid";

export type VisualConfig = {
  version: string;
  qualityTier: QualityTier | "AUTO";
  flags: Record<FlagKey, boolean>;
  modules: Record<ModuleKey, boolean>;
};

export const VISUAL_CONFIG_V1: VisualConfig = {
  version: "VISUAL_CONFIG_V1",
  qualityTier: "AUTO",
  flags: {
    ENABLE_3D_PARTICLES: true,
    ENABLE_DYNAMIC_ORBITS: true,
    ENABLE_ADVANCED_LIGHTING: true,
    ENABLE_ADAPTIVE_RENDERING: true,
  },
  modules: {
    orbitalLayers: true,
    particleFields: true,
    dataStreams: true,
    holographicRings: true,
    energyPulses: true,
    backgroundGrid: true,
  },
};

/* A named, serializable successor so the versioning path is exercised
   without changing any default visual. */
export const VISUAL_CONFIG_V1_1: VisualConfig = {
  ...VISUAL_CONFIG_V1,
  version: "VISUAL_CONFIG_V1.1",
};

const LS_CURRENT = "mc-visual-config-current";
const LS_STABLE = "mc-visual-config-stable";

function isTier(v: unknown): v is QualityTier | "AUTO" {
  return v === "AUTO" || v === "PERFORMANCE" || v === "BALANCED" || v === "HIGH" || v === "ULTRA";
}
function sanitizeConfig(raw: unknown): VisualConfig | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.version !== "string" || !r.version.startsWith("VISUAL_CONFIG_")) return null;
  const flagsRaw = (typeof r.flags === "object" && r.flags !== null ? r.flags : {}) as Record<string, unknown>;
  const modsRaw = (typeof r.modules === "object" && r.modules !== null ? r.modules : {}) as Record<string, unknown>;
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  return {
    version: r.version,
    qualityTier: isTier(r.qualityTier) ? r.qualityTier : "AUTO",
    flags: {
      ENABLE_3D_PARTICLES: bool(flagsRaw.ENABLE_3D_PARTICLES, true),
      ENABLE_DYNAMIC_ORBITS: bool(flagsRaw.ENABLE_DYNAMIC_ORBITS, true),
      ENABLE_ADVANCED_LIGHTING: bool(flagsRaw.ENABLE_ADVANCED_LIGHTING, true),
      ENABLE_ADAPTIVE_RENDERING: bool(flagsRaw.ENABLE_ADAPTIVE_RENDERING, true),
    },
    modules: {
      orbitalLayers: bool(modsRaw.orbitalLayers, true),
      particleFields: bool(modsRaw.particleFields, true),
      dataStreams: bool(modsRaw.dataStreams, true),
      holographicRings: bool(modsRaw.holographicRings, true),
      energyPulses: bool(modsRaw.energyPulses, true),
      backgroundGrid: bool(modsRaw.backgroundGrid, true),
    },
  };
}
function loadLS(key: string): VisualConfig | null {
  try {
    const s = window.localStorage.getItem(key);
    return s ? sanitizeConfig(JSON.parse(s) as unknown) : null;
  } catch { return null; }
}
function saveLS(key: string, cfg: VisualConfig) {
  try { window.localStorage.setItem(key, JSON.stringify(cfg)); } catch { /* private mode */ }
}

export type DeviceInfo = {
  tier: QualityTier;
  cores: number | null;
  memoryGb: number | null;
  coarsePointer: boolean;
  smallScreen: boolean;
  mobileHeuristic: boolean;
};

export function detectDevice(): DeviceInfo {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  const cores = typeof nav?.hardwareConcurrency === "number" ? nav.hardwareConcurrency : null;
  const memRaw = nav ? (nav as unknown as { deviceMemory?: number }).deviceMemory : undefined;
  const memoryGb = typeof memRaw === "number" ? memRaw : null;
  const coarsePointer = typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(pointer: coarse)").matches : false;
  const smallScreen = typeof window !== "undefined" ? Math.min(window.innerWidth, window.innerHeight) < 560 : false;
  const mobileHeuristic = coarsePointer || smallScreen;
  let score = 2; // start at HIGH-ish, step down on constraints
  if (mobileHeuristic) score -= 1;
  if (cores !== null && cores <= 2) score -= 1;
  else if (cores !== null && cores <= 4) score -= 0; // neutral
  if (memoryGb !== null && memoryGb <= 2) score -= 1;
  else if (memoryGb !== null && memoryGb <= 4 && mobileHeuristic) score -= 1;
  if (cores !== null && cores >= 8 && memoryGb !== null && memoryGb >= 8 && !mobileHeuristic) score += 1;
  const idx = Math.max(0, Math.min(3, score));
  return { tier: TIER_ORDER[idx] ?? "BALANCED", cores, memoryGb, coarsePointer, smallScreen, mobileHeuristic };
}

/* ---------------- performance monitor (near-zero overhead) ----------------
   - One rAF loop counting frames; publishes FPS once per second into a
     60-entry ring. No allocation in the hot loop beyond that.
   - Scene FPS is reported by the 3D stage at most every 2s.
   - Long-task / error observers are installed once and only count.
   - Render frequency is recorded ONLY when verbose mode is on
     (localStorage mc-diagnostics-verbose=1) — never in hot paths. */

export type ActionStat = { count: number; failures: number; avgMs: number; lastMs: number };
export type PerfSnapshot = {
  loadMs: number | null;
  domContentLoadedMs: number | null;
  fps: number | null;
  sceneFps: number | null;
  fpsSamples: number[];
  sceneFpsSamples: number[];
  memoryMb: number | null;
  memoryLimitMb: number | null;
  longTasks: number;
  jsErrors: string[];
  failedRequests: number;
  actions: Record<string, ActionStat>;
  renders: Record<string, number>;
  verbose: boolean;
};

class PerfMonitor {
  private fpsFrames = 0;
  private fpsLast = 0;
  private started = false;
  private fpsRing: number[] = [];
  private sceneRing: number[] = [];
  currentFps: number | null = null;
  sceneFps: number | null = null;
  private longTaskCount = 0;
  private errors: string[] = [];
  private failed = 0;
  private actionMap = new Map<string, { count: number; failures: number; total: number; last: number }>();
  private renderMap = new Map<string, number>();

  get verbose(): boolean {
    try { return window.localStorage.getItem("mc-diagnostics-verbose") === "1"; } catch { return false; }
  }
  start() {
    if (this.started || typeof window === "undefined") return;
    this.started = true;
    this.fpsLast = performance.now();
    const loop = () => {
      requestAnimationFrame(loop);
      this.fpsFrames++;
      const now = performance.now();
      if (now - this.fpsLast >= 1000) {
        this.currentFps = Math.round((this.fpsFrames * 1000) / (now - this.fpsLast));
        this.fpsRing.push(this.currentFps);
        if (this.fpsRing.length > 60) this.fpsRing.shift();
        this.fpsFrames = 0;
        this.fpsLast = now;
      }
    };
    requestAnimationFrame(loop);
    window.addEventListener("error", this.onError);
    window.addEventListener("unhandledrejection", this.onRejection);
    try {
      const PO = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
      if (PO) {
        const obs = new PO((list) => {
          for (const e of list.getEntries()) if (e.duration > 50) this.longTaskCount++;
        });
        obs.observe({ entryTypes: ["longtask"] });
      }
    } catch { /* unsupported — counter stays 0, shown as n/a by absence */ }
  }
  private onError = (e: ErrorEvent) => {
    this.errors = [...this.errors.slice(-9), e.message || "unknown error"];
  };
  private onRejection = (e: PromiseRejectionEvent) => {
    this.errors = [...this.errors.slice(-9), String(e.reason ?? "unhandled rejection")];
  };
  recordSceneFps(fps: number) {
    this.sceneFps = Math.round(fps);
    this.sceneRing.push(this.sceneFps);
    if (this.sceneRing.length > 60) this.sceneRing.shift();
  }
  recordAction(name: string, ms: number, ok: boolean) {
    if (!ok) this.failed++;
    const cur = this.actionMap.get(name) ?? { count: 0, failures: 0, total: 0, last: 0 };
    cur.count++; if (!ok) cur.failures++;
    cur.total += ms; cur.last = ms;
    this.actionMap.set(name, cur);
  }
  recordRender(name: string) {
    if (!this.verbose) return;
    this.renderMap.set(name, (this.renderMap.get(name) ?? 0) + 1);
  }
  snapshot(): PerfSnapshot {
    let loadMs: number | null = null;
    let dclMs: number | null = null;
    try {
      const navEntries = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
      const n = navEntries[0];
      if (n) { loadMs = Math.round(n.loadEventEnd || n.responseEnd); dclMs = Math.round(n.domContentLoadedEventEnd); }
    } catch { /* no timing */ }
    let memoryMb: number | null = null;
    let memoryLimitMb: number | null = null;
    try {
      const mem = (performance as unknown as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      if (mem) { memoryMb = Math.round(mem.usedJSHeapSize / 1048576); memoryLimitMb = Math.round(mem.jsHeapSizeLimit / 1048576); }
    } catch { /* Chrome-only */ }
    const actions: Record<string, ActionStat> = {};
    for (const [k, v] of this.actionMap) actions[k] = { count: v.count, failures: v.failures, avgMs: Math.round(v.total / Math.max(1, v.count)), lastMs: Math.round(v.last) };
    const renders: Record<string, number> = {};
    if (this.verbose) for (const [k, v] of this.renderMap) renders[k] = v;
    return {
      loadMs, domContentLoadedMs: dclMs,
      fps: this.currentFps, sceneFps: this.sceneFps,
      fpsSamples: [...this.fpsRing], sceneFpsSamples: [...this.sceneRing],
      memoryMb, memoryLimitMb, longTasks: this.longTaskCount,
      jsErrors: [...this.errors], failedRequests: this.failed,
      actions, renders, verbose: this.verbose,
    };
  }
}
export const perfMonitor = new PerfMonitor();

export async function measureAction<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const r = await fn();
    perfMonitor.recordAction(name, performance.now() - t0, true);
    return r;
  } catch (e) {
    perfMonitor.recordAction(name, performance.now() - t0, false);
    throw e;
  }
}

/* ---------------- UX auditor (advisory only) ----------------
   Pure function over already-measured signals. It returns plain-language
   recommendations and changes nothing. */
export function auditRecommendations(s: PerfSnapshot, cfg: VisualConfig, effectiveTier: QualityTier, device: DeviceInfo): string[] {
  const out: string[] = [];
  const fps = s.sceneFps ?? s.fps;
  if (fps !== null && fps < 30 && cfg.modules.particleFields && cfg.flags.ENABLE_3D_PARTICLES) {
    out.push(`3D particle density may be affecting FPS (measured ${fps} FPS). Consider switching the quality tier to PERFORMANCE in Diagnostics, or turning off 3D particles. No change was made automatically.`);
  } else if (fps !== null && fps < 45 && (effectiveTier === "HIGH" || effectiveTier === "ULTRA")) {
    out.push(`Rendering is below 45 FPS at the ${effectiveTier} tier (measured ${fps} FPS). A lower tier would trade effects for smoothness. No change was made automatically.`);
  }
  if (fps !== null && fps >= 55 && effectiveTier === "PERFORMANCE" && cfg.qualityTier === "AUTO" && !device.mobileHeuristic) {
    out.push(`Frame rate is healthy (${fps} FPS) on the PERFORMANCE tier. This device may handle BALANCED or HIGH. No change was made automatically.`);
  }
  if (s.longTasks > 5) {
    out.push(`${s.longTasks} long tasks (>50ms) were observed on the main thread. If the wall ever feels unresponsive, this is the first place to look. Advisory only.`);
  }
  if (s.failedRequests > 0) {
    out.push(`${s.failedRequests} action request${s.failedRequests === 1 ? "" : "s"} failed this session. Check the LINK health chip; the wall retries on its own. Advisory only.`);
  }
  if (s.jsErrors.length > 0) {
    out.push(`${s.jsErrors.length} JavaScript error${s.jsErrors.length === 1 ? "" : "s"} captured this session (latest: ${s.jsErrors[s.jsErrors.length - 1]}). Advisory only — nothing was patched automatically.`);
  }
  if (s.memoryMb !== null && s.memoryLimitMb !== null && s.memoryMb / s.memoryLimitMb > 0.75) {
    out.push(`JS heap is at ${s.memoryMb}MB of a ${s.memoryLimitMb}MB limit. A page reload would clear it. Advisory only.`);
  }
  if (!cfg.flags.ENABLE_ADAPTIVE_RENDERING && fps !== null && fps < 45) {
    out.push("Adaptive rendering is off while FPS is low. Turning it on lets the tier step down automatically instead of relying on the 2D fallback. No change was made automatically.");
  }
  if (device.mobileHeuristic && effectiveTier === "ULTRA") {
    out.push("ULTRA tier on a mobile-class device usually costs battery and smoothness. BALANCED is the safer default here. No change was made automatically.");
  }
  const slow = Object.entries(s.actions).find(([, v]) => v.avgMs > 1500);
  if (slow) out.push(`The ${slow[0]} action averages ${slow[1].avgMs}ms. Slow actions make freshness feel stale even when data is fine. Advisory only.`);
  if (out.length === 0) out.push("No issues detected in the measured signals right now. FPS, errors, long tasks, and action latency are all within healthy bounds.");
  return out;
}

/* ---------------- visual-config state hook ---------------- */
export function useVisualConfig() {
  const [config, setConfigState] = useState<VisualConfig>(() => loadLS(LS_CURRENT) ?? VISUAL_CONFIG_V1);
  const [stable, setStable] = useState<VisualConfig>(() => loadLS(LS_STABLE) ?? VISUAL_CONFIG_V1);
  const device = useMemo(() => detectDevice(), []);
  const [adaptiveTier, setAdaptiveTier] = useState<QualityTier>(device.tier);
  const lowWindows = useRef(0);
  const highWindows = useRef(0);

  useEffect(() => { perfMonitor.start(); }, []);

  /* Adaptive tier: observed FPS steps the AUTO tier down/up with
     hysteresis. The 3D scene's own sustained-low-FPS → 2D fallback
     remains the final safety net underneath this. */
  useEffect(() => {
    if (!config.flags.ENABLE_ADAPTIVE_RENDERING || config.qualityTier !== "AUTO") return;
    const t = window.setInterval(() => {
      const fps = perfMonitor.sceneFps ?? perfMonitor.currentFps;
      if (fps === null) return;
      setAdaptiveTier((cur) => {
        const idx = TIER_ORDER.indexOf(cur);
        if (fps < 45) { lowWindows.current++; highWindows.current = 0; }
        else if (fps > 57) { highWindows.current++; lowWindows.current = 0; }
        else { lowWindows.current = 0; highWindows.current = 0; }
        if (lowWindows.current >= 2 && idx > 0) { lowWindows.current = 0; return TIER_ORDER[idx - 1] ?? cur; }
        if (highWindows.current >= 3 && idx < TIER_ORDER.indexOf(device.tier)) { highWindows.current = 0; return TIER_ORDER[idx + 1] ?? cur; }
        return cur;
      });
    }, 4000);
    return () => window.clearInterval(t);
  }, [config.flags.ENABLE_ADAPTIVE_RENDERING, config.qualityTier, device.tier]);

  useEffect(() => { if (config.qualityTier === "AUTO") setAdaptiveTier((c) => c); }, [config.qualityTier]);

  const effectiveTier: QualityTier = config.qualityTier === "AUTO" ? adaptiveTier : config.qualityTier;

  /* Applying a new config preserves the previous one as the stable
     rollback target first — the stable config is never overwritten
     without keeping the path back. */
  const applyConfig = useCallback((next: VisualConfig) => {
    setConfigState((prev) => {
      saveLS(LS_STABLE, prev);
      setStable(prev);
      saveLS(LS_CURRENT, next);
      return next;
    });
  }, []);

  const rollback = useCallback(() => {
    setConfigState((prev) => {
      saveLS(LS_CURRENT, stable);
      saveLS(LS_STABLE, prev);
      setStable(prev);
      return stable;
    });
  }, [stable]);

  return { config, stable, applyConfig, rollback, effectiveTier, device };
}

/* ---------------- diagnostics panel ---------------- */
const FLAG_LABELS: Array<{ key: FlagKey; label: string }> = [
  { key: "ENABLE_3D_PARTICLES", label: "3D particles" },
  { key: "ENABLE_DYNAMIC_ORBITS", label: "Dynamic orbits" },
  { key: "ENABLE_ADVANCED_LIGHTING", label: "Advanced lighting (bloom)" },
  { key: "ENABLE_ADAPTIVE_RENDERING", label: "Adaptive rendering" },
];
const MODULE_LABELS: Array<{ key: ModuleKey; label: string }> = [
  { key: "orbitalLayers", label: "Orbital layers" },
  { key: "particleFields", label: "Particle fields" },
  { key: "dataStreams", label: "Data streams / beams" },
  { key: "holographicRings", label: "Holographic rings" },
  { key: "energyPulses", label: "Energy pulses" },
  { key: "backgroundGrid", label: "Background grid" },
];

export function DiagnosticsPanel({
  open, onClose, config, stable, onApply, onRollback, effectiveTier, device,
}: {
  open: boolean;
  onClose: () => void;
  config: VisualConfig;
  stable: VisualConfig;
  onApply: (c: VisualConfig) => void;
  onRollback: () => void;
  effectiveTier: QualityTier;
  device: DeviceInfo;
}) {
  const [snap, setSnap] = useState<PerfSnapshot | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!open) return;
    setSnap(perfMonitor.snapshot());
    const t = window.setInterval(() => setSnap(perfMonitor.snapshot()), 1000);
    closeRef.current?.focus();
    return () => window.clearInterval(t);
  }, [open ]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const recommendations = useMemo(
    () => (snap ? auditRecommendations(snap, config, effectiveTier, device) : []),
    [snap, config, effectiveTier, device],
  );
  if (!open) return null;
  const row = (k: string, v: string) => (
    <div key={k} className="flex items-baseline justify-between gap-3 py-1">
      <dt className="font-mono text-[10px] tracking-widest text-[#7d8fa3]">{k}</dt>
      <dd className="tabular-nums text-right font-mono text-[11px] text-[#e8eef5]">{v}</dd>
    </div>
  );
  const toggleBtn = (label: string, on: boolean, onClick: () => void) => (
    <button key={label} type="button" aria-label={`${label}: ${on ? "on" : "off"}. Toggle`} aria-pressed={on} onClick={onClick}
      className={`mc-touch flex w-full items-center justify-between rounded border px-3 py-2 text-left font-mono text-[10px] tracking-widest ${on ? "border-[#5cc6da]/50 bg-[#5cc6da]/10 text-[#5cc6da]" : "border-white/10 bg-white/[0.03] text-[#8a9bb0]"}`}>
      <span>{label}</span><span>{on ? "ON" : "OFF"}</span>
    </button>
  );
  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label="System diagnostics">
      <button type="button" aria-label="Close diagnostics" className="absolute inset-0 bg-black/70" onClick={onClose} />
      <div className="relative max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-t-xl border border-[#5cc6da]/25 bg-[#071018] p-5 sm:rounded-xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm tracking-[0.22em]" style={{ fontFamily: "var(--font-display)", fontWeight: 600 }}>DIAGNOSTICS</h2>
            <p className="mt-1 font-mono text-[10px] leading-relaxed text-[#7d8fa3]">Measured on this device only. Nothing here changes the dashboard by itself.</p>
          </div>
          <button ref={closeRef} type="button" aria-label="Close diagnostics" onClick={onClose} className="mc-touch flex items-center justify-center rounded border border-white/15 bg-white/5 px-3 font-mono text-xs">✕</button>
        </div>

        <h3 className="mc-hud-label mt-5">Performance (live)</h3>
        <dl className="mt-1 divide-y divide-white/5">
          {row("PAGE LOAD", snap?.loadMs != null ? `${snap.loadMs}ms` : "measuring…")}
          {row("DOM READY", snap?.domContentLoadedMs != null ? `${snap.domContentLoadedMs}ms` : "—")}
          {row("FRAME RATE", snap?.fps != null ? `${snap.fps} FPS` : "measuring…")}
          {row("3D SCENE FPS", snap?.sceneFps != null ? `${snap.sceneFps} FPS` : "awaiting samples — reports while 3D animates")}
          {row("JS HEAP", snap?.memoryMb != null ? `${snap.memoryMb}MB${snap.memoryLimitMb ? ` / ${snap.memoryLimitMb}MB` : ""}` : "not exposed by this browser")}
          {row("LONG TASKS >50MS", String(snap?.longTasks ?? 0))}
          {row("FAILED REQUESTS", String(snap?.failedRequests ?? 0))}
          {row("JS ERRORS", String(snap?.jsErrors.length ?? 0))}
          {row("QUALITY TIER (EFFECTIVE)", `${effectiveTier}${config.qualityTier === "AUTO" ? " · AUTO" : " · MANUAL"}`)}
          {row("DEVICE", `${device.cores ?? "?"} cores · ${device.memoryGb != null ? `${device.memoryGb}GB` : "memory n/a"} · ${device.mobileHeuristic ? "mobile-class" : "desktop-class"} → suggests ${device.tier}`)}
          {row("VISUAL CONFIG", config.version)}
          {row("ROLLBACK TARGET", stable.version)}
        </dl>
        {snap && Object.keys(snap.actions).length > 0 ? (
          <>
            <h3 className="mc-hud-label mt-4">Action latency</h3>
            <dl className="mt-1 divide-y divide-white/5">
              {Object.entries(snap.actions).map(([k, v]) => row(k, `avg ${v.avgMs}ms · last ${v.lastMs}ms · ×${v.count}${v.failures ? ` · ${v.failures} failed` : ""}`))}
            </dl>
          </>
        ) : null}
        {snap?.verbose && Object.keys(snap.renders).length > 0 ? (
          <>
            <h3 className="mc-hud-label mt-4">Render frequency (verbose)</h3>
            <dl className="mt-1 divide-y divide-white/5">{Object.entries(snap.renders).map(([k, v]) => row(k, String(v)))}</dl>
          </>
        ) : null}
        {snap && snap.jsErrors.length > 0 ? <p className="mt-2 break-words font-mono text-[10px] text-[#ff8fab]">Latest error: {snap.jsErrors[snap.jsErrors.length - 1]}</p> : null}

        <h3 className="mc-hud-label mt-5">Quality tier (manual override, saved on this device)</h3>
        <div className="mt-2 grid grid-cols-2 gap-1.5" role="group" aria-label="Quality tier override">
          {(["AUTO", ...TIER_ORDER] as const).map((t) => {
            const on = config.qualityTier === t;
            return (
              <button key={t} type="button" aria-label={`Set quality tier to ${t}`} aria-pressed={on}
                onClick={() => onApply({ ...config, qualityTier: t })}
                className={`mc-touch rounded border px-3 py-2 font-mono text-[10px] tracking-widest ${on ? "border-[#5cc6da]/60 bg-[#5cc6da]/15 text-[#5cc6da]" : "border-white/10 bg-white/[0.03] text-[#8a9bb0]"}`}>{t}</button>
            );
          })}
        </div>
        <p className="mt-1.5 font-mono text-[10px] text-[#7d8fa3]">Effective now: {effectiveTier} — particles {TIER_PARAMS[effectiveTier].particleCount}, bloom {TIER_PARAMS[effectiveTier].bloom ? "on" : "off"}, pixel-ratio cap {TIER_PARAMS[effectiveTier].pixelRatioCap}.</p>

        <h3 className="mc-hud-label mt-5">Feature flags</h3>
        <div className="mt-2 space-y-1.5">
          {FLAG_LABELS.map(({ key, label }) => toggleBtn(label, config.flags[key], () => onApply({ ...config, flags: { ...config.flags, [key]: !config.flags[key] } })))}
        </div>
        <h3 className="mc-hud-label mt-5">3D modules (independent)</h3>
        <div className="mt-2 space-y-1.5">
          {MODULE_LABELS.map(({ key, label }) => toggleBtn(label, config.modules[key], () => onApply({ ...config, modules: { ...config.modules, [key]: !config.modules[key] } })))}
        </div>

        <h3 className="mc-hud-label mt-5">Visual config & rollback</h3>
        <p className="mt-1 font-mono text-[10px] leading-relaxed text-[#7d8fa3]">Current {config.version} · rollback target {stable.version}. Applying a change first preserves the current config as the rollback target.</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button type="button" aria-label={`Upgrade visual config to ${VISUAL_CONFIG_V1_1.version}`} onClick={() => onApply({ ...VISUAL_CONFIG_V1_1, qualityTier: config.qualityTier, flags: config.flags, modules: config.modules })} className="mc-touch rounded border border-white/15 bg-white/[0.03] px-3 py-2 font-mono text-[10px] tracking-widest text-[#c7d6ea]">APPLY {VISUAL_CONFIG_V1_1.version}</button>
          <button type="button" aria-label={`Roll back visual config to ${stable.version}`} onClick={onRollback} className="mc-touch rounded border border-[#e8a84d]/50 bg-[#e8a84d]/10 px-3 py-2 font-mono text-[10px] tracking-widest text-[#e8a84d]">ROLL BACK TO {stable.version}</button>
        </div>

        <h3 className="mc-hud-label mt-5">UX auditor — suggestions only</h3>
        <p className="mt-1 font-mono text-[10px] leading-relaxed text-[#7d8fa3]">Machine-generated from the measured signals above. Awaiting human approval — the auditor never changes code, config, or architecture on its own.</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 font-mono text-[11px] leading-relaxed text-[#c7d6ea]">
          {recommendations.map((r, i) => <li key={i}>{r}</li>)}
        </ul>
      </div>
    </div>
  );
}
