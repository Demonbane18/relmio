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
    "--color-accent": ["#137c74", "#52c7bb"],
    "--color-background-body": ["#faf9f5", "#101513"],
    "--color-background-surface": ["#f4f1e9", "#171d1b"],
    "--color-background-card": ["#ffffff", "#1d2421"],
    "--color-background-muted": ["#eef7f2", "#202b27"],
    "--color-text-primary": ["#0d1b18", "#edf3f0"],
    "--color-text-secondary": ["#4f635d", "#a9b8b3"],
    "--color-text-accent": ["#0c5f59", "#73d7cd"],
    "--color-icon-accent": ["#137c74", "#52c7bb"],
    "--color-border": ["#dde3df", "#303a36"],
    "--color-border-emphasized": ["#b9c4bf", "#52615b"],
    "--color-shadow": ["rgba(13, 27, 24, 0.16)", "rgba(0, 0, 0, 0.48)"],
  },
});
