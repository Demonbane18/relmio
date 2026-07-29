"use client";

import {
  openaiAuthHeaders,
  SignInWithChatGPT,
  type SignInWithChatGPTState,
} from "@openai-oauth/react";
import { useCompletion } from "@ai-sdk/react";
import { useState, type FormEvent } from "react";

const suggestions = [
  "Explain what Relmio does in two sentences.",
  "Draft a simple n8n AI Agent prompt.",
  "What should I protect like a password?",
];

export function ChatConsole() {
  const [authStatus, setAuthStatus] =
    useState<SignInWithChatGPTState["status"]>("checking");
  const [lastPrompt, setLastPrompt] = useState("");
  const [localError, setLocalError] = useState("");
  const {
    completion,
    complete,
    input,
    isLoading,
    setInput,
    stop,
  } = useCompletion({
    api: "/api/chat",
    streamProtocol: "text",
    onError(error) {
      setLocalError(
        error.message || "The request could not be completed. Try again.",
      );
    },
  });

  async function ask(prompt: string) {
    const message = prompt.trim();
    if (!message || isLoading) return;

    setLocalError("");
    setLastPrompt(message);
    setInput("");

    try {
      await complete(message, {
        headers: await openaiAuthHeaders(),
      });
    } catch (error) {
      setLocalError(
        error instanceof Error
          ? error.message
          : "Connect ChatGPT before sending a message.",
      );
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(input);
  }

  const statusLabel =
    authStatus === "signed-in"
      ? "Connected"
      : authStatus === "checking"
        ? "Checking session"
        : "Not connected";

  return (
    <div className="chat-console">
      <div className="chat-console-header">
        <div>
          <span className="console-kicker">Relmio chat</span>
          <strong>gpt-5.4-mini</strong>
        </div>
        <span
          className={`auth-pill auth-${authStatus}`}
          aria-live="polite"
        >
          <i aria-hidden="true" />
          {statusLabel}
        </span>
      </div>

      <div className="auth-row">
        <SignInWithChatGPT
          className="chatgpt-connect"
          loadingLabel="Checking ChatGPT…"
          redirectingLabel="Opening ChatGPT…"
          signedInLabel="Disconnect ChatGPT"
          showLogo
          onStateChange={(state) => {
            setAuthStatus(state.status);
            if (state.status === "error") {
              setLocalError(state.error.message);
            }
          }}
        />
        <p>Encrypted locally. Sent only with requests you make here.</p>
      </div>

      <div className="conversation" aria-live="polite" aria-busy={isLoading}>
        {!lastPrompt && !completion ? (
          <div className="conversation-empty">
            <span aria-hidden="true">⌁</span>
            <strong>Your private test lane is ready.</strong>
            <p>Connect ChatGPT, choose a starter, or ask your own question.</p>
          </div>
        ) : (
          <>
            {lastPrompt ? (
              <div className="message message-user">
                <span>You</span>
                <p>{lastPrompt}</p>
              </div>
            ) : null}
            <div className="message message-assistant">
              <span>Relmio</span>
              <p>
                {completion ||
                  (isLoading ? "Opening a secure response stream…" : "")}
              </p>
            </div>
          </>
        )}
      </div>

      {localError ? (
        <p className="chat-error" role="alert">
          {localError}
        </p>
      ) : null}

      <div className="suggestion-row" aria-label="Suggested prompts">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion}
            type="button"
            onClick={() => void ask(suggestion)}
            disabled={isLoading}
          >
            {suggestion}
          </button>
        ))}
      </div>

      <form className="chat-form" onSubmit={handleSubmit}>
        <label htmlFor="chat-prompt">Ask anything</label>
        <div>
          <textarea
            id="chat-prompt"
            name="prompt"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Ask Relmio to help with a workflow…"
            maxLength={3000}
            rows={2}
          />
          {isLoading ? (
            <button
              className="send-button stop-button"
              type="button"
              onClick={stop}
              aria-label="Stop response"
            >
              ■
            </button>
          ) : (
            <button
              className="send-button"
              type="submit"
              disabled={!input.trim()}
              aria-label="Send message"
            >
              ↑
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
