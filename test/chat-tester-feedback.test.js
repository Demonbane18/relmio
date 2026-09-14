import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_CHAT_TESTER_FEEDBACK,
  nextChatTesterFeedback,
} from "../src/ui/chat-tester-feedback.js";

test("keeps Test AI Chat progress monotonic through completion", () => {
  let feedback = nextChatTesterFeedback(INITIAL_CHAT_TESTER_FEEDBACK, {
    type: "send",
  });
  feedback = nextChatTesterFeedback(feedback, { type: "accepted" });
  feedback = nextChatTesterFeedback(feedback, {
    type: "progress",
    upstreamPhase: "working",
  });
  feedback = nextChatTesterFeedback(feedback, {
    type: "progress",
    upstreamPhase: "connecting",
  });
  assert.equal(feedback.phase, "Waiting");
  assert.equal(feedback.turnStatus, "waiting");

  feedback = nextChatTesterFeedback(feedback, {
    type: "delta",
    text: "Local adapter",
  });
  assert.deepEqual(feedback, {
    phase: "Streaming",
    receivedText: true,
    turnStatus: "streaming",
  });

  feedback = nextChatTesterFeedback(feedback, { type: "complete" });
  assert.equal(feedback.phase, "Complete");
  assert.equal(feedback.turnStatus, "complete");
});

test("keeps empty Test AI Chat deltas pre-output", () => {
  const waiting = nextChatTesterFeedback(
    nextChatTesterFeedback(INITIAL_CHAT_TESTER_FEEDBACK, { type: "send" }),
    { type: "progress", upstreamPhase: "working" },
  );
  const empty = nextChatTesterFeedback(waiting, { type: "delta", text: "" });

  assert.deepEqual(empty, waiting);
  assert.equal(
    nextChatTesterFeedback(empty, { type: "failed" }).turnStatus,
    "failed",
  );
  assert.deepEqual(
    nextChatTesterFeedback(empty, { type: "unexpected" }),
    empty,
  );
});

test("preserves partial Test AI Chat output on failure and stop", () => {
  let feedback = nextChatTesterFeedback(INITIAL_CHAT_TESTER_FEEDBACK, {
    type: "send",
  });
  feedback = nextChatTesterFeedback(feedback, {
    type: "delta",
    text: "Partial",
  });
  const failed = nextChatTesterFeedback(feedback, { type: "failed" });
  assert.equal(failed.turnStatus, "incomplete");
  assert.equal(failed.receivedText, true);

  const stopping = nextChatTesterFeedback(feedback, { type: "stopping" });
  assert.equal(stopping.phase, "Stopping");
  assert.equal(stopping.turnStatus, "stopped");
  const stopped = nextChatTesterFeedback(stopping, { type: "stopped" });
  assert.equal(stopped.phase, "Stopped");
  assert.equal(stopped.receivedText, true);
});
