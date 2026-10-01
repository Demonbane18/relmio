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

test("local image choices render only returned IDs and clear stale IDs", async () => {
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
});

test("VPS image choices render only returned image IDs", async () => {
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
});
