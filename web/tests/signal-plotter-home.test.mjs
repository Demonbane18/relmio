import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appFile = (path) =>
  readFile(new URL(`../app/${path}`, import.meta.url), "utf8");

test("renders one selectable topology for all four truthful relay contracts", async () => {
  const [home, plotter] = await Promise.all([
    appFile("page.tsx"),
    appFile("components/relay/SignalPlotter.tsx"),
  ]);

  assert.match(home, /<SignalPlotter\s*\/>/u);
  for (const label of [
    "Model Relay",
    "n8n Code Sandbox Builder",
    "Codex Chat Adapter",
    "Codex App Server",
  ]) {
    assert.ok(plotter.includes(label), `missing relay contract: ${label}`);
  }
  assert.match(plotter, /className=\{styles\.topology\}/u);
  assert.doesNotMatch(plotter, /cardGrid|featureCards|capabilityCards/iu);
});

test("uses real pressed buttons and exposes the complete boundary story", async () => {
  const plotter = await appFile("components/relay/SignalPlotter.tsx");

  assert.match(plotter, /<button[\s\S]*aria-pressed=\{selected\}[\s\S]*type="button"/u);
  assert.match(plotter, /aria-controls="relay-route-detail"/u);
  for (const field of ["Source", "Credential boundary", "Transport", "Destination"]) {
    assert.ok(plotter.includes(field), `missing route field: ${field}`);
  }
  assert.match(plotter, /Relmio capability → protected Platform key/u);
  assert.match(plotter, /Sandbox API key shown once; separate runner secrets/u);
  assert.match(plotter, /Platform key is entered directly in n8n/u);
  assert.match(plotter, /Relmio capability → protected ChatGPT sign-in/u);
  assert.match(plotter, /never turns one into the other/u);
});

test("animates the active path with an explicit reduced-motion final state", async () => {
  const plotter = await appFile("components/relay/SignalPlotter.tsx");

  assert.match(plotter, /from "motion\/react"/u);
  assert.match(plotter, /useReducedMotion\(\)/u);
  assert.match(plotter, /<AnimatePresence/u);
  assert.match(plotter, /<motion\.circle/u);
  assert.match(plotter, /reduceMotion\s*\?\s*\{ x: 500, y: 152, opacity: 1 \}/u);
  assert.match(plotter, /layoutId="active-relay-route"/u);
});

test("keeps the topology an asymmetric field instead of a four-card layout", async () => {
  const styles = await appFile("components/relay/SignalPlotter.module.css");

  assert.match(
    styles,
    /\.homeLead\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*0\.72fr\)\s+minmax\(0,\s*1\.28fr\)/u,
  );
  assert.match(styles, /\.routeControls\s*\{[\s\S]*flex-direction:\s*column/u);
  assert.doesNotMatch(styles, /repeat\(4,\s*minmax/u);
  assert.doesNotMatch(styles, /\.card(?:Grid)?\b/iu);
});

test("keeps the evidence copy inside verified local and human-gated boundaries", async () => {
  const plotter = await appFile("components/relay/SignalPlotter.tsx");

  for (const evidence of [
    "Local endpoints bind to 127.0.0.1 by default.",
    "The hosted chat forwards credentials only with a request.",
    "The wizard shows the exact plan before any VPS write.",
    "does not edit the existing n8n container",
  ]) {
    assert.ok(plotter.includes(evidence), `missing evidence boundary: ${evidence}`);
  }
  assert.doesNotMatch(plotter, /OpenAI approved|compliant provider|zero risk|guaranteed/iu);
});
