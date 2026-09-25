import { useEffect, useState } from "react";

/** Tracks whether `query` currently matches, via the browser's own
 *  `matchMedia` - live, so a resize genuinely flips the result rather than
 *  freezing it at mount. `matchMedia` is not implemented by plain jsdom (same
 *  gotcha `useTheme.ts` already guards): defaulting to `false` there means
 *  every existing test, which never stubs it, renders the DESKTOP branch of
 *  whatever this drives - a test opts into the narrow-viewport branch only by
 *  stubbing `matchMedia` itself (see `useTheme.test.ts` for the pattern).
 *
 *  Chosen over a `hidden md:block` / `md:hidden` CSS pair (two parallel DOM
 *  trees, one hidden by breakpoint) for the Workflows/Cost pages' "table
 *  becomes cards below md": jsdom applies no stylesheet at all, so BOTH trees
 *  would sit "visible" to every text/role query at once, and query-by-text
 *  ambiguity aside, shipping literally double the DOM to every real browser
 *  just to hide half of it is not simplicity. This renders exactly one
 *  layout, in tests and in production alike. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}
