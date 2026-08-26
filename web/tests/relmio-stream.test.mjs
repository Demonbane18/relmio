import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_OUTPUT_BYTES,
  readRelmioEvents,
} from "../app/components/relmio-stream.js";

const encoder = new TextEncoder();

function streamFromText(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

test("accepts a small hosted answer split across enough frames to exceed the old wire cap", async () => {
  const frameCount = 3_000;
  const stream = streamFromText(
    `${Array.from(
      { length: frameCount },
      () => 'event: delta\ndata: {"text":"x"}\n\n',
    ).join("")}event: terminal\ndata: {"outcome":"completed"}\n\n`,
  );

  let output = "";
  let terminal = false;
  for await (const item of readRelmioEvents(stream)) {
    if (item.event === "delta") output += item.data.text;
    if (item.event === "terminal") terminal = true;
  }

  assert.equal(output, "x".repeat(frameCount));
  assert.equal(terminal, true);
});

test("rejects decoded hosted output above the display limit", async () => {
  const stream = streamFromText(
    `event: delta\ndata: ${JSON.stringify({ text: "x".repeat(MAX_OUTPUT_BYTES + 1) })}\n\n`,
  );

  await assert.rejects(
    async () => {
      for await (const item of readRelmioEvents(stream)) {
        void item;
        // Consume the bounded protocol reader.
      }
    },
    /safe display limit/u,
  );
});
