"use client";

import Link from "next/link";
import {
  AnimatePresence,
  motion,
  MotionConfig,
  useReducedMotion,
} from "motion/react";
import { useState } from "react";
import { classNames } from "../ui/classNames";
import { Icon, type IconName } from "../ui/Icon";
import styles from "./SignalPlotter.module.css";

const routeDefinitions = [
  {
    id: "n8n-chatgpt-bridge",
    label: "n8n with ChatGPT sign-in",
    icon: "server",
    source: "Your self-hosted n8n",
    credential: "Your ChatGPT/Codex sign-in stays in a private sidecar volume",
    transport: "Private Docker network with no host port",
    destination: "Supported models through the unofficial openai-oauth sidecar",
    link: "/docs/local-endpoints#self-hosted-n8n-bridge",
    linkLabel: "Read the n8n bridge guide",
    note: "This option is unofficial, private, experimental, and policy-uncertain. It does not turn ChatGPT sign-in into a Platform API key.",
    tone: "Unofficial n8n option",
  },
  {
    id: "model-relay",
    label: "SuperGrok OAuth",
    icon: "box",
    source: "Private local app or SDK",
    credential: "A local Relmio bearer protects the provider-owned OAuth runtime",
    transport: "Private loopback Chat Completions route with a local /chat helper",
    destination: "SuperGrok through Grok Build",
    link: "/docs/local-endpoints#supergrok-development-backends",
    linkLabel: "Read the SuperGrok guide",
    note: "Experimental. Official OAuth stays inside the Grok runtime, and setup never requires or reads a ChatGPT credential.",
    tone: "Experimental OAuth",
  },
  {
    id: "sandbox-builder",
    label: "n8n Code Sandbox",
    icon: "terminal",
    source: "Self-hosted n8n AI Assistant",
    credential: "Sandbox API key shown once; separate runner secrets",
    transport: "Private Docker network to the sandbox API",
    destination: "Code Sandbox and its runner",
    link: "/docs/ai-assistant#what-the-wizard-changes",
    linkLabel: "Read the AI Assistant guide",
    note: "Model-provider credentials are configured directly in n8n, never supplied to the companion. Relmio does not edit the existing n8n container, image, or workflows.",
    tone: "Separate n8n tool",
  },
  {
    id: "chat-adapter",
    label: "Codex Chat Adapter",
    icon: "message",
    source: "Trusted local backend",
    credential: "A local Relmio credential protects your ChatGPT sign-in",
    transport: "Experimental local POST /chat",
    destination: "Codex App Server lifecycle",
    link: "/docs/local-endpoints#codex-chat-adapter-development-backends",
    linkLabel: "Read the Chat Adapter guide",
    note: "This experimental route is for a backend you control. It is not an OpenAI-compatible Platform endpoint.",
    tone: "Experimental",
  },
  {
    id: "app-server",
    label: "Codex App Server",
    icon: "network",
    source: "Trusted native Codex client",
    credential: "A local Relmio credential protects your ChatGPT sign-in",
    transport: "Experimental local WebSocket connection",
    destination: "Codex App Server",
    link: "/docs/local-endpoints#codex-with-chatgpt-agent-clients",
    linkLabel: "Read the App Server guide",
    note: "The client must own the App Server lifecycle. Relmio does not make this a shared or public service.",
    tone: "Experimental",
  },
] as const satisfies ReadonlyArray<Record<string, string> & { icon: IconName }>;

type RouteId = (typeof routeDefinitions)[number]["id"];
const relayEase = [0.22, 1, 0.36, 1] as const;

/** The home connection guide: five real toggle buttons and the selected
    route's path from source to destination. Selecting a route redraws the
    path; with reduced motion the path appears complete at once. */
export function SignalPlotter({ className }: { className?: string }) {
  const [activeRouteId, setActiveRouteId] = useState<RouteId>("n8n-chatgpt-bridge");
  const reduceMotion = useReducedMotion();
  const activeRoute =
    routeDefinitions.find((route) => route.id === activeRouteId) ?? routeDefinitions[0];
  const detailMotion = reduceMotion
    ? {
        initial: { opacity: 1, y: 0 },
        animate: { opacity: 1, y: 0, transition: { duration: 0 } },
        exit: { opacity: 1, y: 0, transition: { duration: 0 } },
      }
    : {
        initial: { opacity: 0, y: 6 },
        animate: { opacity: 1, y: 0, transition: { duration: 0.22, ease: relayEase } },
        exit: { opacity: 0, y: -6, transition: { duration: 0.14, ease: relayEase } },
      };

  return (
    <MotionConfig reducedMotion="user">
      <section
        className={classNames("rm-card", styles.plotter, className)}
        aria-labelledby="plotter-title"
      >
        <div className={styles.header}>
          <h2 id="plotter-title" className="rm-h3">
            Choose a connection
          </h2>
          <p className={styles.headerText}>
            Choose a route to see what it uses and where it connects.
          </p>
        </div>

        <div className={styles.topology}>
          <nav className={styles.routeControls} aria-label="Setup options">
            {routeDefinitions.map((route) => (
              <button
                aria-controls="relay-route-detail"
                aria-pressed={activeRoute.id === route.id}
                className={`rm-choice ${styles.routeButton}`}
                key={route.id}
                onClick={() => setActiveRouteId(route.id)}
                type="button"
              >
                <span className={`rm-choice__icon ${styles.routeIcon}`}>
                  <Icon name={route.icon} size="sm" />
                </span>
                <span className={styles.routeLabel}>{route.label}</span>
              </button>
            ))}
          </nav>

          <div className={styles.detailRegion} id="relay-route-detail" aria-live="polite">
            <AnimatePresence initial={false} mode="wait">
              <motion.article
                animate="animate"
                className={styles.routeDetail}
                exit="exit"
                initial="initial"
                key={activeRoute.id}
                variants={detailMotion}
              >
                <div className={styles.detailHeader}>
                  <h3 className={styles.detailTitle}>{activeRoute.label}</h3>
                  <span className="rm-badge">{activeRoute.tone}</span>
                </div>
                <ol
                  className={styles.routeStory}
                  aria-label={`${activeRoute.label} connection map`}
                >
                  {[
                    ["Starts here", activeRoute.source],
                    ["Authentication", activeRoute.credential],
                    ["Connection", activeRoute.transport],
                    ["Ends here", activeRoute.destination],
                  ].map(([label, value]) => (
                    <li key={label}>
                      <span className={styles.node} aria-hidden="true" />
                      <span className={styles.storyLabel}>
                        {label}
                        <span className="rm-visually-hidden">: </span>
                      </span>
                      <span className={styles.storyValue}>{value}</span>
                    </li>
                  ))}
                </ol>
                <p className={styles.note}>{activeRoute.note}</p>
                <Link className={`rm-link ${styles.guideLink}`} href={activeRoute.link}>
                  {activeRoute.linkLabel}
                  <Icon name="arrow-right" size="xs" />
                </Link>
              </motion.article>
            </AnimatePresence>
          </div>
        </div>
      </section>
    </MotionConfig>
  );
}
