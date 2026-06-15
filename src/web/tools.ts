/** Helpers for rendering Claude Code tool names in the live activity feed. */

const MCP_RE = /^mcp__.*?__(.+)$/;

/** Shorten a tool name for display — strips the verbose `mcp__<server>__` prefix
 *  so `mcp__plugin_..__navigate_page` shows as `navigate_page`. */
export function prettyTool(name: string): string {
  const m = name.match(MCP_RE);
  return m ? m[1] : name;
}

/** A Tailwind background class for the tool's category dot. */
export function toolDot(name: string): string {
  if (name === "Bash") return "bg-working";
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(name)) return "bg-done";
  if (/^(Task|Agent|Skill|AskUserQuestion)$/.test(name)) return "bg-attention";
  if (name.startsWith("mcp__")) return "bg-primary";
  // Read / Grep / Glob / ToolSearch / WebFetch / WebSearch / everything else
  return "bg-idle";
}
