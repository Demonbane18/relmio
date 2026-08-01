import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";

export const relmioTheme = defineTheme({
  name: "relmio",
  extends: neutralTheme,
  color: {
    accent: "#137c74",
    neutralStyle: "warm",
    contrast: "standard",
  },
  typography: {
    scale: { base: 15, ratio: 1.2 },
    body: {
      family: "Geist",
      fallbacks: "Arial, sans-serif",
    },
    heading: {
      family: "Geist",
      fallbacks: "Arial, sans-serif",
      weight: "semibold",
    },
    code: {
      family: "Geist Mono",
      fallbacks: "Consolas, monospace",
    },
  },
  radius: { base: 4, multiplier: 1.5 },
  motion: {
    fast: 150,
    medium: 420,
    slow: 980,
    ratio: 0.74,
    easing: "cubic-bezier(0.24, 1, 0.4, 1)",
  },
  tokens: {
    "--color-accent": ["#137c74", "#62cfc4"],
    "--color-background-body": ["#f4f2ed", "#0d1513"],
    "--color-background-surface": ["#fbfaf6", "#15201d"],
    "--color-background-card": ["#fffdf8", "#192522"],
    "--color-background-muted": ["#e7f3f0", "#1c312d"],
    "--color-text-primary": ["#12211f", "#eff6f2"],
    "--color-text-secondary": ["#51625d", "#a8b7b2"],
    "--color-text-accent": ["#0b675f", "#79ded4"],
    "--color-icon-accent": ["#137c74", "#62cfc4"],
    "--color-border": ["#d4ddd8", "#30413c"],
    "--color-border-emphasized": ["#a8b7b1", "#526a63"],
    "--color-shadow": ["rgba(18, 33, 31, 0.14)", "rgba(0, 0, 0, 0.42)"],
  },
  components: {
    button: {
      base: {
        minHeight: "44px",
        fontWeight: "650",
      },
      "variant:primary": {
        backgroundColor: "var(--color-accent)",
        color: "var(--color-on-dark)",
      },
    },
  },
});
