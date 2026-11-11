import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { documentationPages } from "../app/docs/generated-content.ts";
import * as markdownText from "../app/docs/markdownText.ts";

function* elements(node) {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child);
  } else if (node && typeof node === "object" && node.props) {
    yield node;
    yield* elements(node.props.children);
  }
}

test("loads the section index on first focus and returns heading links for full-text searches", async () => {
  const source = await readFile(new URL("../app/docs/DocumentationSearch.tsx", import.meta.url), "utf8");
  const sectionIndex = JSON.parse(await readFile(new URL("../app/docs/generated-sections.json", import.meta.url), "utf8"));
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const exports = {};
  const jsx = (type, props) => ({ type, props });
  const state = [];
  let cursor = 0;
  let indexLoads = 0;
  runInNewContext(compiled, {
    exports,
    require(name) {
      if (name === "react") return {
        useId: () => "docs-search",
        useMemo: (getValue) => getValue(),
        useState(initial) {
          const slot = cursor++;
          if (!Object.hasOwn(state, slot)) state[slot] = initial;
          return [state[slot], (value) => { state[slot] = value; }];
        },
      };
      if (name === "react/jsx-runtime") return { jsx, jsxs: jsx, Fragment: "fragment" };
      if (name === "next/link") return { __esModule: true, default: "a" };
      if (name === "./docs.module.css") return { __esModule: true, default: {} };
      if (name === "./markdownText") return markdownText;
      if (name === "./generated-sections.json") {
        indexLoads++;
        return sectionIndex;
      }
      throw new Error(`Unexpected import: ${name}`);
    },
  });
  const guides = documentationPages.map((page, index) => ({
    slug: page.slug,
    title: page.title,
    status: page.status,
    summary: page.summary ?? markdownText.guideSummary(page.content),
    number: String(index + 1).padStart(2, "0"),
  }));
  const render = () => {
    cursor = 0;
    return [...elements(exports.DocumentationSearch({ guides }))];
  };
  let rendered = render();
  assert.equal(indexLoads, 0, "rendering must not load the index");
  rendered.find((element) => element.type === "input").props.onFocus();
  await new Promise(setImmediate);
  assert.equal(indexLoads, 1);
  rendered = render();
  rendered.find((element) => element.type === "input").props.onFocus();
  await new Promise(setImmediate);
  assert.equal(indexLoads, 1, "later focus reuses the index");

  for (const query of ["fingerprint", "windows", "host key"]) {
    render().find((element) => element.type === "input").props.onChange({ currentTarget: { value: query } });
    rendered = render();
    const links = rendered.filter((element) => element.type === "a" && element.props.href.includes("#"));
    assert.ok(links.length > 0, `${query}: no section links`);
    assert.deepEqual(
      links.map((link) => link.props.href),
      markdownText.matchingSections(sectionIndex, query).map(markdownText.sectionHref),
      query,
    );
    assert.ok(links.every((link) => link.props.href.startsWith("/docs/")), "links stay on the site");
  }
  assert.equal(indexLoads, 1, "typing reuses the loaded index");
});

test("section matching uses a case-insensitive substring and puts heading matches first", () => {
  const sections = [
    { slug: "one", id: "one", heading: "Setup", text: "Compare the host key fingerprint." },
    { slug: "two", id: "two", heading: "Host key", text: "Compare the fingerprint." },
    { slug: "three", id: "three", heading: "Other", text: "The host has a key." },
  ];
  assert.deepEqual(markdownText.matchingSections(sections, " HOST KEY ").map(markdownText.sectionHref), [
    "/docs/two#two",
    "/docs/one#one",
  ]);
  assert.deepEqual(markdownText.matchingSections(sections, "host-key"), []);
  assert.deepEqual(markdownText.matchingSections(sections, " "), []);
});
