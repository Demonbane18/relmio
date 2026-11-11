import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { nextTabIndex } from "../app/components/tabKeys.ts";

const appFile = (path) =>
  readFile(new URL(`../app/${path}`, import.meta.url), "utf8");

test("keeps every supported installer method and exact public command", async () => {
  const picker = await appFile("components/CopyCommand.tsx");

  for (const [id, label, command] of [
    ["posix", "macOS / Linux", "curl -fsSL https://relmio.jpfusin.tech/install.sh | sh"],
    ["homebrew", "Homebrew", "brew tap Demonbane18/relmio && brew trust --formula Demonbane18/relmio/relmio && brew install relmio"],
    ["powershell", "PowerShell", "irm https://relmio.jpfusin.tech/install.ps1 | iex"],
    ["cmd", "CMD", "https://relmio.jpfusin.tech/install.cmd"],
    ["npx", "NPX", "npx --yes --ignore-scripts relmio@latest"],
  ]) {
    assert.match(picker, new RegExp(`id: "${id}"`, "u"));
    assert.match(picker, new RegExp(`label: "${label.replace("/", "\\/")}"`, "u"));
    assert.ok(picker.includes(command), `missing installer command: ${command}`);
  }

  assert.doesNotMatch(picker, /winget install/iu);
  assert.doesNotMatch(picker, /brew trust Demonbane18\/relmio(?:\s|$)/u);
});

test("keeps the exact AI Assistant launcher command", async () => {
  const page = await appFile("install/page.tsx");

  assert.ok(page.includes('"npx --yes --ignore-scripts relmio@latest assistant"'));
});

test("moves between installation method tabs with wrapping arrows, Home and End", () => {
  assert.equal(nextTabIndex("ArrowRight", 0, 5), 1);
  assert.equal(nextTabIndex("ArrowRight", 4, 5), 0);
  assert.equal(nextTabIndex("ArrowLeft", 0, 5), 4);
  assert.equal(nextTabIndex("ArrowLeft", 3, 5), 2);
  assert.equal(nextTabIndex("Home", 3, 5), 0);
  assert.equal(nextTabIndex("End", 1, 5), 4);
  assert.equal(nextTabIndex("Enter", 2, 5), null);
  assert.equal(nextTabIndex("ArrowDown", 2, 5), null);
});

test("Windows gets PowerShell after hydration without replacing an explicit tab choice", async () => {
  const source = await appFile("components/CopyCommand.tsx");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  const jsx = (type, props) => ({ type, props });
  function* elements(node) {
    if (Array.isArray(node)) {
      for (const child of node) yield* elements(child);
    } else if (node && typeof node === "object" && node.props) {
      yield node;
      yield* elements(node.props.children);
    }
  }

  for (const [navigator, expected] of [
    [{ platform: "Win32" }, "powershell"],
    [{ platform: "MacIntel", userAgentData: { platform: "Windows" } }, "powershell"],
    [{ platform: "Linux x86_64" }, "posix"],
    [{ platform: "MacIntel" }, "posix"],
  ]) {
    let hydrated = false;
    let chosen = null;
    const exports = {};
    runInNewContext(compiled, {
      exports,
      navigator,
      require(name) {
        if (name === "react") return {
          useRef: () => ({ current: [] }),
          useState: () => [chosen, (value) => { chosen = value; }],
          useSyncExternalStore: (_subscribe, snapshot, serverSnapshot) => hydrated ? snapshot() : serverSnapshot(),
        };
        if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
        if (name === "./tabKeys") return { nextTabIndex };
        if (name === "./ui/CopyButton") return { CopyButton: "copy-button" };
        if (name === "./ui/Icon") return { Icon: "icon" };
        if (name === "../install/install.module.css") return { default: {} };
        throw new Error(`Unexpected import: ${name}`);
      },
    });
    const render = () => [...elements(exports.CopyCommand())];
    const selectedId = () => render().find((element) => element.props.role === "tab" && element.props["aria-selected"]).props.id;
    assert.equal(selectedId(), "install-method-posix-tab", "server HTML always starts with POSIX");
    hydrated = true;
    assert.equal(selectedId(), `install-method-${expected}-tab`);
    const visible = render().filter((element) => element.props.role === "tabpanel" && !element.props.hidden);
    assert.equal(visible.length, 1);
    assert.equal(visible[0].props.id, `install-method-${expected}-panel`);

    render().find((element) => element.props.id === "install-method-homebrew-tab").props.onClick();
    assert.equal(selectedId(), "install-method-homebrew-tab", "an explicit choice overrides the platform");

    // A click replayed during hydration must count even if it picked the
    // already-visible POSIX tab.
    hydrated = false;
    chosen = null;
    render().find((element) => element.props.id === "install-method-posix-tab").props.onClick();
    hydrated = true;
    assert.equal(selectedId(), "install-method-posix-tab");
  }
});

test("opens every new-tab link on the install, docs and changelog pages without an opener", async () => {
  const sources = await Promise.all(
    [
      "install/page.tsx",
      "components/CopyCommand.tsx",
      "docs/DocumentPage.tsx",
      "changelog/page.tsx",
    ].map(appFile),
  );

  for (const source of sources) {
    for (const anchor of source.match(/<a\b[^>]*target="_blank"[^>]*>/gsu) ?? []) {
      assert.match(anchor, /rel="noopener noreferrer"/u, anchor);
    }
  }
});
