import { createOpenAIOAuthTransport } from "@openai-oauth/core";
import { openaiCredentials } from "@openai-oauth/react/server";

export const runtime = "nodejs";

const MAX_PROMPT_LENGTH = 3000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_UPSTREAM_STREAM_BYTES = 256 * 1024;
const FIRST_BYTE_TIMEOUT_MS = 45_000;
const IDLE_TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 120_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const SYSTEM_INSTRUCTIONS =
  "You are Relmio's concise demo assistant. Give a direct conversational answer. Do not use tools, inspect files, run commands, or access external resources. Help with AI workflows, n8n, OpenAI-compatible clients, and clear technical explanations. Never claim Relmio creates an OpenAI Platform API key or bypasses provider limits. If asked about credentials, remind the user to protect OAuth sessions like passwords.";
const TERMINAL_TYPES = new Set([
  "error",
  "response.failed",
  "response.incomplete",
  "response.cancelled",
  "response.canceled",
]);

type StreamErrorCode =
  | "auth_unavailable"
  | "hosting_network_blocked"
  | "output_limit"
  | "timeout"
  | "upstream_failed";

type ParsedSseEvent = {
  data?: string;
  event?: string;
};

function encodeEvent(event: string, data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseEventBlock(block: string): ParsedSseEvent {
  const data: string[] = [];
  let event: string | undefined;
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  return {
    ...(event ? { event } : {}),
    ...(data.length > 0 ? { data: data.join("\n") } : {}),
  };
}

async function* iterateEvents(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let exhausted = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        exhausted = true;
        break;
      }
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_STREAM_BYTES) {
        throw new Error("upstream-stream-limit");
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/u);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (block.trim()) yield parseEventBlock(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield parseEventBlock(buffer);
  } finally {
    if (!exhausted) {
      try {
        await reader.cancel();
      } catch {
        // The upstream may already be closing after its terminal event.
      }
    }
    reader.releaseLock();
  }
}

function errorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return undefined;
  }
  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function safeErrorCategory(error: unknown): string {
  const statusCode = errorStatusCode(error);
  return statusCode ? `upstream-status-${statusCode}` : "upstream-error";
}

