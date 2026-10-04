import { useMemo, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type ApiResponse } from "./api";
import { useNowMs } from "./useNow";

type Reliability = ApiResponse<typeof api, "getReliability">;
type Improvements = ApiResponse<typeof api, "listImprovements">;
type Improvement = Improvements["items"][number];
type ImpStatus = Improvement["status"];

const IMP_STATUSES: Array<{ key: ImpStatus | "all"; label: string }> = [
  { key: "all", label: "ALL" },
  { key: "proposed", label: "PROPOSED" },
  { key: "testing", label: "TESTING" },
  { key: "verified", label: "VERIFIED" },
  { key: "rejected", label: "REJECTED" },
  { key: "regressed", label: "REGRESSED" },
  { key: "rolled-back", label: "ROLLED-BACK" },
];

const IMP_COLOR: Record<ImpStatus, string> = {
  proposed: "#8a9bb0",
  testing: "#e8a84d",
  verified: "#4ecf8f",
  rejected: "#5b6b80",
  regressed: "#e86a7c",
  "rolled-back": "#ff8fab",
};

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

function rel(iso: string | null | undefined, now: number): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = t - now;
  const abs = Math.abs(diff);
  const sec = Math.round(abs / 1000);
  if (sec < 60) return diff <= 0 ? `${sec}s ago` : `in ${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return diff <= 0 ? `${min}m ago` : `in ${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return diff <= 0 ? `${hr}h ago` : `in ${hr}h`;
  const d = Math.round(hr / 24);
  return diff <= 0 ? `${d}d ago` : `in ${d}d`;
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0m";
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

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

type RelFilter = "all" | "failed" | "overdue" | "recovered";

export function ReliabilityCenter() {
  // Relative-time labels here are minute-granular; tick slowly and
  // locally so the wall never re-renders for this panel's clock.
  const nowMs = useNowMs(5_000);
  const [filter, setFilter] = useState<RelFilter>("all");
  const q = useQuery({
    queryKey: ["reliability"],
    queryFn: () => api.getReliability({}),
    refetchInterval: 30_000,
    retry: 3,
  });
  const data: Reliability | undefined = q.data;
  const showFailed = filter === "all" || filter === "failed";
  const showOverdue = filter === "all" || filter === "overdue";
  const showRecovered = filter === "all" || filter === "recovered";

  const chips: Array<{ key: RelFilter; label: string; count: number }> = [
    {
      key: "all",
      label: "ALL",
      count: (data?.failed.length ?? 0) + (data?.overdue.length ?? 0) + (data?.recovered.length ?? 0),
    },
    { key: "failed", label: "FAILED", count: data?.failed.length ?? 0 },
    { key: "overdue", label: "OVERDUE", count: data?.overdue.length ?? 0 },
    { key: "recovered", label: "RECOVERED", count: data?.recovered.length ?? 0 },
  ];

  return (
    <section aria-label="Reliability Center" className="mc-glass relative mt-5 rounded-xl p-5 sm:p-6">
      <Corners />
      <div className="mc-head flex flex-wrap items-center justify-between gap-2">
        <h2 className="mc-hud-label">Reliability Center</h2>
        <span className="font-mono text-[10px] tracking-widest text-[#5b6b80]">
          {data
            ? `${data.window.snapshotCount} SNAPSHOTS · ${dhakaStamp(data.window.fromTakenAt)} → ${dhakaStamp(data.window.toTakenAt)} DHAKA`
            : "READ MODEL · SNAPSHOT HISTORY"}
        </span>
      </div>
      <p className="mt-2 font-mono text-[11px] leading-relaxed text-[#8a9bb0]">
        Derived from real snapshot history only — failed runs, overdue schedules (last run older
        than 2× their cadence), and failed→completed recoveries. No new data is written here.
      </p>

      <div
        className="mt-3 flex flex-wrap gap-1.5"
        role="group"
        aria-label="Filter reliability by category"
      >
        {chips.map((f) => {
          const isOn = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-label={`Show ${f.label.toLowerCase()} (${f.count})`}
              aria-pressed={isOn}
              onClick={() => setFilter(f.key)}
              className={`mc-touch mc-interactive touch-manipulation rounded-full border px-3 py-2 font-mono text-[9.5px] tracking-widest transition-colors ${
                isOn
                  ? "border-[#5cc6da]/60 bg-[#5cc6da]/15 text-[#5cc6da]"
                  : "border-white/10 bg-white/[0.03] text-[#8a9bb0] hover:bg-white/[0.07]"
              }`}
            >
              {f.label} <span className="opacity-70">{f.count}</span>
            </button>
          );
        })}
      </div>

      {q.isPending ? (
        <div className="mt-4 space-y-2" role="status" aria-label="Loading reliability">
          <div className="mc-skeleton mc-skeleton-line w-1/2" />
          <div className="mc-skeleton mc-skeleton-block" />
          <div className="mc-skeleton mc-skeleton-line w-2/3" />
        </div>
      ) : q.isError ? (
        <div role="alert" className="mt-4 rounded border border-dashed border-[#e86a7c]/60 bg-[#e86a7c]/10 p-3">
          <p className="font-mono text-xs tracking-widest text-[#ff8fab]">RELIABILITY UNAVAILABLE</p>
          <p className="mt-1 font-mono text-[11px] leading-relaxed text-[#c7d6ea]">
            Snapshot history could not be read. The live wall above is unaffected.
          </p>
          <button
            type="button"
            aria-label="Retry loading reliability"
            onClick={() => void q.refetch()}
            className="mc-touch mt-2 rounded border border-[#e86a7c]/50 bg-[#e86a7c]/10 px-3 py-1.5 font-mono text-[10px] tracking-widest text-[#ff8fab]"
          >
            RETRY
          </button>
        </div>
      ) : !data || data.window.snapshotCount === 0 ? (
        <p className="mt-4 font-mono text-xs leading-relaxed text-[#8a9bb0]">
          No snapshot history yet — reliability appears after the worker pushes snapshots.
        </p>
      ) : (
        <div className="mt-4 space-y-5">
          {data.window.snapshotCount < 3 ? (
            <p className="rounded border border-[#e8a84d]/35 bg-[#e8a84d]/[0.06] px-3 py-2 font-mono text-[11px] leading-relaxed text-[#e8a84d]">
              History is thin ({data.window.snapshotCount} snapshot
              {data.window.snapshotCount === 1 ? "" : "s"}): streaks and recoveries need more
              snapshots to mean anything.
            </p>
          ) : null}

          {showFailed ? (
            <div>
              <h3 className="mc-hud-label">Failed runs</h3>
              {data.failed.length === 0 ? (
                <p className="mt-2 font-mono text-xs leading-relaxed text-[#8a9bb0]">
                  No failed runs in the history window — nothing has failed in the last{" "}
                  {data.window.snapshotCount} snapshots.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-white/5">
                  {data.failed.map((f) => (
                    <li key={f.scheduleId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                      <span className="min-w-0 flex-[1_1_12rem] truncate text-sm font-medium">
                        {f.title}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-[#e86a7c]">
                        {f.failureCount}/{f.totalRuns} RUNS FAILED
                      </span>
                      {f.consecutiveStreak >= 2 ? (
                        <span className="rounded border border-[#e86a7c]/45 bg-[#e86a7c]/10 px-1.5 py-0.5 font-mono text-[9px] tracking-widest text-[#e86a7c]">
                          STREAK ×{f.consecutiveStreak}
                        </span>
                      ) : null}
                      <span className="font-mono text-[10px] tabular-nums text-[#5b6b80]">
                        LAST FAILED {dhakaStamp(f.lastFailedRunAt)} DHAKA ({rel(f.lastFailedRunAt, nowMs)})
                        {f.lastFailedSnapshotAt
                          ? ` · SEEN ${dhakaStamp(f.lastFailedSnapshotAt)}`
                          : ""}
                      </span>
                      <span className="font-mono text-[10px] text-[#5b6b80]">
                        {cadencePlain(f.cadence)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {showOverdue ? (
            <div>
              <h3 className="mc-hud-label">Overdue</h3>
              {data.overdue.length === 0 ? (
                <p className="mt-2 font-mono text-xs leading-relaxed text-[#8a9bb0]">
                  Nothing overdue — every schedule with a parseable cadence ran within 2× its
                  expected interval.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-white/5">
                  {data.overdue.map((o) => (
                    <li key={o.scheduleId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5">
                      <span className="min-w-0 flex-[1_1_12rem] truncate text-sm font-medium">
                        {o.title}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-[#e8a84d]">
                        OVERDUE BY {formatMs(o.overdueMs)}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-[#5b6b80]">
                        LAST RUN {dhakaStamp(o.lastRunAt)} DHAKA ({rel(o.lastRunAt, nowMs)}) ·
                        EXPECTED EVERY {formatMs(o.expectedIntervalMs)} ({cadencePlain(o.cadence).toUpperCase()})
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          {showRecovered ? (
            <div>
              <h3 className="mc-hud-label">Recovered</h3>
              {data.recovered.length === 0 ? (
                <p className="mt-2 font-mono text-xs leading-relaxed text-[#8a9bb0]">
                  No failed→completed recovery in this window yet — a recovery appears once a
                  schedule fails and then completes a later run.
                </p>
              ) : (
                <ul className="mt-2 divide-y divide-white/5">
                  {data.recovered.map((r, i) => (
                    <li
                      key={`${r.scheduleId}-${r.recoveredRunAt ?? i}`}
                      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2.5"
                    >
                      <span className="min-w-0 flex-[1_1_12rem] truncate text-sm font-medium">
                        {r.title}
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-[#4ecf8f]">
                        RECOVERED
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-[#5b6b80]">
                        FAILED {dhakaStamp(r.failedRunAt)} → COMPLETED {dhakaStamp(r.recoveredRunAt)} DHAKA
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

export function ImprovementCenter() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<ImpStatus | "all">("all");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [form, setForm] = useState({ title: "", problem: "", discovery: "", solution: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [transStatus, setTransStatus] = useState<ImpStatus>("testing");
  const [transResult, setTransResult] = useState("");
  const [transNotes, setTransNotes] = useState("");
  const [transError, setTransError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["improvements"],
    queryFn: () => api.listImprovements({}),
    refetchInterval: 30_000,
    retry: 3,
  });
  const items = useMemo(() => q.data?.items ?? [], [q.data]);
  const selected = items.find((i) => i.id === selectedId) ?? items[0] ?? null;

  const proposeMut = useMutation({
    mutationFn: (args: { title: string; problem: string; discovery?: string; solution: string }) =>
      api.proposeImprovement(args),
    onSuccess: (res) => {
      if (!res.ok) {
        setFormError(res.error ?? "Could not save the proposal.");
        return;
      }
      setForm({ title: "", problem: "", discovery: "", solution: "" });
      setFormError(null);
      if (res.id != null) setSelectedId(res.id);
      void queryClient.invalidateQueries({ queryKey: ["improvements"] });
    },
    onError: () => setFormError("Could not save the proposal — try again."),
  });

  const statusMut = useMutation({
    mutationFn: (args: {
      id: number;
      status: ImpStatus;
      result?: string;
      verificationNotes?: string;
    }) => api.updateImprovementStatus(args),
    onSuccess: (res) => {
      if (!res.ok) {
        setTransError(res.error ?? "Could not update the status.");
        return;
      }
      setTransError(null);
      setTransResult("");
      setTransNotes("");
      void queryClient.invalidateQueries({ queryKey: ["improvements"] });
    },
    onError: () => setTransError("Could not update the status — try again."),
  });

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.status, (m.get(i.status) ?? 0) + 1);
    return m;
  }, [items]);

  const visible = filter === "all" ? items : items.filter((i) => i.status === filter);

  const onPropose = (e: FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.problem.trim() || !form.solution.trim()) {
      setFormError("Title, problem and solution are required.");
      return;
    }
    setFormError(null);
    proposeMut.mutate({
      title: form.title.trim(),
      problem: form.problem.trim(),
      discovery: form.discovery.trim() === "" ? undefined : form.discovery.trim(),
      solution: form.solution.trim(),
    });
  };

  const needsEvidence = ["verified", "rejected", "regressed", "rolled-back"].includes(transStatus);
  const onTransition = (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    if (needsEvidence && (!transResult.trim() || !transNotes.trim())) {
      setTransError("A result and verification note are required for this status.");
      return;
    }
    setTransError(null);
    statusMut.mutate({
      id: selected.id,
      status: transStatus,
      result: transResult.trim() === "" ? undefined : transResult.trim(),
      verificationNotes: transNotes.trim() === "" ? undefined : transNotes.trim(),
    });
  };

  const inputCls =
    "w-full rounded border border-white/12 bg-white/[0.03] px-3 py-2 font-mono text-sm text-[#e6f1ff] outline-none placeholder:text-[#5b6b80]";
  const labelCls = "mc-hud-label block";

  return (
    <section aria-label="Improvement Center" className="mc-glass relative mt-5 rounded-xl p-5 sm:p-6">
      <Corners />
      <div className="mc-head flex flex-wrap items-center justify-between gap-2">
        <h2 className="mc-hud-label">Improvement Center</h2>
        <span className="font-mono text-[10px] tracking-widest text-[#5b6b80]">
          {items.length} TRACKED · PROPOSED → TESTING → VERIFIED
        </span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter improvements by status">
        {IMP_STATUSES.map((f) => {
          const count = f.key === "all" ? items.length : (counts.get(f.key) ?? 0);
          const isOn = filter === f.key;
          return (
            <button
              key={f.key}
              type="button"
              aria-label={`Show ${f.label.toLowerCase()} improvements (${count})`}
              aria-pressed={isOn}
              onClick={() => setFilter(f.key)}
              className={`mc-touch mc-interactive touch-manipulation rounded-full border px-3 py-2 font-mono text-[9.5px] tracking-widest transition-colors ${
                isOn
                  ? "border-[#5cc6da]/60 bg-[#5cc6da]/15 text-[#5cc6da]"
                  : "border-white/10 bg-white/[0.03] text-[#8a9bb0] hover:bg-white/[0.07]"
              }`}
            >
              {f.label} <span className="opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {q.isPending ? (
        <div className="mt-4 space-y-2" role="status" aria-label="Loading improvements">
          <div className="mc-skeleton mc-skeleton-line w-1/2" />
          <div className="mc-skeleton mc-skeleton-block" />
        </div>
      ) : q.isError ? (
        <div role="alert" className="mt-4 rounded border border-dashed border-[#e86a7c]/60 bg-[#e86a7c]/10 p-3">
          <p className="font-mono text-xs tracking-widest text-[#ff8fab]">IMPROVEMENTS UNAVAILABLE</p>
          <button
            type="button"
            aria-label="Retry loading improvements"
            onClick={() => void q.refetch()}
            className="mc-touch mt-2 rounded border border-[#e86a7c]/50 bg-[#e86a7c]/10 px-3 py-1.5 font-mono text-[10px] tracking-widest text-[#ff8fab]"
          >
            RETRY
          </button>
        </div>
      ) : (
        <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <div>
            {visible.length === 0 ? (
              <p className="font-mono text-xs leading-relaxed text-[#8a9bb0]">
                No improvements with this status yet. Propose one with the form below.
              </p>
            ) : (
              <ul className="divide-y divide-white/5">
                {visible.map((i) => {
                  const isSel = selected?.id === i.id;
                  const color = IMP_COLOR[i.status];
                  return (
                    <li key={i.id}>
                      <button
                        type="button"
                        aria-label={`View improvement ${i.title}, ${i.status}`}
                        aria-pressed={isSel}
                        onClick={() => setSelectedId(i.id)}
                        className={`flex w-full touch-manipulation items-baseline gap-3 rounded-md px-2 py-2.5 text-left ${
                          isSel ? "bg-[#5cc6da]/10" : "hover:bg-white/[0.03]"
                        }`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{i.title}</span>
                          <span className="block truncate font-mono text-[10px] text-[#5b6b80]">
                            {dhakaStamp(i.createdAt)} Dhaka · {i.problem}
                          </span>
                        </span>
                        <span
                          className="shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] tracking-widest"
                          style={{ borderColor: `${color}55`, background: `${color}14`, color }}
                        >
                          {i.status.toUpperCase()}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            <form onSubmit={onPropose} className="mt-5 rounded border border-white/8 bg-white/[0.02] p-3" aria-label="Propose an improvement">
              <h3 className="mc-hud-label">Propose improvement</h3>
              <div className="mt-3 space-y-3">
                <div>
                  <label htmlFor="imp-title" className={labelCls}>Title</label>
                  <input
                    id="imp-title"
                    value={form.title}
                    onChange={(e) => setForm({ ...form, title: e.target.value })}
                    placeholder="Short name for the fix"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label htmlFor="imp-problem" className={labelCls}>Problem</label>
                  <textarea
                    id="imp-problem"
                    value={form.problem}
                    onChange={(e) => setForm({ ...form, problem: e.target.value })}
                    placeholder="What was wrong?"
                    rows={2}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label htmlFor="imp-discovery" className={labelCls}>Discovery (optional)</label>
                  <textarea
                    id="imp-discovery"
                    value={form.discovery}
                    onChange={(e) => setForm({ ...form, discovery: e.target.value })}
                    placeholder="How was it found?"
                    rows={2}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label htmlFor="imp-solution" className={labelCls}>Solution</label>
                  <textarea
                    id="imp-solution"
                    value={form.solution}
                    onChange={(e) => setForm({ ...form, solution: e.target.value })}
                    placeholder="What fixes it?"
                    rows={2}
                    className={inputCls}
                  />
                </div>
              </div>
              {formError ? (
                <p role="alert" className="mt-2 font-mono text-[11px] text-[#ff8fab]">{formError}</p>
              ) : null}
              <button
                type="submit"
                disabled={proposeMut.isPending}
                aria-label="Submit improvement proposal"
                className="mc-touch mt-3 rounded border border-[#5cc6da]/40 bg-[#5cc6da]/10 px-4 py-2 font-mono text-[10px] tracking-widest text-[#5cc6da] disabled:opacity-50"
              >
                {proposeMut.isPending ? "SAVING…" : "PROPOSE"}
              </button>
            </form>
          </div>

          <div>
            {!selected ? (
              <p className="font-mono text-xs leading-relaxed text-[#8a9bb0]">
                Select an improvement to see its full lifecycle.
              </p>
            ) : (
              <div className="rounded border border-white/8 bg-white/[0.02] p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="truncate text-base font-semibold">{selected.title}</h3>
                    <p className="font-mono text-[10px] tabular-nums text-[#5b6b80]">
                      {dhakaStamp(selected.createdAt)} Dhaka · UPDATED {dhakaStamp(selected.updatedAt)}
                    </p>
                  </div>
                  <span
                    className="shrink-0 rounded border px-2 py-1 font-mono text-[9px] tracking-widest"
                    style={{
                      borderColor: `${IMP_COLOR[selected.status]}55`,
                      background: `${IMP_COLOR[selected.status]}14`,
                      color: IMP_COLOR[selected.status],
                    }}
                  >
                    {selected.status.toUpperCase()}
                  </span>
                </div>
                <dl className="mt-4 space-y-3">
                  {(
                    [
                      ["Problem", selected.problem],
                      ["Discovery", selected.discovery],
                      ["Solution", selected.solution],
                      ["Result", selected.result],
                      ["Verification", selected.verificationNotes],
                    ] as Array<[string, string | null]>
                  ).map(([k, v]) => (
                    <div key={k}>
                      <dt className={labelCls}>{k}</dt>
                      <dd className="mt-1 text-sm leading-relaxed text-[#c7d6ea]">{v ?? "—"}</dd>
                    </div>
                  ))}
                </dl>

                <form onSubmit={onTransition} className="mt-5 border-t border-white/8 pt-4" aria-label="Update improvement status">
                  <h4 className="mc-hud-label">Update status</h4>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div>
                      <label htmlFor="imp-status" className={labelCls}>New status</label>
                      <select
                        id="imp-status"
                        value={transStatus}
                        onChange={(e) => setTransStatus(e.target.value as ImpStatus)}
                        className={inputCls}
                      >
                        <option value="proposed">proposed</option>
                        <option value="testing">testing</option>
                        <option value="verified">verified</option>
                        <option value="rejected">rejected</option>
                        <option value="regressed">regressed</option>
                        <option value="rolled-back">rolled-back</option>
                      </select>
                    </div>
                    <div>
                      <label htmlFor="imp-result" className={labelCls}>
                        Result{needsEvidence ? " (required)" : ""}
                      </label>
                      <input
                        id="imp-result"
                        value={transResult}
                        onChange={(e) => setTransResult(e.target.value)}
                        placeholder="Outcome of the change"
                        className={inputCls}
                      />
                    </div>
                  </div>
                  <div className="mt-3">
                    <label htmlFor="imp-notes" className={labelCls}>
                      Verification notes{needsEvidence ? " (required)" : ""}
                    </label>
                    <textarea
                      id="imp-notes"
                      value={transNotes}
                      onChange={(e) => setTransNotes(e.target.value)}
                      placeholder="How was it checked?"
                      rows={2}
                      className={inputCls}
                    />
                  </div>
                  {transError ? (
                    <p role="alert" className="mt-2 font-mono text-[11px] text-[#ff8fab]">{transError}</p>
                  ) : null}
                  <button
                    type="submit"
                    disabled={statusMut.isPending}
                    aria-label="Save status update"
                    className="mc-touch mt-3 rounded border border-[#5cc6da]/40 bg-[#5cc6da]/10 px-4 py-2 font-mono text-[10px] tracking-widest text-[#5cc6da] disabled:opacity-50"
                  >
                    {statusMut.isPending ? "SAVING…" : "UPDATE STATUS"}
                  </button>
                </form>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
