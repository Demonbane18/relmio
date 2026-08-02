"use client";

import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme } from "@astryxdesign/core/theme";
import NextLink from "next/link";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { relmioTheme } from "./relmio.js";

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
      if (event.key === storageKey) {
        setModeState(isThemeMode(event.newValue) ? event.newValue : "system");
      }
    }

    window.addEventListener("storage", syncMode);
    return () => {
      isCurrent = false;
      window.removeEventListener("storage", syncMode);
    };
  }, []);

  const setMode = useCallback((nextMode: ThemeMode) => {
    setModeState(nextMode);
    try {
      window.localStorage.setItem(storageKey, nextMode);
    } catch {
      // The selected mode still applies for this page view.
    }
  }, []);

  const preference = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return (
    <Theme theme={relmioTheme} mode={mode}>
      <LinkProvider component={NextLink}>
        <ThemePreferenceContext.Provider value={preference}>
          {children}
        </ThemePreferenceContext.Provider>
      </LinkProvider>
    </Theme>
  );
}

export function useThemePreference() {
  const preference = useContext(ThemePreferenceContext);
  if (!preference) {
    throw new Error("useThemePreference must be used inside Providers.");
  }
  return preference;
}
