"use client";

import Link from "next/link";
import {
  AnimatePresence,
  motion,
  MotionConfig,
  useReducedMotion,
} from "motion/react";
import { useState } from "react";
import site from "../../site.module.css";
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
    note: "This option is unofficial, private and policy-uncertain. It does not turn ChatGPT sign-in into a Platform API key.",
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
    note: "Official OAuth stays inside the Grok runtime, and setup never requires or reads a ChatGPT credential.",
    tone: "Experimental",
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
  {
    id: "local-model",
    label: "Local model for n8n",
    icon: "bot",
    source: "Your self-hosted n8n",
    credential: "No provider sign-in or API key",
    transport: "Private Docker network with no host port",
    destination: "One CPU Ollama model from Relmio's catalog, on local Docker or your VPS",
    link: "/docs/local-models",
    linkLabel: "Read the local model guide",
    note: "CPU answers can be slow. A passed check proves a bounded inference, not a working workflow or tool calling.",
    tone: "No sign-in",
  },
] as const satisfies ReadonlyArray<Record<string, string> & { icon: IconName }>;

type RouteId = (typeof routeDefinitions)[number]["id"];
const relayEase = [0.22, 1, 0.36, 1] as const;

// Route map geometry (viewBox 0 0 520 304): one rail per route on the left
// joins the doorway at y = 152, then one rail runs on to the destination.
const sourceY = (index: number) => 27 + index * 50;
const routePath = (y: number) => `M 12 ${y} H 132 C 174 ${y} 156 152 210 152 H 268`;

/** "How it works": six real toggle buttons, a map of the selected route
    through the Relmio doorway, and its path from source to destination in
    words. With reduced motion the map and path appear complete at once. */
export function SignalPlotter({ className }: { className?: string }) {
  const [activeRouteId, setActiveRouteId] = useState<RouteId>("n8n-chatgpt-bridge");
  const reduceMotion = useReducedMotion();
  const activeIndex = Math.max(
    0,
    routeDefinitions.findIndex((route) => route.id === activeRouteId),
  );
  const activeRoute = routeDefinitions[activeIndex];
  const activeY = sourceY(activeIndex);
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
      <section className={className} id="how-it-works" aria-labelledby="plotter-title">
        <div className="rm-container">
          <header className={classNames(styles.intro, site.reveal)}>
            <p className="rm-eyebrow">How it works</p>
            <h2 id="plotter-title" className={site.sectionTitle}>
              Choose a connection
            </h2>
            <p className="rm-lede">Choose a route to see what it uses and where it connects.</p>
          </header>

          <div className={classNames("rm-card", styles.plotter, site.reveal)}>
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

            <figure className={styles.routeMap} aria-hidden="true">
              <svg className={styles.routeSvg} viewBox="0 0 520 304" preserveAspectRatio="xMidYMid meet">
                <circle className={styles.halo} cx="316" cy="152" r="66" />
                {routeDefinitions.map((route, index) => (
                  <path className={styles.rail} d={routePath(sourceY(index))} key={route.id} />
                ))}
                <path className={styles.rail} d="M 268 152 H 500" />
                <AnimatePresence initial={false}>
                  <motion.path
                    animate={{ opacity: 1 }}
                    className={styles.activeRail}
                    d={`${routePath(activeY)} M 268 152 H 500`}
                    exit={{ opacity: 0 }}
                    initial={{ opacity: 0 }}
                    key={activeRoute.id}
                    transition={{ duration: reduceMotion ? 0 : 0.22 }}
                  />
                </AnimatePresence>
                {routeDefinitions.map((route, index) => (
                  <circle
                    className={route.id === activeRoute.id ? styles.sourceActive : styles.source}
                    cx="12"
                    cy={sourceY(index)}
                    key={route.id}
                    r="6"
                  />
                ))}
                <motion.circle
                  animate={
                    reduceMotion
                      ? { x: 500, y: 152, opacity: 1 }
                      : {
                          x: [12, 132, 210, 268, 390, 500],
                          y: [activeY, activeY, 152, 152, 152, 152],
                          opacity: [0, 1, 1, 1, 1, 0],
                        }
                  }
                  className={styles.packet}
                  initial={{ x: 12, y: activeY, opacity: 0 }}
                  key={`packet-${activeRoute.id}`}
                  r="7"
                  transition={reduceMotion ? { duration: 0 } : { duration: 0.9, ease: relayEase }}
                />
                {/* The Relmio doorway and mascot, from the home scene artwork. */}
                <g transform="translate(260 97) scale(.5)">
                  <path
                    className={styles.doorway}
                    d="M0 220V102C0 39 42 0 112 0s112 39 112 102v118h-46V108c0-40-22-63-66-63s-66 23-66 63v112z"
                  />
                  <g transform="translate(64 94)">
                    <path className={styles.mascot} d="M0 126V47C0 17 18 0 48 0s48 17 48 47v79z" />
                    <circle className={styles.eye} cx="30" cy="47" r="10" />
                    <circle className={styles.eye} cx="66" cy="47" r="10" />
                  </g>
                </g>
                <circle className={styles.destination} cx="500" cy="152" r="10" />
              </svg>
              <figcaption className={styles.mapCaption}>
                <span>Source</span>
                <span>Relmio</span>
                <span>Destination</span>
              </figcaption>
            </figure>

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
                    <span
                      className={classNames(
                        "rm-badge",
                        activeRoute.tone === "Experimental" && "rm-badge--accent",
                      )}
                    >
                      {activeRoute.tone}
                    </span>
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
        </div>
      </section>
    </MotionConfig>
  );
}
