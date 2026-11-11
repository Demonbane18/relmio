import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { jsx, jsxs } from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { documentationBySlug } from "../app/docs/generated-content.ts";

function* elements(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child);
  } else if (node && typeof node === "object" && node.props) {
    yield node;
    yield* elements(node.props.children);
  }
}

test("all connection buttons update one panel and keep the Claude notice visible once", async () => {
  const source = await readFile(new URL("../app/components/relay/SignalPlotter.tsx", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {};
  let activeRoute;
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "react") return {
        useState(initial) {
          activeRoute ??= initial;
          return [activeRoute, (value) => { activeRoute = value; }];
        },
      };
      if (name === "react/jsx-runtime") return { jsx, jsxs };
      if (name === "next/link") return { __esModule: true, default: "a" };
      if (name.endsWith(".module.css")) return { __esModule: true, default: {} };
      if (name === "../ui/classNames") return { classNames: (...names) => names.filter(Boolean).join(" ") };
      if (name === "../ui/Icon") return { Icon: "span" };
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const initial = exports.SignalPlotter({});
  const group = [...elements(initial)].find((element) => element.props.role === "group");
  assert.equal(group.props["aria-label"], "Setup options");
  const buttons = [...elements(group)].filter((element) => element.type === "button");
  assert.equal(buttons.length, 7);
  assert.equal(buttons.filter((button) => button.props["aria-pressed"]).length, 1);
  const sources = [...elements(initial)].filter((element) => element.type === "circle" && element.props.r === "6");
  assert.equal(sources.length, buttons.length);
  assert.ok(sources.every((element) => element.props.cy >= 6 && element.props.cy <= 298), "all seven sources fit inside the 304-unit map");

  for (const button of [...buttons, buttons[0]]) {
    button.props.onClick();
    const tree = exports.SignalPlotter({});
    const rendered = [...elements(tree)];
    const selected = rendered.filter((element) => element.type === "button" && element.props["aria-pressed"]);
    assert.equal(selected.length, 1);
    assert.equal(selected[0].key, button.key);
    assert.equal(selected[0].props["aria-controls"], "relay-route-detail");
    const panel = rendered.find((element) => element.props.id === "relay-route-detail");
    assert.equal(panel.props["aria-live"], "polite");
    const articles = [...elements(panel)].filter((element) => element.type === "article");
    assert.equal(articles.length, 1, "old content is removed without waiting for an exit animation");
    const guide = [...elements(panel)].find((element) => element.type === "a");
    const slug = guide.props.href.slice("/docs/".length).split("#")[0];
    assert.ok(documentationBySlug.has(slug), `${guide.props.href} resolves to a guide`);
    const html = renderToStaticMarkup(tree);
    assert.equal((html.match(/Not affiliated with or endorsed by Anthropic/gu) ?? []).length, 1);
    if (button.key === "claude") {
      const detail = renderToStaticMarkup(panel);
      assert.match(detail, /Claude for n8n/u);
      assert.match(detail, />Experimental<\/span>/u);
      assert.match(detail, /your own personal use only/u);
      assert.match(detail, /official Claude Code in your own terminal/u);
      assert.match(detail, /VPS route and Hosting options are available from any wizard/u);
      assert.match(detail, /companion on this computer and the relmio claude commands require macOS or Linux/u);
      assert.match(detail, /VPS Claude page is untested on Windows/u);
      assert.equal(guide.props.href, "/docs/claude-subscription");
    }
  }
});

test("app modules and package manifests do not depend on Motion or Tailwind", async () => {
  const app = new URL("../app/", import.meta.url);
  const files = await readdir(app, { recursive: true });
  for (const file of files.filter((name) => /\.[cm]?[jt]sx?$/u.test(name))) {
    const source = await readFile(new URL(file, app), "utf8");
    assert.doesNotMatch(source, /(?:\bfrom\s*|\b(?:import|require)\s*(?:\(\s*)?)["'](?:motion|framer-motion)(?:\/|["'])/u, file);
  }
  for (const file of files.filter((name) => name.endsWith(".css"))) {
    const source = await readFile(new URL(file, app), "utf8");
    assert.doesNotMatch(source, /@(?:tailwind|apply|theme)\b|@import\s+["']tailwindcss(?:\/|["'])/u, file);
  }
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  const packages = [...Object.keys(manifest.dependencies), ...Object.keys(manifest.devDependencies), ...Object.keys(lock.packages)];
  assert.deepEqual(packages.filter((name) => /(?:^|\/)(?:motion(?:-dom|-utils)?|framer-motion|tailwindcss)(?:\/|$)/u.test(name)), []);
});
