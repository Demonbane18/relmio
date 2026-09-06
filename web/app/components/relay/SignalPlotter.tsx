"use client";

import Link from "next/link";
import {
  AnimatePresence,
  motion,
  MotionConfig,
  useReducedMotion,
} from "motion/react";
import {
  Box,
  Braces,
  ExternalLink,
  MessageCircle,
  Server,
} from "lucide-react";
import { useState } from "react";
import styles from "./SignalPlotter.module.css";

const routeDefinitions = [
  {
    id: "n8n-chatgpt-bridge",
    label: "n8n with ChatGPT sign-in",
    icon: Server,
    source: "Your self-hosted n8n",
    credential: "Your ChatGPT/Codex sign-in stays in a private sidecar volume",
    transport: "Private Docker network with no host port",
    destination: "Supported models through the unofficial openai-oauth sidecar",
    link: "/docs/local-endpoints#self-hosted-n8n-bridge",
    linkLabel: "Read the n8n bridge guide",
    note: "This option is unofficial, private, experimental, and policy-uncertain. It does not turn ChatGPT sign-in into a Platform API key.",
    tone: "Unofficial n8n option",
    sourceY: 32,
  },
  {
    id: "model-relay",
    label: "SuperGrok OAuth",
    icon: Box,
    source: "Private local app or SDK",
    credential: "A local Relmio bearer protects the provider-owned OAuth runtime",
    transport: "Private loopback Chat Completions route with a local /chat helper",
    destination: "SuperGrok through Grok Build",
    link: "/docs/local-endpoints#supergrok-development-backends",
    linkLabel: "Read the SuperGrok guide",
    note: "Experimental. Official OAuth stays inside the Grok runtime, and setup never requires or reads a ChatGPT credential.",
    tone: "Experimental OAuth",
    sourceY: 92,
  },
  {
    id: "sandbox-builder",
    label: "n8n Code Sandbox",
    icon: Braces,
    source: "Self-hosted n8n AI Assistant",
    credential: "Sandbox API key shown once; separate runner secrets",
    transport: "Private Docker network to the sandbox API",
    destination: "Code Sandbox and its runner",
    link: "/docs/ai-assistant#what-the-wizard-changes",
    linkLabel: "Read the AI Assistant guide",
    note: "Model-provider credentials are configured directly in n8n, never supplied to the companion. Relmio does not edit the existing n8n container, image, or workflows.",
    tone: "Separate n8n tool",
    sourceY: 152,
  },
  {
    id: "chat-adapter",
    label: "Codex Chat Adapter",
    icon: MessageCircle,
    source: "Trusted local backend",
    credential: "A local Relmio credential protects your ChatGPT sign-in",
    transport: "Experimental local POST /chat",
    destination: "Codex App Server lifecycle",
    link: "/docs/local-endpoints#codex-chat-adapter-development-backends",
    linkLabel: "Read the Chat Adapter guide",
    note: "This experimental route is for a backend you control. It is not an OpenAI-compatible Platform endpoint.",
    tone: "Experimental",
    sourceY: 212,
  },
  {
    id: "app-server",
    label: "Codex App Server",
    icon: Server,
    source: "Trusted native Codex client",
    credential: "A local Relmio credential protects your ChatGPT sign-in",
    transport: "Experimental local WebSocket connection",
    destination: "Codex App Server",
    link: "/docs/local-endpoints#codex-with-chatgpt-agent-clients",
    linkLabel: "Read the App Server guide",
    note: "The client must own the App Server lifecycle. Relmio does not make this a shared or public service.",
    tone: "Experimental",
    sourceY: 272,
  },
] as const;

type RouteDefinition = (typeof routeDefinitions)[number];
type RouteId = RouteDefinition["id"];
const relayEase = [0.22, 1, 0.36, 1] as const;

const routePath = (sourceY: number) =>
  `M 12 ${sourceY} H 132 C 174 ${sourceY} 156 152 210 152 H 268`;

