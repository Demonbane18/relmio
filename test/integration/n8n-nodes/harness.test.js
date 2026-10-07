import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { ANSWER, checkExecution, createMockUpstream, MODEL, parseExecuteOutput, startSidecar, TEST_KEY, TOOL_ARGUMENTS, TOOL_RESULT, WORKFLOWS } from "./harness.mjs";
import { cleanupCommands, containerArgs } from "./run.mjs";

const calculator = { type: "function", name: "Calculator", description: "Arithmetic", parameters: { type: "object", properties: { input: { type: "string" } } } };

async function withSidecar(t) {
  const upstream = createMockUpstream();
  const sidecar = await startSidecar({ fetchImpl: upstream.fetchImpl });
  t.after(() => sidecar.close());
  const post = (path, body) => fetch(`http://127.0.0.1:${sidecar.port}/v1${path}`, {
    method: "POST", headers: { authorization: `Bearer ${TEST_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { upstream, post };
}

test("a Responses tool turn through the real sidecar rebuilds the mock's empty terminal output", async (t) => {
  const { upstream, post } = await withSidecar(t);
  const first = await post("/responses", { model: MODEL, input: [{ role: "user", content: "6 times 7?" }], tools: [calculator] });
  assert.equal(first.status, 200);
  const call = (await first.json()).output.find((item) => item.type === "function_call");
  assert.deepEqual([call.name, call.arguments], ["Calculator", TOOL_ARGUMENTS]);
  const sent = upstream.requests[0].body;
  assert.deepEqual([sent.store, sent.stream, sent.tools, sent.input[0].type, sent.input[0].tools[0].name], [false, true, undefined, "additional_tools", "Calculator"]);

  const second = await post("/responses", { model: MODEL, tools: [calculator],
    input: [{ role: "user", content: "6 times 7?" }, call, { type: "function_call_output", call_id: call.call_id, output: TOOL_RESULT }] });
  const message = (await second.json()).output.find((item) => item.type === "message");
  assert.equal(message.content[0].text, ANSWER);
  assert.deepEqual(checkExecution({ outputs: {}, tool: "Calculator" }, { data: { resultData: { runData: {} } } }, upstream.requests), []);
});

test("Chat Completions through the real sidecar gets the mock's answer and streamed tool call", async (t) => {
  const { upstream, post } = await withSidecar(t);
  const plain = await post("/chat/completions", { model: MODEL, messages: [{ role: "user", content: "Hi" }] });
  assert.equal((await plain.json()).choices[0].message.content, ANSWER);
  const streamed = await post("/chat/completions", { model: MODEL, stream: true, messages: [{ role: "user", content: "6 times 7?" }],
    tools: [{ type: "function", function: { name: "Calculator", parameters: calculator.parameters } }] });
  const chunks = (await streamed.text()).split("\n").filter((line) => line.startsWith("data: {")).map((line) => JSON.parse(line.slice(6)));
  assert.equal(chunks.find((chunk) => chunk.choices[0]?.delta?.tool_calls?.[0]?.id)?.choices[0].delta.tool_calls[0].function.name, "Calculator");
  assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
  assert.deepEqual(upstream.requests.map(({ body }) => [body.store, body.stream]), [[false, true], [false, true]]);
});

test("checkExecution names every way a run can fail", () => {
  const spec = { outputs: { "AI Agent": (json) => json?.output }, tool: "Calculator" };
  const run = (output, error) => ({ data: { resultData: { error, runData: { "AI Agent": [{ data: { main: [[{ json: { output: "step" } }]] } }, { data: { main: [[{ json: { output } }]] } }] } } } });
  const offer = { model: MODEL, store: false, stream: true, input: [{ type: "additional_tools", role: "developer", tools: [calculator] }] };
  const answer = { model: MODEL, store: false, stream: true, input: [{ type: "function_call_output", call_id: "c", output: `{"response":"${TOOL_RESULT}"}` }] };
  const requests = [{ body: offer }, { body: answer }];
  assert.deepEqual(checkExecution(spec, run(ANSWER), requests), []);
  for (const [actual, input, problem] of [
    [run("other"), requests, /AI Agent returned "other"/u],
    [run(ANSWER, { message: "Bad request" }), requests, /execution error: Bad request/u],
    [run(ANSWER), [], /saw no request/u],
    [run(ANSWER), [{ body: { ...offer, store: undefined } }, { body: answer }], /store is not false/u],
    [run(ANSWER), [{ body: { ...offer, model: "gpt-other" } }, { body: answer }], /model "gpt-other"/u],
    [run(ANSWER), [{ body: { ...offer, tools: [calculator] } }, { body: answer }], /outside additional_tools/u],
    [run(ANSWER), [{ body: offer }, { body: { ...answer, input: [...answer.input, { type: "item_reference", id: "rs_1" }] } }], /item_reference/u],
    [run(ANSWER), [{ body: { ...offer, input: [] } }, { body: answer }], /did not offer Calculator/u],
    [run(ANSWER), [{ body: offer }, { body: { ...answer, input: [] } }], /result 42/u],
  ]) assert.match(checkExecution(spec, actual, input).join("\n"), problem);
});

test("parseExecuteOutput reads the run from n8n's JSON log lines and refuses output without one", () => {
  const run = { data: { resultData: { runData: {} } }, status: "success" };
  const lines = [JSON.stringify({ level: "info", message: "Initializing n8n process" }), "not json",
    JSON.stringify({ level: "info", message: JSON.stringify(run, null, 2) }), JSON.stringify({ level: "info", message: "{ not a run" })];
  assert.deepEqual(parseExecuteOutput(lines.join("\n")), run);
  assert.throws(() => parseExecuteOutput(lines.slice(0, 2).join("\n")), /no execution result/u);
});

test("each workflow file meets n8n 2.40.7's import and CLI rules and has a check", async () => {
  const dir = new URL("n8n/", import.meta.url);
  const credentials = new Set(JSON.parse(await readFile(new URL("credentials.json", dir), "utf8")).map(({ id }) => id));
  const files = (await readdir(new URL("workflows/", dir))).filter((name) => name.endsWith(".json"));
  const ids = [];
  for (const file of files) {
    const workflow = JSON.parse(await readFile(new URL(`workflows/${file}`, dir), "utf8"));
    const names = workflow.nodes.map((node) => node.name);
    ids.push(workflow.id);
    // isWorkflowIdValid (cli/src/utils.ts), findCliWorkflowStart, and workflow-structure-validation.ts.
    assert.ok(workflow.id.length > 0 && workflow.id.length <= 21, file);
    assert.equal(workflow.active, false, file);
    assert.ok(workflow.nodes.some((node) => node.type === "n8n-nodes-base.manualTrigger"), file);
    assert.equal(new Set(names).size, names.length, file);
    assert.equal(new Set(workflow.nodes.map((node) => node.id)).size, names.length, file);
    for (const node of workflow.nodes) {
      assert.ok(Array.isArray(node.position) && node.position.length === 2, `${file} ${node.name}`);
      for (const reference of Object.values(node.credentials ?? {})) assert.ok(credentials.has(reference.id), `${file} ${node.name}`);
    }
    for (const [source, outputs] of Object.entries(workflow.connections)) {
      assert.ok(names.includes(source), `${file} ${source}`);
      for (const target of Object.values(outputs).flat(2)) assert.ok(names.includes(target.node), `${file} ${target.node}`);
    }
    const spec = WORKFLOWS.find(({ id }) => id === workflow.id);
    assert.ok(spec, file);
    for (const node of Object.keys(spec.outputs)) assert.ok(names.includes(node), `${file} ${node}`);
  }
  assert.deepEqual(ids.sort(), WORKFLOWS.map(({ id }) => id).sort());
});

test("Docker commands stay on this run's own objects and publish no port", () => {
  const project = "relmio-n8n-nodes-0a1b2c3d";
  const args = containerArgs(project, "172.18.0.1", "/work/test/integration/n8n-nodes/n8n", "key");
  assert.equal(args.some((arg) => arg === "--publish" || arg === "-p" || arg.startsWith("--publish=")), false);
  assert.ok(args.includes("n8n-openai-oauth:172.18.0.1"));
  assert.ok(cleanupCommands(project).every((command) => command.at(-1).startsWith(project)));
  for (const name of ["n8n", "relmio-n8n-nodes-", "relmio-n8n-nodes-0a1b2c3d;rm", "other-relmio-n8n-nodes-0a1b2c3d"]) {
    assert.throws(() => cleanupCommands(name), /outside this harness run/u);
    assert.throws(() => containerArgs(name, "172.18.0.1", "/work", "key"), /outside this harness run/u);
  }
  assert.throws(() => containerArgs(project, "host-gateway", "/work", "key"), /IPv4/u);
  assert.throws(() => containerArgs(project, "172.18.0.1", "/work,dst=/etc", "key"), /--mount/u);
});
