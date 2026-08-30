"use client";

import Link from "next/link";
import {
  AnimatePresence,
  motion,
  MotionConfig,
  useReducedMotion,
} from "motion/react";
import {
  ArrowRight,
  Box,
  Braces,
  ExternalLink,
  MessageCircle,
  Server,
} from "lucide-react";
import { useState } from "react";
import { HashLink } from "../HashLink";
import styles from "./SignalPlotter.module.css";

const routeDefinitions = [
  {
    id: "model-relay",
    label: "Model Relay",
    icon: Box,
    source: "Private local app or SDK",
    credential: "Relmio capability → protected Platform key",
    transport: "Loopback /v1 → HTTPS to api.openai.com",
    destination: "OpenAI Platform API",
    link: "/docs/local-endpoints#openai-api-compatible-clients",
    linkLabel: "Read the Model Relay contract",
    note: "The key stays a Platform credential. ChatGPT sign-in is not converted into an API key.",
    tone: "Platform route",
    sourceY: 44,
  },
  {
    id: "sandbox-builder",
    label: "n8n Code Sandbox Builder",
    icon: Braces,
    source: "Self-hosted n8n AI Assistant",
    credential: "Sandbox API key shown once; separate runner secrets",
    transport: "Private Docker network and mTLS sandbox API",
    destination: "Sandbox API and isolated runner",
    link: "/docs/ai-assistant#what-the-wizard-changes",
    linkLabel: "Review the n8n companion boundary",
    note: "The Platform key is entered directly in n8n, never supplied to the companion. Relmio does not edit the existing n8n container, image, or workflows.",
    tone: "Human-gated plan",
    sourceY: 116,
  },
  {
    id: "chat-adapter",
    label: "Codex Chat Adapter",
    icon: MessageCircle,
    source: "Trusted local backend",
    credential: "Relmio capability → protected ChatGPT sign-in",
    transport: "Experimental loopback POST /chat",
    destination: "Codex App Server lifecycle",
    link: "/docs/local-endpoints#codex-chat-adapter-development-backends",
    linkLabel: "Read the Chat Adapter contract",
    note: "This experimental route is for a backend you control. It is not an OpenAI-compatible Platform endpoint.",
    tone: "Experimental route",
    sourceY: 188,
  },
  {
    id: "app-server",
    label: "Codex App Server",
    icon: Server,
    source: "Trusted native Codex client",
    credential: "Relmio capability → protected ChatGPT sign-in",
    transport: "Experimental loopback WebSocket JSON-RPC",
    destination: "Codex App Server",
    link: "/docs/local-endpoints#codex-with-chatgpt-agent-clients",
    linkLabel: "Read the App Server contract",
    note: "The client must own the App Server lifecycle. Relmio does not make this a shared or public service.",
    tone: "Experimental route",
    sourceY: 260,
  },
] as const;

type RouteDefinition = (typeof routeDefinitions)[number];
type RouteId = RouteDefinition["id"];
const relayEase = [0.22, 1, 0.36, 1] as const;

const routePath = (sourceY: number) =>
  `M 12 ${sourceY} H 132 C 174 ${sourceY} 156 152 210 152 H 268`;

export function SignalPlotter() {
  const [activeRouteId, setActiveRouteId] = useState<RouteId>("model-relay");
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
      <section className={styles.homeLead} id="content-start" tabIndex={-1}>
        <section className={styles.intro} aria-labelledby="home-title">
          <p className={styles.kicker}>Private relay infrastructure</p>
          <h1 className={styles.title} id="home-title">
            Route every request with boundaries you can see.
          </h1>
          <p className={styles.lede}>
            Relmio connects your own credentials to your own tools through four
            explicit local contracts. Choose a route to inspect what crosses
            each boundary.
          </p>
          <nav className={styles.actions} aria-label="Get started">
            <HashLink className={styles.primaryAction} targetId="chat">
              Open hosted chat
              <ArrowRight aria-hidden="true" />
            </HashLink>
            <Link className={styles.secondaryAction} href="/install">
              Install Relmio
            </Link>
          </nav>
          <p className={styles.introBoundary}>
            Platform API keys and ChatGPT sign-in remain separate credentials.
            Relmio never turns one into the other.
          </p>
        </section>

        <section className={styles.plotter} aria-labelledby="plotter-title">
          <header className={styles.plotterHeader}>
            <p className={styles.plotterEyebrow}>Live boundary map</p>
            <h2 id="plotter-title">Select a relay contract</h2>
            <p>Four routes. One visible path at a time.</p>
          </header>

          <section className={styles.topology}>
            <nav className={styles.routeControls} aria-label="Relay contracts">
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

            <figure className={styles.routeMap} aria-label={`${activeRoute.label} topology`}>
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
                <path className={styles.gatewayMouth} d="M 300 168 H 332" />
                <circle className={styles.destinationNode} cx="500" cy="152" r="10" />
              </svg>
              <figcaption className={styles.mapCaption}>
                <span>Source</span>
                <span>Relmio boundary</span>
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
                  <small>Source</small>
                  <strong>{activeRoute.source}</strong>
                </li>
                <li>
                  <small>Credential boundary</small>
                  <strong>{activeRoute.credential}</strong>
                </li>
                <li>
                  <small>Transport</small>
                  <strong>{activeRoute.transport}</strong>
                </li>
                <li>
                  <small>Destination</small>
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
      </section>

      <section
        aria-labelledby="boundary-title"
        className={styles.boundaryEvidence}
        id="how-it-works"
      >
        <header className={styles.evidenceIntro}>
          <p className={styles.kicker}>Boundary evidence</p>
          <h2 id="boundary-title">The contract stays legible after setup.</h2>
          <p>
            Every route names its credential, transport, and destination. The
            n8n companion wizard keeps remote writes behind host-key
            verification, an exact plan, and final human confirmation.
          </p>
        </header>
        <dl className={styles.evidenceList}>
          <dt>Loopback-first</dt>
          <dd>Local endpoints bind to 127.0.0.1 by default.</dd>
          <dt>Request-bound demo</dt>
          <dd>The hosted chat forwards credentials only with a request.</dd>
          <dt>Human-gated setup</dt>
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
