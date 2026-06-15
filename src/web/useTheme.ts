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
