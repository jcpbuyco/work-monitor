import type { HTMLAttributes, ReactNode } from "react";

/** React's HTMLAttributes has no index signature, and the JSX checker only
 *  special-cases data-* on intrinsic elements - so a component that forwards
 *  them has to declare them. */
type DataAttrs = { [k: `data-${string}`]: string | undefined };

/** THE rail. Every list row's leading mark sits in this fixed-width slot, so
 *  line-1 text starts at exactly --rail no matter how wide the mark is (14px
 *  glyph, 16px checkbox, 6px dot). Rows put NO gap at this level and nest their
 *  content in a gapped flex - see the row components. */
export function Rail({ children }: { children?: ReactNode }) {
  return <span className="flex w-rail shrink-0 items-center justify-center">{children}</span>;
}

/** Shared row chrome. Carries NO background: `ROW_TONE` supplies exactly one,
 *  because two same-specificity `hover:bg-*` classes in one className are
 *  resolved by stylesheet emission order, not by string order. */
export const ROW_BASE = "-mx-1.5 rounded-md px-1.5 transition-colors duration-quick ease-quad";

export type RowTone = "default" | "attention";

/** `attention` REPLACES the default hover, never appends to it. */
export const ROW_TONE: Record<RowTone, string> = {
  default: "hover:bg-surface-2",
  attention: "bg-attention/[0.05] hover:bg-attention/[0.08]",
};

export function ListRow({
  tone = "default",
  className = "",
  ...rest
}: HTMLAttributes<HTMLDivElement> & DataAttrs & { tone?: RowTone }) {
  return <div className={`${ROW_BASE} ${ROW_TONE[tone]} ${className}`} {...rest} />;
}

const DOWN_CARET_PATH = "M2.5 4.5 6 8l3.5-3.5";

/** The decorative caret on a plain `<select>` styled with `appearance-none`
 *  (ActivityFeed's session/limit selects; the Workflows/Cost pages' project
 *  and harness filters). One shared shape so a native select's affordance
 *  looks identical everywhere it's re-skinned. */
export function DownCaret() {
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className="pointer-events-none absolute right-2 h-2.5 w-2.5 text-ink-4">
      <path d={DOWN_CARET_PATH} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** 10px disclosure caret. aria-hidden, so it never enters an accessible name -
 *  which is why `"▸ ★ Todos (5)"` can become `"★ Todos (5)"` with every role
 *  query in the suite still matching. */
export function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 12 12"
      width="10"
      height="10"
      className={`h-2.5 w-2.5 shrink-0 text-ink-4 transition-transform duration-base ease-quad ${open ? "rotate-90" : ""}`}
    >
      <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The uppercase micro-label idiom, which occurred 12 times across 9 files.
 *  `label` is ONE string in ONE element - including its parenthesised count -
 *  because accessible-name computation concatenates element text with
 *  unpredictable spacing and three of these names are regex-pinned by tests. */
export function SectionHeader({
  label,
  leading,
  right,
  onToggle,
  collapsed = false,
}: {
  label: string;
  leading?: ReactNode;
  right?: ReactNode;
  onToggle?: () => void;
  collapsed?: boolean;
}) {
  const labelEl = <span className="whitespace-nowrap text-2xs font-semibold uppercase tracking-caps text-ink-3">{label}</span>;
  return (
    // §5.2 finding fix: `flex-wrap` + `shrink-0` on the label cluster below -
    // a fixed 20rem sidebar (ActivityFeed's two selects included in `right`)
    // used to leave the label less room than its own content needed, and a
    // flex item's automatic minimum size for TEXT is its longest WORD, not
    // its full string - so the container shrank the label cluster down far
    // enough that "Live activity" line-wrapped into "Live" / "activity" as
    // two lines, clipped by the row's fixed height. `flex-wrap` here lets
    // `right` drop to its own line instead when the two don't fit side by
    // side; `shrink-0` (plus `labelEl`'s own `whitespace-nowrap`) means the
    // label itself is never what gives.
    <div className="mb-2 flex flex-wrap items-center gap-2">
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="inline-flex shrink-0 items-center gap-2 transition-colors duration-quick ease-quad hover:text-ink"
        >
          <Chevron open={!collapsed} />
          {leading}
          {labelEl}
        </button>
      ) : (
        <span className="inline-flex shrink-0 items-center gap-2">
          {leading}
          {labelEl}
        </span>
      )}
      {right && <div className="ml-auto flex items-center gap-3">{right}</div>}
    </div>
  );
}

const CHIP_TONE = {
  neutral: "bg-surface-3 text-ink-3",
  working: "bg-working/[0.12] text-working",
} as const;

