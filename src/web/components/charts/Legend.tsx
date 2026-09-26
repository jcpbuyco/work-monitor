export interface LegendEntry {
  id: string;
  label: string;
  color: string;
  /** "line" for a context/reference series (e.g. C8's list-price tick), "rect" (default) for a fill. */
  kind?: "rect" | "line";
}

/** Click (or Enter/Space) isolates one entity: the others dim to 15% opacity,
 *  colors never repaint (§5: "color follows the entity"). A second click, or
 *  Escape from the chart, restores everyone. No legend box for a single series
 *  (the title already names it) -- callers simply don't render this. */
export function Legend({
  entries,
  isolated,
  onToggle,
}: {
  entries: LegendEntry[];
  isolated?: string | null;
  onToggle?: (id: string | null) => void;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      role={onToggle ? "group" : undefined}
      aria-label={onToggle ? "Legend, click to isolate a series" : undefined}
      onKeyDown={(e) => {
        // Escape restores everyone (spec: "Escape or a second click
        // restores"), from anywhere in the legend group, not just the
        // isolated entry's own button.
        if (onToggle && e.key === "Escape" && isolated != null) onToggle(null);
      }}
    >
      {entries.map((e) => {
        const dimmed = isolated != null && isolated !== e.id;
        const swatch =
          e.kind === "line" ? (
            <span aria-hidden="true" className="inline-block h-0 w-2.5 border-t-2" style={{ borderColor: e.color }} />
          ) : (
            <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm" style={{ background: e.color }} />
          );
        const content = (
          <>
            {swatch}
            <span className="whitespace-nowrap text-2xs text-ink-3">{e.label}</span>
          </>
        );
        if (!onToggle) {
          return (
            <span key={e.id} className="inline-flex items-center gap-1.5" style={{ opacity: dimmed ? 0.4 : 1 }}>
              {content}
            </span>
          );
        }
        return (
          <button
            key={e.id}
            type="button"
            aria-pressed={isolated === e.id}
            onClick={() => onToggle(isolated === e.id ? null : e.id)}
            className="inline-flex items-center gap-1.5 rounded transition-opacity duration-quick ease-quad"
            style={{ opacity: dimmed ? 0.4 : 1 }}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
