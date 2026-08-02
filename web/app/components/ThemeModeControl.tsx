"use client";

import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { type ThemeMode, useThemePreference } from "../providers";

function isThemeMode(value: string): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

export function ThemeModeControl() {
  const { mode, setMode } = useThemePreference();

  function changeMode(value: string) {
    if (isThemeMode(value)) {
      setMode(value);
    }
  }

  return (
    <section className="theme-mode-control" aria-label="Appearance">
      <span className="theme-mode-desktop">
        <SegmentedControl
          value={mode}
          onChange={changeMode}
          label="Color theme"
          size="sm"
        >
          <SegmentedControlItem value="system" label="System" />
          <SegmentedControlItem value="light" label="Light" />
          <SegmentedControlItem value="dark" label="Dark" />
        </SegmentedControl>
      </span>
      <label className="theme-mode-mobile">
        <span className="visually-hidden">Color theme</span>
        <select
          aria-label="Color theme"
          value={mode}
          onChange={(event) => changeMode(event.target.value)}
        >
          <option value="system">System</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
    </section>
  );
}
