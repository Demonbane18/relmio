import { createOpenAIOAuth } from "@openai-oauth/ai-sdk";
import { openaiCredentials } from "@openai-oauth/react/server";
import { streamText } from "ai";

const MAX_PROMPT_LENGTH = 3000;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON request body." }, { status: 400 });
  }

  const prompt =
    body && typeof body === "object" && "prompt" in body
      ? String(body.prompt).trim()
      : "";

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

    return result.toTextStreamResponse({
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
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
