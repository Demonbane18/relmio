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
    <SegmentedControl
      className="theme-mode-control"
      value={mode}
      onChange={changeMode}
      label="Color theme"
      size="sm"
      layout="hug"
    >
      <SegmentedControlItem value="system" label="System" />
      <SegmentedControlItem value="light" label="Light" />
      <SegmentedControlItem value="dark" label="Dark" />
    </SegmentedControl>
  );
}
