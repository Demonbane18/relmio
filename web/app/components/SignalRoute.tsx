"use client";

import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@astryxdesign/core/SegmentedControl";
import { useState } from "react";
import {
  HostIcon,
  NetworkIcon,
  RequestIcon,
  ResponseIcon,
  SidecarIcon,
  WorkstationIcon,
} from "./RouteDeviceIcons";

const routes = {
  local: [
    {
      title: "Your computer",
      detail: "The wizard and sign-in stay local",
      icon: WorkstationIcon,
    },
    {
      title: "SSH host check",
      detail: "You confirm the server fingerprint",
      icon: HostIcon,
    },
    {
      title: "Existing n8n network",
      detail: "Discovery is read only",
      icon: NetworkIcon,
    },
    {
      title: "Private sidecar",
      detail: "Created only after approval",
      icon: SidecarIcon,
    },
  ],
  hosted: [
    {
      title: "Browser sign-in",
      detail: "Connect a supported ChatGPT account",
      icon: WorkstationIcon,
    },
    {
      title: "Request-bound chat",
      detail: "Credentials accompany only your request",
      icon: RequestIcon,
    },
    {
      title: "AI response",
      detail: "The result streams back to this page",
      icon: ResponseIcon,
    },
  ],
} as const;

type RouteMode = keyof typeof routes;

export function SignalRoute() {
  const [mode, setMode] = useState<RouteMode>("local");

  return (
    <section className="signal-panel" aria-labelledby="signal-route-title">
      <header className="signal-panel-header">
        <Heading level={2} id="signal-route-title">
          Your private route
        </Heading>
        <SegmentedControl
          className="route-mode"
          value={mode}
          onChange={(value) => setMode(value as RouteMode)}
          label="Choose route explanation"
          layout="fill"
          size="lg"
        >
          <SegmentedControlItem value="hosted" label="Hosted demo" />
          <SegmentedControlItem value="local" label="Local setup" />
        </SegmentedControl>
      </header>

      <ol className="signal-spine" aria-live="polite">
        {routes[mode].map((step, index) => (
          <li key={step.title}>
            <span className="route-check" aria-hidden="true">
              <Icon icon="check" color="inherit" size="sm" />
            </span>
            <span className="route-device" aria-hidden="true">
              <Icon icon={step.icon} color="accent" size="lg" />
            </span>
            <span className="route-copy">
              <strong>{step.title}</strong>
              <small>{step.detail}</small>
            </span>
            <span className="route-index" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
          </li>
        ))}
      </ol>

      <p className="route-note">
        <Icon icon="info" color="accent" size="sm" />
        {mode === "local"
          ? "Remote writes begin only after your review."
          : "The hosted demo is separate from the VPS installer."}
      </p>
    </section>
  );
}
