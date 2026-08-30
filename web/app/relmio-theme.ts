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
    medium: 360,
    slow: 720,
    ratio: 0.74,
    easing: "cubic-bezier(0.22, 1, 0.36, 1)",
  },
  tokens: {
    "--color-accent": ["#137c74", "#62d2c4"],
    "--color-background-body": ["#f4f2ed", "#0b1211"],
    "--color-background-surface": ["#faf9f5", "#111b19"],
    "--color-background-card": ["#ffffff", "#172320"],
    "--color-background-muted": ["#e7f3f0", "#173d38"],
    "--color-text-primary": ["#12211f", "#f1f5f2"],
    "--color-text-secondary": ["#526661", "#a8bbb5"],
    "--color-text-accent": ["#0c5f59", "#73d7cd"],
    "--color-icon-accent": ["#137c74", "#62d2c4"],
    "--color-border": ["#ccd5d1", "#30423e"],
    "--color-border-emphasized": ["#aebcb7", "#52615b"],
    "--color-shadow": ["rgba(13, 27, 24, 0.16)", "rgba(0, 0, 0, 0.48)"],
  },
});
