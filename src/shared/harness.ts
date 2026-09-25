/** The set of coding-agent CLIs agent-monitor ingests (§4.1). Defined once,
 *  shared verbatim by the server (ingestion, storage) and the web dashboard
 *  (rendering) so the two never drift on what a "harness" is. */
export type Harness = "claude" | "codex" | "cursor";

export const HARNESSES: readonly Harness[] = ["claude", "codex", "cursor"];

export function isHarness(v: unknown): v is Harness {
  return v === "claude" || v === "codex" || v === "cursor";
}

/** Display name for a harness mark/label in the UI. */
export function harnessLabel(h: Harness): string {
  switch (h) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "cursor":
      return "Cursor";
  }
}
