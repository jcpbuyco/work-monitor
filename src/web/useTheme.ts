import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

function resolveTheme(): Theme {
  try {
    const stored = localStorage.getItem("am-theme");
    if (stored === "light" || stored === "dark") return stored;
  } catch {}
  try {
    if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
      return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
  } catch {}
  return "dark";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(resolveTheme);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("am-theme", next);
      } catch {}
      return next;
    });
  }, []);

  return { theme, toggle };
}

/** Live "is `html.dark` set right now" -- unlike `useTheme()` above, this does
 *  not own or duplicate the theme state; it observes the ACTUAL class on
 *  `<html>` via a `MutationObserver`, so it stays correct regardless of which
 *  component's `useTheme()` instance toggled it. `useTheme()` itself only
 *  syncs from `localStorage`/`matchMedia` once at mount -- a second, separate
 *  `useTheme()` call elsewhere in the tree (e.g. a card computing contrast-
 *  picked ink) never re-renders when AppBar's own instance flips the class,
 *  so its cached `theme` value goes stale the moment the user toggles theme
 *  (reviewer finding: C12's darkest cells kept unreadable light-mode ink
 *  after switching to light). Anything that needs to react to theme changes
 *  made elsewhere should use this instead of its own `useTheme()`. */
export function useIsDarkMode(): boolean {
  const [dark, setDark] = useState<boolean>(() => typeof document !== "undefined" && document.documentElement.classList.contains("dark"));

  useEffect(() => {
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") return;
    const el = document.documentElement;
    const sync = () => setDark(el.classList.contains("dark"));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(el, { attributes: true, attributeFilter: ["class"] });
    return () => mo.disconnect();
  }, []);

  return dark;
}
