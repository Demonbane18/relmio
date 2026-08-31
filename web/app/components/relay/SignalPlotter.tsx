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
    label: "OpenAI API",
    icon: Box,
    source: "Private local app or SDK",
    credential: "A local Relmio credential protects your Platform key",
    transport: "127.0.0.1 /v1, then HTTPS to api.openai.com",
    destination: "OpenAI Platform API",
    link: "/docs/local-endpoints#openai-api-compatible-clients",
    linkLabel: "Read the OpenAI API guide",
    note: "The key stays a Platform credential. ChatGPT sign-in is not converted into an API key.",
    tone: "Uses a Platform API key",
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
    note: "The Platform key is entered directly in n8n, never supplied to the companion. Relmio does not edit the existing n8n container, image, or workflows.",
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
      <section className={styles.homeLead} id="content-start" tabIndex={-1}>
        <section className={styles.intro} aria-labelledby="home-title">
          <p className={styles.kicker}>Your OpenAI setup, kept separate</p>
          <h1 className={styles.title} id="home-title">
            Use your ChatGPT sign-in with the right local tool.
          </h1>
          <p className={styles.lede}>
            Sign in with ChatGPT for the experimental Codex paths. Use a Platform
            key for compatible <code>/v1</code> tools. Choose a path to see where
            n8n, your credential, and the destination connect.
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
            ChatGPT sign-in and Platform API keys do different jobs. Relmio never turns one into the other.
          </p>
        </section>

        <section className={styles.plotter} aria-labelledby="plotter-title">
          <header className={styles.plotterHeader}>
            <p className={styles.plotterEyebrow}>How each option connects</p>
            <h2 id="plotter-title">Choose what you are setting up</h2>
            <p>See the sign-in, connection, and destination for each path.</p>
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
                  <small>Sign-in or key</small>
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
      </section>

      <section
        aria-labelledby="boundary-title"
        className={styles.boundaryEvidence}
        id="how-it-works"
      >
        <header className={styles.evidenceIntro}>
          <p className={styles.kicker}>Before anything changes</p>
          <h2 id="boundary-title">What Relmio changes and leaves alone.</h2>
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
