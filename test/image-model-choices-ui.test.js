import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const imageModelIds = [
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
];

function createElement() {
  return { hidden: true, textContent: "" };
}

function createElements(prefix) {
  const elements = new Map();
  for (const key of ["2", "flare", "sunburst"]) {
    elements.set(`${prefix}-image-model-${key}`, createElement());
    elements.set(`${prefix}-image-model-${key}-row`, createElement());
  }
  elements.set(`${prefix}-image-models`, createElement());
  return elements;
}

function imageModelRenderer(source) {
  const start = source.indexOf("const IMAGE_MODELS_FOR_N8N");
  const rendererStart = source.indexOf("function renderImageModelsForN8n", start);
  const end = source.indexOf("\nfunction ", rendererStart + 1);
  assert.notEqual(start, -1, "expected image model catalog");
  assert.notEqual(rendererStart, -1, "expected image model renderer");
  assert.notEqual(end, -1, "expected image model renderer");
  return source.slice(start, end);
}

function assertChoices(elements, prefix, expectedIds) {
  for (const [key, id] of [["2", imageModelIds[0]], ["flare", imageModelIds[1]], ["sunburst", imageModelIds[2]]]) {
    const available = expectedIds.includes(id);
    assert.equal(elements.get(`${prefix}-image-model-${key}`).textContent, available ? id : "");
    assert.equal(elements.get(`${prefix}-image-model-${key}-row`).hidden, !available);
  }
  assert.equal(elements.get(`${prefix}-image-models`).hidden, expectedIds.length === 0);
}

test("local bridge ready and runtime-update choices render only returned image IDs and clear stale IDs", async () => {
  const source = await readFile("src/ui/local.js", "utf8");
  const elements = new Map([
    ...createElements("result"),
    ...createElements("update"),
  ]);
  const context = {
    element(id) {
      assert.ok(elements.has(id), `unexpected element ${id}`);
      return elements.get(id);
    },
  };
  runInNewContext(
    `${imageModelRenderer(source)}\nglobalThis.render = renderImageModelsForN8n;`,
    context,
  );

  context.render("result", ["gpt-6-astra", ...imageModelIds]);
  assertChoices(elements, "result", imageModelIds);

  context.render("update", ["gpt-6-astra", imageModelIds[1]]);
  assertChoices(elements, "update", [imageModelIds[1]]);

  context.render("update", ["gpt-6-astra"]);
  assertChoices(elements, "update", []);
  assert.match(source, /renderImageModelsForN8n\("result", sidecar \? result\.models : \[\]\);/u);
  assert.match(source, /renderImageModelsForN8n\("update", \[\]\);/u);
});

test("VPS choices render only returned IDs and leave text recipes on a non-image model", async () => {
  const source = await readFile("src/ui/app.js", "utf8");
  const elements = createElements("result");
  const context = {
    element(id) {
      assert.ok(elements.has(id), `unexpected element ${id}`);
      return elements.get(id);
    },
  };
  runInNewContext(
    `${imageModelRenderer(source)}\nglobalThis.render = renderImageModelsForN8n;`,
    context,
  );

  context.render(["gpt-6-astra", imageModelIds[1], imageModelIds[2]]);
  assertChoices(elements, "result", imageModelIds.slice(1));
  assert.match(source, /const firstTextModel = result\.models\.find\([\s\S]*!model\.startsWith\("gpt-image"\)[\s\S]*\) \?\? "Not detected";/u);
  assert.doesNotMatch(source, /const firstModel = result\.models\[0\]/u);
  assert.match(source, /renderImageModelsForN8n\(result\.models\);/u);
});

test("both browser screens provide safe copy controls and exact n8n Generate/Edit guidance", async () => {
  const [localHtml, localScript, vpsHtml, vpsScript] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
  ]);

  for (const [html, expectedControls] of [[localHtml, 6], [vpsHtml, 3]]) {
    assert.match(html, /Image Generate or Edit, choose From list/u);
    assert.match(html, /choose By ID and paste its exact ID/u);
    assert.match(html, /data-copy-target="(?:result|update)-image-model-flare"/u);
    assert.match(html, /data-copy-target="(?:result|update)-image-model-sunburst"/u);
    const controls = [...html.matchAll(
      /<button[^>]+data-copy-target="(?:result|update)-image-model-(?:2|flare|sunburst)"[^>]*>([\s\S]*?)<\/button>/gu,
    )];
    assert.equal(controls.length, expectedControls);
    for (const [, contents] of controls) {
      assert.match(contents, /<svg class="copy-icon copy-icon-copy"[\s\S]*?<rect[\s\S]*?<\/svg>/u);
      assert.match(contents, /<svg class="copy-icon copy-icon-check"[\s\S]*?m5 12 4 4L19 6[\s\S]*?<\/svg>/u);
    }
  }
  for (const script of [localScript, vpsScript]) {
    for (const id of imageModelIds) assert.match(script, new RegExp(id, "u"));
  }
  assert.match(localScript, /for \(const button of document\.querySelectorAll\("\[data-copy-target\]"\)\)/u);
  assert.match(vpsScript, /\[data-copy-target\], \[data-copy-group\]/u);
  assert.match(localScript, /renderImageModelsForN8n\("update", \[\]\);/u);
  assert.match(vpsScript, /if \(!assistant\) renderImageModelsForN8n\(\[\]\);/u);
});
