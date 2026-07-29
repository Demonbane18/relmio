"use client";

import {
  openaiAuthHeaders,
  SignInWithChatGPT,
  type SignInWithChatGPTState,
} from "@openai-oauth/react";
import { useCompletion } from "@ai-sdk/react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

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
  const conversationRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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

  useEffect(() => {
    const conversation = conversationRef.current;
    if (conversation) {
      conversation.scrollTo({
        top: conversation.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [completion, lastPrompt, isLoading]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
    }
  }, [input]);

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

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void ask(input);
    }
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

      <div
        className="conversation"
        ref={conversationRef}
        aria-live="polite"
        aria-busy={isLoading}
      >
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
                  (isLoading ? (
                    <span
                      className="typing-dots"
                      role="status"
                      aria-label="Relmio is composing a response"
                    >
                      <i />
                      <i />
                      <i />
                    </span>
                  ) : (
                    ""
                  ))}
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
        <div className="form-label-row">
          <label htmlFor="chat-prompt">Ask anything</label>
          <span className="input-hint" aria-hidden="true">
            Enter to send · Shift+Enter for a new line
          </span>
        </div>
        <div>
          <textarea
            id="chat-prompt"
            name="prompt"
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask Relmio to help with a workflow…"
            maxLength={3000}
            rows={1}
          />
          {isLoading ? (
            <button
              className="send-button stop-button"
              type="button"
              onClick={stop}
              aria-label="Stop response"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              className="send-button"
              type="submit"
              disabled={!input.trim()}
              aria-label="Send message"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
                <path
                  d="M8 12.75v-9.5M3.75 7.5 8 3.25 12.25 7.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
