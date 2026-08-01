"use client";

import { LinkProvider } from "@astryxdesign/core/Link";
import { Theme } from "@astryxdesign/core/theme";
import NextLink from "next/link";
import type { ReactNode } from "react";
import { relmioTheme } from "./relmio.js";

export function Providers({ children }: { children: ReactNode }) {
  return (
    <Theme theme={relmioTheme} mode="system">
      <LinkProvider component={NextLink}>{children}</LinkProvider>
    </Theme>
  );
}