/** A LOOKUP, never `text-${size}`: Tailwind's content scanner is a regex over
 *  source text and cannot see an interpolated class name. Written this way both
 *  classes are literal in this file, so they are guaranteed emitted from Task 2
 *  onward - no safelist, and no window (Tasks 5/8, before the §4.12 group labels
 *  land) where `text-3xs` exists nowhere in the source and chips render at the
 *  inherited size. */
const CHIP_SIZE = { "3xs": "text-3xs", "2xs": "text-2xs" } as const;

/** Micro chip. `size` is a prop rather than an override because two font-size
 *  classes on one element are another emission-order coin flip. `title` and
 *  data-* passthrough are load-bearing: `title="owns a live workflow run"` is
 *  pinned by three tests and `data-testid="wf-badge"` by Task 0. */
export function Chip({
  tone = "neutral",
  round = false,
  size = "3xs",
  className = "",
  title,
  children,
  ...rest
}: {
  tone?: keyof typeof CHIP_TONE;
  round?: boolean;
  size?: keyof typeof CHIP_SIZE;
  className?: string;
  title?: string;
  children: ReactNode;
} & DataAttrs) {
  const shape = round ? "rounded-full px-1.5" : "rounded-sm px-1";
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center font-mono ${CHIP_SIZE[size]} ${shape} ${CHIP_TONE[tone]} ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}

/** The unified sidebar row: one grid for ToolStats and CostBreakdown, which is
 *  what makes the two panels read as one system. The bar is neutral (`bg-bar`),
 *  not accent - the sidebar must stop competing with the board for colour.
 *
 *  The bar lives INSIDE the label cell, not the row (§5.2, P2-4): a full-width
 *  bar drawn under the whole `<li>` bled under the numeric columns and visibly
 *  cut through them at 100% (`$2982.41` sliced by the bar edge). Scoping
 *  `relative isolate` to the label `<span>` instead means the bar's percentage
 *  is relative to THAT cell only, so it always ends before the numbers start. */
export function MeterRow({
  frac,
  leading,
  label,
  a,
  b,
}: {
  frac: number;
  leading?: ReactNode;
  label: string;
  a: ReactNode;
  b: ReactNode;
}) {
  return (
    <li className={`flex h-6 items-center font-mono text-2xs ${ROW_BASE}`}>
      <Rail>{leading}</Rail>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <span className="relative isolate min-w-0 flex-1 truncate font-medium text-ink-2" title={label}>
          <span
            aria-hidden="true"
            data-meter-bar="true"
            className="absolute inset-y-[0.125rem] left-0 -z-10 rounded bg-bar"
            style={{ width: `${Math.max(6, Math.round(frac * 100))}%` }}
          />
          {label}
        </span>
        <span className="w-14 shrink-0 whitespace-nowrap text-right tabular-nums text-ink-3">{a}</span>
        <span className="w-16 shrink-0 whitespace-nowrap text-right tabular-nums text-ink-4">{b}</span>
      </div>
    </li>
  );
}

/** A pulsing placeholder bar - the board's pre-`ready` skeleton (§5.2). One
 *  primitive so every skeleton row in the app pulses in lockstep and the
 *  Motion toggle governs it for free (`am-pulse` is already gated on
 *  `html.am-anim`). `w` is a Tailwind width class, e.g. `"w-24"`. */
export function Skeleton({ w, className = "" }: { w: string; className?: string }) {
  return <span aria-hidden="true" className={`am-pulse inline-block h-3 rounded bg-surface-3 ${w} ${className}`} />;
}

/** Joined range control for the two pages. No `data-press`: a 3% scale on a
 *  joined 28px control reads as wobble (R12). */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string; icon?: ReactNode }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex h-7 items-center gap-0.5 rounded-md border-hairline border-border p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          onClick={() => onChange(o.value)}
          className={`flex h-[1.375rem] items-center gap-1.5 rounded px-2.5 text-xs transition-colors duration-quick ease-quad ${
            o.value === value ? "bg-surface-3 text-ink" : "text-ink-3 hover:text-ink"
          }`}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Shared chrome for #/cost and #/workflows. HARD CONSTRAINT: this must
 *  introduce no <button> whose accessible name contains "cost" - two tests do
 *  getByRole("button", { name: /cost/i }) expecting the Cost COLUMN header.
 *  `← Dashboard` is therefore an <a> and the title a <span>. */
export function PageHeader({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <header className="sticky top-0 z-20 -mx-6 flex h-12 items-center gap-3 border-b-hairline border-border-weak bg-surface-0/[0.72] px-6 backdrop-blur-[20px]">
      <a href="#/" className="text-sm text-ink-3 transition-colors duration-quick ease-quad hover:text-ink">
        ← Dashboard
      </a>
      <span aria-hidden="true" className="h-4 w-px bg-border-weak" />
      <span className="text-sm font-semibold text-ink">{title}</span>
      {right && <div className="ml-auto">{right}</div>}
    </header>
  );
}
