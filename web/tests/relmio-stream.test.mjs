import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_STREAM_FEEDBACK,
  MAX_OUTPUT_BYTES,
  nextPreTextPhase,
  nextStreamFeedback,
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

test("keeps pre-text progress monotonic once upstream work begins", () => {
  assert.equal(nextPreTextPhase("Connecting", "connecting"), "Connecting");
  assert.equal(nextPreTextPhase("Connecting", "working"), "Waiting");
  assert.equal(nextPreTextPhase("Waiting", "connecting"), "Waiting");
  assert.equal(nextPreTextPhase("Waiting", "working"), "Waiting");
});

test("models the complete waiting-to-streaming lifecycle", () => {
  let feedback = nextStreamFeedback(INITIAL_STREAM_FEEDBACK, { type: "send" });
  assert.deepEqual(feedback, {
    assistantStatus: "waiting",
    phase: "Sending",
    receivedText: false,
  });

  feedback = nextStreamFeedback(feedback, { type: "accepted" });
  feedback = nextStreamFeedback(feedback, {
    type: "progress",
    upstreamPhase: "working",
  });
  feedback = nextStreamFeedback(feedback, {
    type: "progress",
    upstreamPhase: "connecting",
  });
  assert.equal(feedback.phase, "Waiting");

  feedback = nextStreamFeedback(feedback, { type: "delta", text: "Relmio" });
  assert.deepEqual(feedback, {
    assistantStatus: "streaming",
    phase: "Streaming",
    receivedText: true,
  });

  feedback = nextStreamFeedback(feedback, { type: "complete" });
  assert.equal(feedback.phase, "Complete");
  assert.equal(feedback.assistantStatus, "complete");
});

test("preserves partial-output status across failure and interruption", () => {
  const beforeText = nextStreamFeedback(
    nextStreamFeedback(INITIAL_STREAM_FEEDBACK, { type: "send" }),
    { type: "failed" },
  );
  assert.equal(beforeText.assistantStatus, "failed");

  let afterText = nextStreamFeedback(INITIAL_STREAM_FEEDBACK, { type: "send" });
  afterText = nextStreamFeedback(afterText, { type: "delta", text: "Relmio" });
  afterText = nextStreamFeedback(afterText, { type: "failed" });
  assert.equal(afterText.assistantStatus, "incomplete");

  const stopping = nextStreamFeedback(afterText, { type: "stopping" });
  assert.equal(stopping.phase, "Stopping");
  assert.equal(stopping.assistantStatus, "stopped");
  const stopped = nextStreamFeedback(stopping, { type: "stopped" });
  assert.equal(stopped.phase, "Stopped");
  assert.equal(stopped.receivedText, true);
});

test("ignores empty delta frames as non-visible output", () => {
  const waiting = nextStreamFeedback(
    nextStreamFeedback(INITIAL_STREAM_FEEDBACK, { type: "send" }),
    { type: "progress", upstreamPhase: "working" },
  );
  const afterEmptyDelta = nextStreamFeedback(waiting, {
    type: "delta",
    text: "",
  });

  assert.deepEqual(afterEmptyDelta, waiting);
  const failed = nextStreamFeedback(afterEmptyDelta, { type: "failed" });
  assert.equal(failed.assistantStatus, "failed");
  assert.equal(failed.receivedText, false);
});
