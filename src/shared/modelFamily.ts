/** The four buckets the Insights page groups spend into (§6, C3/C5/C8). A
 *  bare family alias (`opus`, `sonnet`, `fable`, `mythos`) classifies the same
 *  as its canonical prefixed id -- this is intentionally NOT `canonicalModel`
 *  (server/pricing.ts): family classification is a simple prefix match that
 *  the web bundle needs too, with no rate table or Cursor effort-suffix
 *  stripping required to get it right (a Cursor-routed Claude id like
 *  `claude-sonnet-5-thinking-high` already starts with `claude-sonnet-`). */
export type Family = "Fable" | "Opus" | "Sonnet" | "Other";

/** Everything not Claude fable/mythos/opus/sonnet -- haiku, gpt, grok,
 *  composer, gemini, and any future model -- folds into "Other" (§5's neutral
 *  `--viz-other`, never a fourth hue). */
export function familyOf(model: string): Family {
  if (model === "fable" || model === "mythos" || /^claude-(fable|mythos)-/.test(model)) return "Fable";
  if (model === "opus" || /^claude-opus-/.test(model)) return "Opus";
  if (model === "sonnet" || /^claude-sonnet-/.test(model)) return "Sonnet";
  return "Other";
}

/** Fixed stacking/legend order for the four families (§6, C3: "stacked in
 *  that fixed order from the baseline"). */
export const FAMILY_ORDER: Family[] = ["Fable", "Opus", "Sonnet", "Other"];
