// n8n's AI Assistant reaches the sidecar through the AI SDK, not through a node, so it runs here without Docker.
// The calls copy n8n 2.40.7: instance-ai-verification.service.ts:139-144 (model check) and stream-sink.ts:238-261
// (chat turn, with the thinking options from apply-agent-thinking.ts:44-47).
import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText, jsonSchema, stepCountIs, streamText, tool } from "ai";
import { ANSWER, createMockUpstream, MODEL, startSidecar, TEST_KEY, TOOL_RESULT } from "./harness.mjs";

test("the n8n AI Assistant model check and a two-step tool turn work through the sidecar", async (t) => {
  const upstream = createMockUpstream();
  const sidecar = await startSidecar({ fetchImpl: upstream.fetchImpl });
  t.after(() => sidecar.close());
  const openai = createOpenAI({ baseURL: `http://127.0.0.1:${sidecar.port}/v1`, apiKey: TEST_KEY });

  const check = await generateText({ model: openai(MODEL), prompt: "Reply with OK.", maxOutputTokens: 16, abortSignal: AbortSignal.timeout(30_000) });
  assert.equal(check.text, ANSWER);
  assert.equal("max_output_tokens" in upstream.requests[0].body, false);

  const calculator = tool({
    description: "Evaluate an arithmetic expression",
    inputSchema: jsonSchema({ type: "object", properties: { input: { type: "string" } }, required: ["input"], additionalProperties: false }),
    execute: async ({ input }) => (input === "6*7" ? TOOL_RESULT : "unexpected input"),
  });
  const turn = streamText({
    model: openai(MODEL), instructions: "You are the n8n Assistant.", messages: [{ role: "user", content: "What is 6 times 7?" }],
    allowSystemInMessages: true, include: { rawChunks: true }, tools: { calculator },
    providerOptions: { openai: { reasoningEffort: "high", reasoningSummary: null } }, stopWhen: stepCountIs(2),
  });
  assert.equal(await turn.text, ANSWER);

  const [first, second] = upstream.requests.slice(1).map(({ body }) => body);
  assert.equal(upstream.requests.length, 3);
  assert.equal(first.input[0].tools[0].name, "calculator");
  assert.ok(first.include.includes("reasoning.encrypted_content"));
  // The SDK replays step 1 as item references; under store:false the sidecar must send the full items instead.
  assert.equal(second.input.some((item) => item.type === "item_reference"), false);
  assert.ok(second.input.some((item) => item.type === "reasoning" && item.encrypted_content === "encrypted_2"));
  const call = second.input.find((item) => item.type === "function_call");
  const output = second.input.find((item) => item.type === "function_call_output");
  assert.equal(output.call_id, call.call_id);
  assert.ok(JSON.stringify(output.output).includes(TOOL_RESULT));
});
