export default {
  darkMode: "class",
  content: ["./src/web/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        /* legacy names — unchanged spelling, now backed by the ramp */
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        chip:       "hsl(var(--chip) / <alpha-value>)",
        primary:    "hsl(var(--primary) / <alpha-value>)",
        card: { DEFAULT: "hsl(var(--card) / <alpha-value>)",
                hover:   "hsl(var(--card-hover) / <alpha-value>)" },
        muted:{ DEFAULT: "hsl(var(--muted) / <alpha-value>)",
                foreground: "hsl(var(--muted-foreground) / <alpha-value>)" },
        working:   "hsl(var(--working) / <alpha-value>)",
        attention: "hsl(var(--attention) / <alpha-value>)",
        done:      "hsl(var(--done) / <alpha-value>)",
        idle:      "hsl(var(--idle) / <alpha-value>)",

        /* new */
        danger: "hsl(var(--danger) / <alpha-value>)",
        accent: { DEFAULT: "hsl(var(--accent) / <alpha-value>)",
                  hover:   "hsl(var(--accent-hover) / <alpha-value>)",
                  tint:    "hsl(var(--accent-tint) / <alpha-value>)" },
        surface:{ 0: "hsl(var(--surface-0) / <alpha-value>)",
                  1: "hsl(var(--surface-1) / <alpha-value>)",
                  2: "hsl(var(--surface-2) / <alpha-value>)",
                  3: "hsl(var(--surface-3) / <alpha-value>)" },
        ink:    { DEFAULT: "hsl(var(--text-1) / <alpha-value>)",
                  2: "hsl(var(--text-2) / <alpha-value>)",
                  3: "hsl(var(--text-3) / <alpha-value>)",
                  4: "hsl(var(--text-4) / <alpha-value>)" },
        border: { DEFAULT: "hsl(var(--border-1) / <alpha-value>)",
                  weak:   "hsl(var(--border-weak) / <alpha-value>)",
                  strong: "hsl(var(--border-strong) / <alpha-value>)" },
        bar: "hsl(var(--bar) / <alpha-value>)",
      },
      fontFamily: { sans: ["var(--font-sans)"], mono: ["var(--font-mono)"] },

      /* ALL rem — the [14,16,18,20,22] ladder keeps scaling everything */
      fontSize: {
        "3xs": ["0.625rem",  { lineHeight: "1.40" }],                            /* 10 */
        "2xs": ["0.6875rem", { lineHeight: "1.45" }],                            /* 11 */
        xs:    ["0.75rem",   { lineHeight: "1.50" }],                            /* 12 */
        sm:    ["0.8125rem", { lineHeight: "1.45" }],                            /* 13 ← was 14 */
        base:  ["0.9375rem", { lineHeight: "1.45", letterSpacing: "-0.011em" }], /* 15 ← was 16 */
        lg:    ["1.125rem",  { lineHeight: "1.35", letterSpacing: "-0.016em" }], /* 18 */
        xl:    ["1.3125rem", { lineHeight: "1.30", letterSpacing: "-0.020em" }], /* 21 */
      },
      /* `medium` is deliberately NOT overridden to 510: no Inter is installed,
         the fallback (FreeSans) ships Regular+Bold only, and CSS weight
         matching for >500 searches upward — 510 would render bold. (R13) */
      fontWeight: { semibold: "590", bold: "680" },
      letterSpacing: { caps: "0.055em", tight: "-0.011em", tighter: "-0.018em" },
      borderWidth: { hairline: "var(--hairline)" },
      spacing: { rail: "var(--rail)" },
      maxWidth: { board: "86rem", page: "64rem" },
      boxShadow: {
        pop: "0 8px 32px hsl(var(--shadow) / var(--shadow-a)), 0 1px 2px hsl(var(--shadow) / calc(var(--shadow-a) * .6))",
      },
      transitionTimingFunction: { quad: "var(--ease)", move: "var(--ease-move)" },
      transitionDuration: { quick: "100ms", base: "160ms", pop: "175ms", move: "280ms" },
    },
  },
  plugins: [],
};
