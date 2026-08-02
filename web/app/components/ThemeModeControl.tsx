"use client";

import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { Monitor, Moon, Sun } from "lucide-react";
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
      <SegmentedControlItem
        value="system"
        label="System"
        isLabelHidden
        icon={<Monitor size="1rem" strokeWidth={1.75} aria-hidden="true" />}
      />
      <SegmentedControlItem
        value="light"
        label="Light"
        isLabelHidden
        icon={<Sun size="1rem" strokeWidth={1.75} aria-hidden="true" />}
      />
      <SegmentedControlItem
        value="dark"
        label="Dark"
        isLabelHidden
        icon={<Moon size="1rem" strokeWidth={1.75} aria-hidden="true" />}
      />
    </SegmentedControl>
  );
}
