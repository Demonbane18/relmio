"use client";

import { type ThemeMode, useThemePreference } from "../../providers";
import { Icon, type IconName } from "./Icon";

const modes: ReadonlyArray<{ value: ThemeMode; label: string; icon: IconName }> = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/** The same color-theme radio group the local wizard uses. */
export function ThemeSwitch() {
  const { mode, setMode } = useThemePreference();

  return (
    <fieldset className="rm-segmented">
      <legend className="rm-visually-hidden">Color theme</legend>
      {modes.map((item) => (
        <label key={item.value} className="rm-segmented__item" title={item.label}>
          <input
            className="rm-segmented__input"
            type="radio"
            name="color-theme"
            value={item.value}
            checked={mode === item.value}
            onChange={() => setMode(item.value)}
          />
          <Icon name={item.icon} size="sm" />
          <span className="rm-visually-hidden">{item.label}</span>
        </label>
      ))}
    </fieldset>
  );
}
