import { flushSync } from "react-dom";

type DocWithVT = Document & { startViewTransition?: (cb: () => void) => unknown };

/** View transitions are used only when supported AND motion is enabled (the
 *  `html.am-anim` class set by the Motion toggle, which overrides the OS
 *  prefers-reduced-motion setting for this dashboard). */
export function canViewTransition(): boolean {
  return (
    typeof document !== "undefined" &&
    typeof (document as DocWithVT).startViewTransition === "function" &&
    document.documentElement.classList.contains("am-anim")
  );
}

/** Commit a React state update inside a view transition so layout changes
 *  (cards moving between columns, list items inserting/removing) tween instead
 *  of jumping. `flushSync` forces the DOM to update before the browser snapshots
 *  the "after" state. Falls back to a plain commit when motion is off/unsupported. */
export function runViewTransition(commit: () => void): void {
  if (canViewTransition()) {
    (document as DocWithVT).startViewTransition!(() => flushSync(commit));
  } else {
    commit();
  }
}
