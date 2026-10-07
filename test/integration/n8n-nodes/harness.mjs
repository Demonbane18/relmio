// The parts of the n8n node harness that need no Docker: a mock OpenAI upstream, the real sidecar wired to it,
// and the checks run.mjs applies to each n8n execution.
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSidecarHandler, createSidecarServer } from "../../../src/gateway/openai-oauth-sidecar.mjs";

// A fixed, made-up client key. The sidecar keeps only its SHA-256; nothing here reaches OpenAI.
export const TEST_KEY = "relmio-harness-test-key-not-secret";
// LangChain 1.4.4 (n8n 2.40.7) sends a system prompt as role "developer" only for ids starting "gpt-5" or "o<digit>",
// and the sidecar refuses role "system". Real SIWC catalogs list gpt-5.x ids, so the fake id keeps that prefix.
export const MODEL = "gpt-5-relmio-harness";
export const ANSWER = "Relmio harness answer";
export const TOOL_ARGUMENTS = JSON.stringify({ input: "6*7" });
export const TOOL_RESULT = "42";
const LEASE = "harness-lease-token";
const USAGE = { input_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens: 6, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 18 };

const startedItem = (item) => item.type === "message" ? { ...item, status: "in_progress", content: [] }
  : item.type === "function_call" ? { ...item, status: "in_progress", arguments: "" } : item;

