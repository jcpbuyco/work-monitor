// Known statuses get a colour; anything else renders grey rather than being
// rejected. Claude Code's vocabulary has already grown once ("failed"), so this
// map is a display hint, never a validator.
const WF_STATUS_CLASS: Record<string, string> = {
  completed: "text-working",
  running: "text-working",
  failed: "text-attention",
  killed: "text-attention",
  orphaned: "text-muted-foreground",
  settled: "text-muted-foreground",
};

export function statusKnown(label: string): boolean {
  return Object.prototype.hasOwnProperty.call(WF_STATUS_CLASS, label);
}

export function statusClass(label: string): string {
  return WF_STATUS_CLASS[label] ?? "text-muted-foreground/70";
}