export function SignalPlotter() {
  const [activeRouteId, setActiveRouteId] = useState<RouteId>("n8n-chatgpt-bridge");
  const reduceMotion = useReducedMotion();
  const activeRoute = routeDefinitions.find(
    (route) => route.id === activeRouteId,
  ) ?? routeDefinitions[0];
  const detailMotion = reduceMotion
    ? {
        initial: { opacity: 1, y: 0 },
        animate: { opacity: 1, y: 0, transition: { duration: 0 } },
        exit: { opacity: 1, y: 0, transition: { duration: 0 } },
      }
    : {
        initial: { opacity: 0, y: 6 },
        animate: {
          opacity: 1,
          y: 0,
          transition: { duration: 0.22, ease: relayEase },
        },
        exit: {
          opacity: 0,
          y: -6,
          transition: { duration: 0.14, ease: relayEase },
        },
      };

  return (
    <MotionConfig reducedMotion="user">
      <section className={`${styles.plotter} ${styles.routeExplorer}`} aria-labelledby="plotter-title">
          <header className={styles.plotterHeader}>
            <p className={styles.plotterEyebrow}>Route guide</p>
            <h2 id="plotter-title">Choose a connection</h2>
            <p>Choose a route to see what it uses and where it connects.</p>
          </header>

          <section className={styles.topology}>
            <nav className={styles.routeControls} aria-label="Setup options">
              {routeDefinitions.map((route) => {
                const Icon = route.icon;
                const selected = activeRoute.id === route.id;

                return (
                  <button
                    aria-controls="relay-route-detail"
                    aria-pressed={selected}
                    className={styles.routeButton}
                    key={route.id}
                    onClick={() => setActiveRouteId(route.id)}
                    type="button"
                  >
                    <span className={styles.routeIcon} aria-hidden="true">
                      <Icon />
                    </span>
                    <span>{route.label}</span>
                    {selected ? (
                      <motion.span
                        className={styles.routeMarker}
                        layoutId="active-relay-route"
                        transition={
                          reduceMotion
                            ? { duration: 0 }
                            : { type: "spring", stiffness: 340, damping: 32 }
                        }
                      />
                    ) : null}
                  </button>
                );
              })}
            </nav>

            <figure className={styles.routeMap} aria-label={`${activeRoute.label} connection map`}>
              <svg
                aria-hidden="true"
                className={styles.routeSvg}
                preserveAspectRatio="xMidYMid meet"
                viewBox="0 0 520 304"
              >
                {routeDefinitions.map((route) => (
                  <path
                    className={styles.routeRail}
                    d={routePath(route.sourceY)}
                    key={route.id}
                  />
                ))}
                <path className={styles.routeRail} d="M 268 152 H 500" />
                <AnimatePresence initial={false}>
                  <motion.path
                    animate={{ opacity: 1 }}
                    className={styles.activeRail}
                    d={`${routePath(activeRoute.sourceY)} M 268 152 H 500`}
                    exit={{ opacity: 0 }}
                    initial={{ opacity: 0 }}
                    key={activeRoute.id}
                    transition={{ duration: reduceMotion ? 0 : 0.22 }}
                  />
                </AnimatePresence>
                <motion.circle
                  animate={
                    reduceMotion
                      ? { x: 500, y: 152, opacity: 1 }
                      : {
                          x: [12, 132, 210, 268, 390, 500],
                          y: [
                            activeRoute.sourceY,
                            activeRoute.sourceY,
                            152,
                            152,
                            152,
                            152,
                          ],
                          opacity: [0, 1, 1, 1, 1, 0],
                        }
                  }
                  className={styles.signalPacket}
                  initial={{ x: 12, y: activeRoute.sourceY, opacity: 0 }}
                  key={`signal-${activeRoute.id}`}
                  r="6"
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { duration: 0.82, ease: relayEase }
                  }
                />
                <circle className={styles.gatewayHalo} cx="316" cy="152" r="58" />
                <rect className={styles.gatewayBody} height="88" rx="22" width="76" x="278" y="108" />
                <circle className={styles.gatewayEye} cx="300" cy="138" r="5" />
                <circle className={styles.gatewayEye} cx="332" cy="138" r="5" />
                <circle className={styles.destinationNode} cx="500" cy="152" r="10" />
              </svg>
              <figcaption className={styles.mapCaption}>
                <span>Source</span>
                <span>Relmio</span>
                <span>Destination</span>
              </figcaption>
            </figure>
          </section>

          <AnimatePresence initial={false} mode="wait">
            <motion.article
              animate="animate"
              aria-live="polite"
              className={styles.routeDetail}
              exit="exit"
              id="relay-route-detail"
              initial="initial"
              key={activeRoute.id}
              variants={detailMotion}
            >
              <header className={styles.detailHeader}>
                <p>{activeRoute.tone}</p>
                <h3>{activeRoute.label}</h3>
              </header>
              <ol className={styles.routeStory}>
                <li>
                  <small>Starts here</small>
                  <strong>{activeRoute.source}</strong>
                </li>
                <li>
                  <small>Authentication</small>
                  <strong>{activeRoute.credential}</strong>
                </li>
                <li>
                  <small>Connection</small>
                  <strong>{activeRoute.transport}</strong>
                </li>
                <li>
                  <small>Ends here</small>
                  <strong>{activeRoute.destination}</strong>
                </li>
              </ol>
              <footer className={styles.detailFooter}>
                <p>{activeRoute.note}</p>
                <Link href={activeRoute.link}>
                  {activeRoute.linkLabel}
                  <ExternalLink aria-hidden="true" />
                </Link>
              </footer>
            </motion.article>
          </AnimatePresence>
      </section>

      <section
        aria-labelledby="boundary-title"
        className={styles.boundaryEvidence}
        id="how-it-works"
      >
        <header className={styles.evidenceIntro}>
          <p className={styles.kicker}>Before anything changes</p>
          <h2 id="boundary-title">What Relmio changes, and what it leaves alone.</h2>
          <p>
            Each option shows which credential it uses, where it connects, and
            what it reaches. Before writing to a VPS, the wizard verifies the
            server, shows the plan, and asks you to approve it.
          </p>
        </header>
        <dl className={styles.evidenceList}>
          <dt>Local only</dt>
          <dd>Local endpoints bind to 127.0.0.1 by default.</dd>
          <dt>Hosted chat</dt>
          <dd>The hosted chat forwards credentials only with a request.</dd>
          <dt>You approve changes</dt>
          <dd>The wizard shows the exact plan before any VPS write.</dd>
          <dt>n8n stays separate</dt>
          <dd>
            The companion wizard does not edit the existing n8n container,
            image, or workflows.
          </dd>
        </dl>
      </section>
    </MotionConfig>
  );
}