// Streams a turn the way the SIWC route does: every item arrives in output_item.done and the terminal
// response.completed carries an empty output list. The first tool offered is called once, then the turn answers.
export function responseEvents(body, n) {
  const tools = body.input?.find((item) => item?.type === "additional_tools")?.tools ?? [];
  const answered = body.input?.some((item) => item?.type === "function_call_output");
  const tool = !answered && tools.find((entry) => entry.type === "function");
  const items = [];
  if (body.include?.includes("reasoning.encrypted_content")) items.push({ id: `rs_${n}`, type: "reasoning", summary: [], encrypted_content: `encrypted_${n}` });
  items.push(tool
    ? { id: `fc_${n}`, type: "function_call", status: "completed", call_id: `call_${n}`, name: tool.name, arguments: TOOL_ARGUMENTS }
    : { id: `msg_${n}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", annotations: [], logprobs: [], text: ANSWER }] });
  const response = { id: `resp_${n}`, object: "response", created_at: 1_780_000_000, model: body.model, status: "in_progress", output: [] };
  const events = [{ type: "response.created", response }];
  items.forEach((item, output_index) => {
    events.push({ type: "response.output_item.added", output_index, item: startedItem(item) });
    if (item.type === "message") {
      const part = item.content[0];
      events.push({ type: "response.content_part.added", item_id: item.id, output_index, content_index: 0, part: { ...part, text: "" } },
        { type: "response.output_text.delta", item_id: item.id, output_index, content_index: 0, delta: part.text, logprobs: [] },
        { type: "response.output_text.done", item_id: item.id, output_index, content_index: 0, text: part.text, logprobs: [] },
        { type: "response.content_part.done", item_id: item.id, output_index, content_index: 0, part });
    }
    if (item.type === "function_call") {
      events.push({ type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments },
        { type: "response.function_call_arguments.done", item_id: item.id, output_index, arguments: item.arguments });
    }
    events.push({ type: "response.output_item.done", output_index, item });
  });
  events.push({ type: "response.completed", response: { ...response, status: "completed", usage: USAGE } });
  return events.map((event, sequence_number) => ({ ...event, sequence_number }));
}

// The sidecar's fetchImpl. It records every request body the sidecar sends upstream.
export function createMockUpstream() {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url: String(url), body });
    const sse = responseEvents(body, requests.length).map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    return new Response(sse, { headers: { "content-type": "text/event-stream", "x-request-id": `req_${requests.length}` } });
  };
  return { fetchImpl, requests };
}

// The production handler and server with fakes for the parts that would touch a real account.
export async function startSidecar({ fetchImpl, host = "127.0.0.1", port = 0 }) {
  const handler = createSidecarHandler({
    registration: { storageRoot: join(tmpdir(), "relmio-n8n-harness"), registrationId: "harness" },
    runtimeId: "harness",
    tokenVerifier: createHash("sha256").update(TEST_KEY).digest(),
    getToken: async () => ({ accessToken: LEASE }),
    discovery: { listModels: async () => ({ models: [{ id: MODEL, display_name: "Relmio harness model" }] }), recordOutcome() {}, recordActivity() {}, close() {} },
    imagesStatus: async () => ({ state: "off" }),
    fetchImpl,
  });
  const server = createSidecarServer(handler);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  return { port: server.address().port, close: async () => { handler.close(); await server.quiesce(); } };
}

const responsesText = (json) => json?.output?.find((item) => item?.type === "message")?.content?.[0]?.text;

// One entry per workflow in n8n/workflows: the node whose output must carry ANSWER, and whether a tool runs.
export const WORKFLOWS = [
  { id: "RelmioHttpRequest", outputs: { "Responses API": responsesText, "Chat Completions": (json) => json?.choices?.[0]?.message?.content } },
  { id: "RelmioAgentResponses", outputs: { "AI Agent": (json) => json?.output }, tool: "Calculator" },
  { id: "RelmioAgentChat", outputs: { "AI Agent": (json) => json?.output }, tool: "Calculator" },
  { id: "RelmioBasicLlmChain", outputs: { "Basic LLM Chain": (json) => json?.text } },
  { id: "RelmioOpenAiMessage", outputs: { "Message a model": (json) => json?.output?.[0]?.content?.[0]?.text } },
];

// `n8n execute --rawOutput` logs the run as one info message; with N8N_LOG_FORMAT=json each log line is a JSON object.
export function parseExecuteOutput(stdout) {
  let run;
  for (const line of stdout.split("\n")) {
    try {
      const message = JSON.parse(line)?.message;
      const parsed = typeof message === "string" && message.startsWith("{") ? JSON.parse(message) : undefined;
      if (parsed?.data?.resultData) run = parsed;
    } catch { /* Not a log line that carries the run. */ }
  }
  if (!run) throw new Error("n8n printed no execution result.");
  return run;
}

export function checkExecution(spec, run, requests) {
  const problems = [];
  const { error, runData = {} } = run?.data?.resultData ?? {};
  if (error) problems.push(`execution error: ${String(error.message ?? "unknown").slice(0, 300)}`);
  for (const [node, text] of Object.entries(spec.outputs)) {
    const json = runData[node]?.at(-1)?.data?.main?.[0]?.[0]?.json;
    if (text(json) !== ANSWER) problems.push(`${node} returned ${JSON.stringify(text(json) ?? null)}`);
  }
  if (!requests.length) problems.push("the mock upstream saw no request");
  requests.forEach(({ body }, index) => {
    const at = `upstream request ${index + 1}`;
    if (body.model !== MODEL) problems.push(`${at}: model ${JSON.stringify(body.model)}`);
    if (body.store !== false) problems.push(`${at}: store is not false`);
    if (body.stream !== true) problems.push(`${at}: stream is not true`);
    if (body.tools?.some((tool) => tool?.type === "function")) problems.push(`${at}: function tools outside additional_tools`);
    if (body.input?.some((item) => item?.type === "item_reference")) problems.push(`${at}: an item_reference reached upstream`);
  });
  if (spec.tool) {
    const offered = requests[0]?.body.input?.find((item) => item?.type === "additional_tools")?.tools ?? [];
    if (!offered.some((tool) => tool.name === spec.tool)) problems.push(`the first request did not offer ${spec.tool} in additional_tools`);
    const outputs = requests.slice(1).flatMap(({ body }) => body.input?.filter((item) => item?.type === "function_call_output") ?? []);
    if (!outputs.some((item) => JSON.stringify(item.output ?? "").includes(TOOL_RESULT))) problems.push(`no later request carried the ${spec.tool} result ${TOOL_RESULT}`);
  }
  return problems;
}
