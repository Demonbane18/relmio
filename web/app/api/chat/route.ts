import { createOpenAIOAuth } from "@openai-oauth/ai-sdk";
import { openaiCredentials } from "@openai-oauth/react/server";
import { streamText } from "ai";

export const runtime = "nodejs";

const MAX_PROMPT_LENGTH = 3000;
const STREAM_ERROR_MESSAGE =
  "The response stream failed. Reconnect ChatGPT and try again.";
const HOSTING_NETWORK_BLOCKED_MESSAGE =
  "ChatGPT blocked requests from this hosting network. Relmio's chat backend must run outside Cloudflare Workers.";

function errorStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== "object" || !("statusCode" in error)) {
    return undefined;
  }

  return typeof error.statusCode === "number" ? error.statusCode : undefined;
}

function errorResponseHeader(
  error: unknown,
  headerName: string,
): string | undefined {
  if (!error || typeof error !== "object" || !("responseHeaders" in error)) {
    return undefined;
  }

  const headers = error.responseHeaders;
  if (headers instanceof Headers) {
    return headers.get(headerName) ?? undefined;
  }

  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  const value = Reflect.get(headers, headerName.toLowerCase());
  return typeof value === "string" ? value : undefined;
}

function streamErrorMessage(error: unknown): string {
  const statusCode = errorStatusCode(error);
  const mitigation = errorResponseHeader(error, "cf-mitigated");
  const isHostingChallenge = statusCode === 403 && mitigation === "challenge";

  console.error("Relmio upstream chat request failed.", {
    category: isHostingChallenge ? "hosting-network-blocked" : "upstream-error",
    statusCode: statusCode ?? "unknown",
  });

  return isHostingChallenge
    ? HOSTING_NETWORK_BLOCKED_MESSAGE
    : STREAM_ERROR_MESSAGE;
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
    return Response.json(
      { error: "The prompt must be a string." },
      { status: 400 },
    );
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

  try {
    const openai = createOpenAIOAuth(openaiCredentials(request));
    const result = streamText({
      model: openai("gpt-5.4-mini"),
      system:
        "You are Relmio's concise demo assistant. Help with AI workflows, n8n, OpenAI-compatible clients, and clear technical explanations. Never claim Relmio creates an OpenAI Platform API key or bypasses provider limits. If asked about credentials, remind the user to protect OAuth sessions like passwords.",
      prompt,
      maxOutputTokens: 600,
    });

    return result.toUIMessageStreamResponse({
      headers: {
        "Cache-Control": "no-store",
        "Content-Encoding": "none",
        "X-Content-Type-Options": "nosniff",
      },
      onError: streamErrorMessage,
    });
  } catch {
    return Response.json(
      {
        error:
          "ChatGPT is not connected or the session is unavailable. Reconnect and try again.",
      },
      { status: 401 },
    );
  }
}
