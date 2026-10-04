import { useEffect, useState } from "react";

/**
 * Self-contained wall-clock ticker for the smallest possible scope.
 *
 * The always-on wall used to hold `nowMs` in the App root and tick it
 * every 200ms, which re-rendered the entire tree five times a second.
 * Now only the components that truly need live time (header clock,
 * freshness readouts, per-stage countdowns) call this hook and
 * re-render themselves — the rest of the app renders on data changes.
 */
export function useNowMs(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return now;
}
