export default {
  darkMode: "class",
  content: ["./src/web/**/*.{ts,tsx,html}"],
  theme: {
    extend: {
      colors: {
        background: "hsl(var(--background) / <alpha-value>)",
        foreground: "hsl(var(--foreground) / <alpha-value>)",
        border: "hsl(var(--border) / <alpha-value>)",
        chip: "hsl(var(--chip) / <alpha-value>)",
        primary: "hsl(var(--primary) / <alpha-value>)",
        working: "hsl(var(--working) / <alpha-value>)",
        attention: "hsl(var(--attention) / <alpha-value>)",
        done: "hsl(var(--done) / <alpha-value>)",
        idle: "hsl(var(--idle) / <alpha-value>)",
        card: {
          DEFAULT: "hsl(var(--card) / <alpha-value>)",
          hover: "hsl(var(--card-hover) / <alpha-value>)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted) / <alpha-value>)",
          foreground: "hsl(var(--muted-foreground) / <alpha-value>)",
        },
      },
      fontSize: {
        "2xs": "0.6875rem",
      },
      boxShadow: {
        card: "0 1px 2px hsl(var(--shadow) / var(--shadow-a))",
        "card-hover": "0 4px 14px hsl(var(--shadow) / var(--shadow-a))",
      },
    },
  },
  plugins: [],
};
