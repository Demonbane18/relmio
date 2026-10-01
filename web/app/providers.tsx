"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemeMode = "system" | "light" | "dark";

type ThemePreference = {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
};

const storageKey = "relmio-color-mode";
const ThemePreferenceContext = createContext<ThemePreference | null>(null);

function isThemeMode(value: string | null): value is ThemeMode {
  return value === "system" || value === "light" || value === "dark";
}

// Same contract as the wizard's theme.js: Light or Dark sets data-theme on
// <html>; System removes it so the kit follows prefers-color-scheme. The root
// layout applies a saved choice before first paint.
function applyMode(mode: ThemeMode) {
  if (mode === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = mode;
  }
}

export function Providers({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("system");

  useEffect(() => {
    let isCurrent = true;

    try {
      const savedMode = window.localStorage.getItem(storageKey);
      if (isThemeMode(savedMode)) {
        queueMicrotask(() => {
          if (isCurrent) setModeState(savedMode);
        });
      }
    } catch {
      // System mode remains available when browser storage is unavailable.
    }

    function syncMode(event: StorageEvent) {
      if (event.key !== storageKey) return;
      const nextMode = isThemeMode(event.newValue) ? event.newValue : "system";
      setModeState(nextMode);
      applyMode(nextMode);
    }

    window.addEventListener("storage", syncMode);
    return () => {
      isCurrent = false;
      window.removeEventListener("storage", syncMode);
    };
  }, []);

  const setMode = useCallback((nextMode: ThemeMode) => {
    setModeState(nextMode);
    applyMode(nextMode);
    try {
      window.localStorage.setItem(storageKey, nextMode);
    } catch {
      // The selected mode still applies for this page view.
    }
  }, []);

  const preference = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return (
    <ThemePreferenceContext.Provider value={preference}>
      {children}
    </ThemePreferenceContext.Provider>
  );
}

export function useThemePreference() {
  const preference = useContext(ThemePreferenceContext);
  if (!preference) {
    throw new Error("useThemePreference must be used inside Providers.");
  }
  return preference;
}
