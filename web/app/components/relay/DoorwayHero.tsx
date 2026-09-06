"use client";
import Link from "next/link";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowRight, Pause, Play } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import "./tokens.css";
import styles from "./DoorwayHero.module.css";
/*
 * DoorwayHero — the public homepage hero for the Doorway Playground system.
 * A short invitation above a wide, unboxed vector world: an AI cloud
 * home on the left, the little teal doorway in the middle, and a local tool
 * shed on the right. One message glides the full loop and returns.
 *
 * Motion model:
 * - Gentle sapling sway and the workshop gear use CSS keyframes.
 * - The message trip is one SMIL animateMotion along the drawn dashed lane,
 *   so it tracks the path exactly at every viewport size.
 * - One `running` flag (pause control + IntersectionObserver +
 *   visibilitychange + prefers-reduced-motion) freezes CSS via
 *   animation-play-state and SMIL via SVGSVGElement.pauseAnimations().
 * - With reduced motion (or no SMIL) the scene is a complete still: the
 *   packet rests beside the account and the dashed route stays fully drawn.
 */
const tourPath = "M 430 458 " +
    "C 470 480 535 512 600 500 " +
    "C 694 482 800 488 880 506 " +
    "C 905 515 905 550 874 552 " +
    "C 773 575 686 564 600 546 " +
    "C 490 570 365 562 330 430 " +
    "C 360 440 402 454 430 458";