function streamResponse(request: Request, prompt: string): Response {
  const requestController = new AbortController();
  let abortKind: "client" | "timeout" | null = null;
  const abortFromClient = () => {
    abortKind = "client";
    requestController.abort();
  };
  request.signal.addEventListener("abort", abortFromClient, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let finished = false;
      let outputBytes = 0;
      let firstByteReceived = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const firstByteTimer = setTimeout(() => {
        abortKind = "timeout";
        requestController.abort();
      }, FIRST_BYTE_TIMEOUT_MS);
      const totalTimer = setTimeout(() => {
        abortKind = "timeout";
        requestController.abort();
      }, TOTAL_TIMEOUT_MS);
      const keepalive = setInterval(() => {
        if (!finished) controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
      }, KEEPALIVE_INTERVAL_MS);

      const clearTimers = () => {
        clearTimeout(firstByteTimer);
        clearTimeout(totalTimer);
        clearTimeout(idleTimer);
        clearInterval(keepalive);
        request.signal.removeEventListener("abort", abortFromClient);
      };
      const markActivity = () => {
        if (!firstByteReceived) {
          firstByteReceived = true;
          clearTimeout(firstByteTimer);
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          abortKind = "timeout";
          requestController.abort();
        }, IDLE_TIMEOUT_MS);
      };
      const finishCompleted = () => {
        if (finished) return;
        finished = true;
        controller.enqueue(encodeEvent("terminal", { outcome: "completed" }));
        clearTimers();
        controller.close();
      };
      const finishFailed = (code: StreamErrorCode, retryable = true) => {
        if (finished) return;
        finished = true;
        controller.enqueue(encodeEvent("error", { code, retryable }));
        controller.enqueue(encodeEvent("terminal", { outcome: "failed" }));
        clearTimers();
        controller.close();
      };

      controller.enqueue(encodeEvent("start", { requestId: crypto.randomUUID() }));
      controller.enqueue(encodeEvent("progress", { phase: "connecting" }));

      try {
        const credentials = openaiCredentials(request);
        const transport = createOpenAIOAuthTransport({
          auth: () => credentials.getSession(),
          baseURL: credentials.baseURL,
          fetch: credentials.fetch,
          headers: credentials.headers,
          instructions: SYSTEM_INSTRUCTIONS,
          responsesState: false,
        });
        const response = await transport.request("/responses", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            input: prompt,
            instructions: SYSTEM_INSTRUCTIONS,
            model: "gpt-5.4-mini",
            reasoning: { effort: "low" },
            stream: true,
            text: { verbosity: "low" },
          }),
          signal: requestController.signal,
        });

        if (!response.ok || !response.body) {
          const hostingChallenge =
            response.status === 403 &&
            response.headers.get("cf-mitigated") === "challenge";
          console.error("Relmio upstream chat request failed.", {
            category: hostingChallenge
              ? "hosting-network-blocked"
              : `upstream-status-${response.status}`,
          });
          finishFailed(
            hostingChallenge ? "hosting_network_blocked" : "upstream_failed",
          );
          return;
        }

        controller.enqueue(encodeEvent("progress", { phase: "working" }));
        for await (const event of iterateEvents(response.body)) {
          markActivity();
          if (!event.data) continue;
          if (event.data === "[DONE]") break;

          let payload: unknown;
          try {
            payload = JSON.parse(event.data);
          } catch {
            finishFailed("upstream_failed");
            return;
          }
          if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            finishFailed("upstream_failed");
            return;
          }
          const type = Reflect.get(payload, "type");
          if (
            type === "response.output_text.delta" &&
            typeof Reflect.get(payload, "delta") === "string"
          ) {
            const text = Reflect.get(payload, "delta") as string;
            const bytes = new TextEncoder().encode(text).byteLength;
            if (outputBytes + bytes > MAX_OUTPUT_BYTES) {
              finishFailed("output_limit", false);
              requestController.abort();
              return;
            }
            outputBytes += bytes;
            controller.enqueue(encodeEvent("delta", { text }));
            continue;
          }
          if (type === "response.completed") {
            if (outputBytes === 0) finishFailed("upstream_failed");
            else finishCompleted();
            return;
          }
          if (
            (typeof type === "string" && TERMINAL_TYPES.has(type)) ||
            (event.event && TERMINAL_TYPES.has(event.event))
          ) {
            finishFailed("upstream_failed");
            return;
          }
        }
        finishFailed("upstream_failed");
      } catch (error) {
        if (abortKind === "client") {
          finished = true;
          clearTimers();
          controller.close();
          return;
        }
        if (abortKind === "timeout") {
          finishFailed("timeout");
          return;
        }
        console.error("Relmio upstream chat request failed.", {
          category: safeErrorCategory(error),
        });
        finishFailed(
          error instanceof Error &&
            error.message.includes("must include `Authorization`")
            ? "auth_unavailable"
            : "upstream_failed",
        );
      }
    },
    cancel() {
      abortKind = "client";
      requestController.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-store",
      "Content-Encoding": "none",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
      "X-Relmio-Stream": "v1",
    },
  });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON request body." }, { status: 400 });
  }
  const promptValue =
    body && typeof body === "object" && "prompt" in body ? body.prompt : null;
  if (typeof promptValue !== "string") {
    return Response.json({ error: "The prompt must be a string." }, { status: 400 });
  }
  const prompt = promptValue.trim();
  if (!prompt) {
    return Response.json({ error: "Enter a message first." }, { status: 400 });
  }
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return Response.json(
      { error: `Messages must be ${MAX_PROMPT_LENGTH} characters or fewer.` },
      { status: 413 },
    );
  }
  return streamResponse(request, prompt);
}
