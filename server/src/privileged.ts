import { definePrivilegedContracts, definePrivilegedHandlers, z } from "@hatch/space-sdk";

// Host-side operation: read the Mission Control journal file that the
// parent automation keeps at ~/workspace/mission-control/attention.json.
// The artifact renders these entries in the Attention / Journal surface
// so the operator can see the durable log alongside live snapshots.

export const privileged = definePrivilegedContracts({
  readJournal: {
    request: z.object({}),
    response: z.object({
      entries: z.array(
        z.object({
          severity: z.enum(["action", "warn", "info"]),
          text: z.string(),
        }),
      ),
      source: z.string(),
    }),
    timeoutMs: 10000,
  },
});

export const privilegedHandlers = definePrivilegedHandlers(privileged, {
  async readJournal() {
    const { readFile } = await import("node:fs/promises");
    const { homedir } = await import("node:os");
    const { join } = await import("node:path");
    const path = join(homedir(), "workspace", "mission-control", "attention.json");
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      // A missing journal file is a legitimately empty journal, not an
      // outage — the worker simply hasn't written one yet.
      if (code === "ENOENT") {
        return { entries: [], source: "workspace/mission-control/attention.json" };
      }
      throw new Error("journal unavailable: cannot read journal file");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("journal unavailable: journal file is not valid JSON");
    }
    if (!Array.isArray(parsed)) {
      throw new Error("journal unavailable: journal file has unexpected shape");
    }
    const entries = parsed
      .filter(
        (e): e is { severity: "action" | "warn" | "info"; text: string } =>
          typeof e === "object" &&
          e !== null &&
          "severity" in e &&
          "text" in e &&
          typeof (e as { text?: unknown }).text === "string" &&
          ["action", "warn", "info"].includes(
            String((e as { severity?: unknown }).severity),
          ),
      )
      .map((e) => ({ severity: e.severity, text: e.text }));
    return { entries, source: "workspace/mission-control/attention.json" };
  },
});