function subscribeSmilSupport() { return () => {}; }
function getSmilSupport() {
    return typeof SVGSVGElement !== "undefined" && typeof SVGAnimationElement !== "undefined" &&
        typeof SVGSVGElement.prototype.pauseAnimations === "function" &&
        typeof SVGSVGElement.prototype.unpauseAnimations === "function" &&
        typeof SVGSVGElement.prototype.setCurrentTime === "function" &&
        typeof SVGAnimationElement.prototype.beginElement === "function";
}
function subscribeReducedMotion(onStoreChange: () => void) {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    query.addEventListener("change", onStoreChange);
    return () => query.removeEventListener("change", onStoreChange);
}
function getReducedMotion() {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
function subscribeVisibility(onStoreChange: () => void) {
    document.addEventListener("visibilitychange", onStoreChange);
    return () => document.removeEventListener("visibilitychange", onStoreChange);
}
function getPageVisible() {
    return document.visibilityState === "visible";
}
export function DoorwayHero() {
    const stageRef = useRef<HTMLElement | null>(null);
    const tripRef = useRef<SVGAnimateMotionElement | null>(null);
    const packetRef = useRef<SVGGElement | null>(null);
    const initialized = useRef(false);
    const svgRef = useRef<SVGSVGElement | null>(null);
    const [userPaused, setUserPaused] = useState(false);
    const [inView, setInView] = useState(false);
    const reducedMotion = useSyncExternalStore(subscribeReducedMotion, getReducedMotion, () => false);
    const pageVisible = useSyncExternalStore(subscribeVisibility, getPageVisible, () => true);
    useEffect(() => {
        const node = stageRef.current;
        if (!node)
            return;
        if (typeof IntersectionObserver === "undefined") return;
        const observer = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.15 });
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    const smilSupported = useSyncExternalStore(subscribeSmilSupport, getSmilSupport, () => false);
    const running = smilSupported && !userPaused && inView && pageVisible && !reducedMotion;
    useEffect(() => {
        const svg = svgRef.current;
        const trip = tripRef.current;
        if (!svg || !trip || typeof svg.pauseAnimations !== "function" ||
            typeof trip.beginElement !== "function")
            return;
        if (!initialized.current) {
            svg.pauseAnimations();
            svg.setCurrentTime(0);
            trip.beginElement();
            svg.querySelectorAll<SVGAnimationElement>("animate[data-arrival-animation]").forEach((label) => label.beginElement());
            packetRef.current?.removeAttribute("transform");
            initialized.current = true;
        }
        if (reducedMotion)
            svg.setCurrentTime(0);
        if (running)
            svg.unpauseAnimations();
        else
            svg.pauseAnimations();
    }, [running, reducedMotion]);
    return (<section id="content-start" tabIndex={-1} className={`doorway-theme ${styles.hero}`} data-scene-running={running ? "true" : "false"} aria-labelledby="doorway-hero-title">
      <VStack className={styles.heroIntro} gap={4}>
        <h1 className={styles.headline} id="doorway-hero-title">
          Bring your AI sign-ins to your tools.
        </h1>
        <p className={styles.lede}>
          Keep every credential where it belongs. Relmio guides you through
          sign-in and setup for n8n and local tools.
        </p>
        <p className={styles.actions}>
          <Link className={styles.installLink} href="/install">
            Install Relmio
            <ArrowRight aria-hidden="true"/>
          </Link>
        </p>
      </VStack>

      <figure ref={stageRef} className={styles.stage}>
        <svg ref={svgRef} className={styles.sceneSvg} viewBox="180 250 840 350" preserveAspectRatio="xMidYMid meet" role="img" aria-label="A message travels between a VPS cloud, the Relmio doorway, and a local workshop.">
          <defs>
            <linearGradient id="doorway-night-sky" x1="0" y1="0" x2="0" y2="1">
              <stop className={styles.nightSkyStop} offset="0" stopOpacity="0"/>
              <stop className={styles.nightSkyStop} offset=".55" stopOpacity=".9"/>
              <stop className={styles.nightSkyStop} offset="1"/>
            </linearGradient>
          </defs>
          <g className={styles.nightScene}>
            <path fill="url(#doorway-night-sky)" d="M 0 250 H 1200 V 580 C 950 590 850 602 600 595 C 360 602 170 588 0 580 Z"/>
            <path className={styles.moonlight} d="M 950 276 A 25 25 0 1 0 970 311 A 29 29 0 0 1 950 276 Z"/>
            {[[240, 274], [475, 291], [690, 274], [811, 326], [1002, 391]].map(([x, y]) => (
              <path key={x} className={styles.moonlight} transform={`translate(${x} ${y})`} d="M 0 -4 L 1.2 -1.2 L 4 0 L 1.2 1.2 L 0 4 L -1.2 1.2 L -4 0 L -1.2 -1.2 Z"/>
            ))}
          </g>
          {/* Ground, route, and message are painted before every building. */}
          <path className={styles.paintHillBack} d="M 0 500 C 210 448 340 456 540 496 C 760 536 954 464 1200 496 L 1200 580 C 950 590 850 602 600 595 C 360 602 170 588 0 580 Z"/>
          <path className={styles.paintHillFront} d="M 0 552 C 270 528 408 550 600 562 C 830 578 1030 526 1200 548 L 1200 580 C 950 590 850 602 600 595 C 360 602 170 588 0 580 Z"/>
          <path id="doorway-tour-path" className={styles.lane} d={tourPath}/>
          {/* This initial position remains visible beside the account in still mode. */}
          <g ref={packetRef} transform="translate(430 458)">
            <circle className={`${styles.paintCoral} ${styles.strokeCreamSoft}`} r="11" strokeWidth="3"/>
            <circle className={styles.paintCreamSoft} r="4"/>
            <animateMotion id="doorway-trip" ref={tripRef} begin="indefinite" dur="13s" repeatCount="indefinite" rotate="0">
              <mpath href="#doorway-tour-path"/>
            </animateMotion>
          </g>

          {/* Two quiet saplings frame the destinations without becoming characters. */}
          {[{ x: 476, y: 550, delay: "-0.8s" }, { x: 982, y: 548, delay: "-1.9s" }].map(({ x, y, delay }) => (
            <g key={x} transform={`translate(${x} ${y})`}>
              <path className={styles.strokeInk} strokeWidth="2.5" strokeLinecap="round" d="M 0 0 L 0 -36"/>
              <g className={styles.sway} style={{ animationDelay: delay }}>
                <path className={`${styles.paintTealSoft} ${styles.strokeInk}`} strokeWidth="2.5"
                  d="M 0 -20 C -23 -41 -19 -62 0 -88 C 19 -62 23 -41 0 -20 Z"/>
                <path className={styles.strokeInk} strokeWidth="2" fill="none" strokeLinecap="round" d="M 0 -20 L 0 -63"/>
              </g>
            </g>
          ))}

          {/* Your account floats above the landscape as a cloud, not a house. */}
          <g transform="translate(330 -70)">
            <path className={`${styles.paintCloud} ${styles.strokeInk}`} strokeWidth="3"
              d="M -82 510 C -113 510 -118 463 -87 450 C -97 418 -71 394 -44 405 C -28 349 53 350 66 405 C 104 402 124 451 100 473 C 111 497 92 510 72 510 Z"/>
          </g>

          {/* Original mascot and doorway paths from the checked-in GitHub banner.
              The square logo remains unchanged in the site header. */}
          <ellipse className={styles.paintShadow} cx="600" cy="548" rx="98" ry="10"/>
          <g transform="translate(508.16 359.6) scale(.82)">
            <path className={`${styles.paintBrandCream} ${styles.strokeInk}`} strokeWidth="3"
              d="M0 220V102C0 39 42 0 112 0s112 39 112 102v118h-46V108c0-40-22-63-66-63s-66 23-66 63v112z"/>
          </g>
          <g transform="translate(560.64 434.68) scale(.82)">
            <g className={styles.mascotFloat}>
              <path className={styles.paintBrandMascot} d="M0 126V47C0 17 18 0 48 0s48 17 48 47v79z"/>
              <g className={`${styles.blink} ${styles.dayEyes}`}>
                <circle className={styles.paintBrandCream} cx="30" cy="47" r="10"/>
                <circle className={styles.paintBrandCream} cx="66" cy="47" r="10"/>
              </g>
              <g className={styles.nightScene}>
                <path className={styles.sleepEyes} d="M 21 45 Q 30 53 39 45 M 57 45 Q 66 53 75 45"/>
                <g data-night-accessory="sleep-cap">
                  <path className={`${styles.paintSky} ${styles.strokeInk}`} strokeWidth="2.5" d="M 4 12 Q 10 -24 48 -28 Q 86 -31 98 -5 L 111 10 Q 90 8 82 -5 Q 73 -13 66 -6 L 91 12 Z"/>
                  <path className={styles.sleepCapStripe} d="M 22 8 Q 26 -12 43 -23 M 48 8 Q 50 -5 59 -12"/>
                  <rect className={`${styles.paintBrandCream} ${styles.strokeInk}`} x="1" y="8" width="94" height="13" rx="6.5" strokeWidth="2.5"/>
                  <circle className={`${styles.paintBrandCream} ${styles.strokeInk}`} cx="111" cy="11" r="7" strokeWidth="2.5"/>
                </g>
                <g className={styles.sleepLetters} aria-hidden="true">
                  <text x="168" y="20" fontSize="17">z</text>
                  <text x="188" y="0" fontSize="21">z</text>
                  <text x="211" y="-23" fontSize="26">Z</text>
                </g>
              </g>
            </g>
          </g>

          {/* Your tools: a workshop, identified by its working gear. */}
          <ellipse className={styles.paintShadow} cx="880" cy="549" rx="84" ry="9"/>
          <g transform="translate(880 0)">
            <path className={`${styles.paintSky} ${styles.strokeInk}`} strokeWidth="3" d="M -76 448 L 0 402 L 76 448 Z"/>
            <rect className={`${styles.paintSkySoft} ${styles.strokeInk}`} strokeWidth="3" x="-68" y="445" width="136" height="95" rx="10"/>
            <path className={`${styles.paintTealDeep} ${styles.strokeInk}`} strokeWidth="2.5" d="M -20 540 L -20 505 A 20 20 0 0 1 20 505 L 20 540 Z"/>
            <rect className={`${styles.paintWindow} ${styles.strokeInk}`} strokeWidth="2.5" x="-52" y="475" width="22" height="24" rx="3"/>
            <g transform="translate(0 462)"><g className={styles.gearSpin}>
              {[0, 60, 120, 180, 240, 300].map((angle) => (<rect key={angle} className={`${styles.paintButter} ${styles.strokeInk}`} strokeWidth="2.5" x="-5" y="-27" width="10" height="12" rx="3" transform={`rotate(${angle})`}/>))}
              <circle className={`${styles.paintButter} ${styles.strokeInk}`} strokeWidth="3" r="16"/>
              <circle className={styles.paintInk} r="3"/>
            </g></g>
          </g>
          {/* Arrival labels share the traveller's SMIL clock, including pause. */}
          {[{ name: "VPS", x: 330, y: 276, times: "0;.86;.88;.95;.97;1" },
            { name: "Local", x: 880, y: 388, times: "0;.32;.34;.40;.42;1" }].map(({ name, x, y, times }) => (
            <g key={name} data-arrival-label={name} transform={`translate(${x} ${y})`} opacity="0">
              <rect className={styles.paintBrandCream} x="-34" y="-23" width="68" height="31" rx="15.5"/>
              <text className={styles.arrivalLabel} textAnchor="middle">{name}</text>
              <animate data-arrival-animation="" attributeName="opacity" values="0;0;1;1;0;0" keyTimes={times} begin="indefinite" dur="13s" repeatCount="indefinite"/>
            </g>
          ))}
        </svg>

        <button type="button" className={styles.pauseButton} aria-pressed={userPaused} aria-label={!smilSupported ? "Animation unavailable" : reducedMotion ? "Animation off: reduced motion" : userPaused ? "Resume animation" : "Pause animation"} disabled={!smilSupported || reducedMotion} onClick={() => setUserPaused((paused) => !paused)}>
          {userPaused ? (<Play aria-hidden="true"/>) : (<Pause aria-hidden="true"/>)}
          {!smilSupported || reducedMotion ? "Motion off" : userPaused ? "Play" : "Pause"}
        </button>


      </figure>
    </section>);
}
