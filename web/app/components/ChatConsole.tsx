"use client";

import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { TextArea } from "@astryxdesign/core/TextArea";
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
  const conversationRef = useRef<HTMLElement>(null);
  const { completion, complete, input, isLoading, setInput, stop } =
    useCompletion({
      api: "/api/chat",
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
  const statusVariant: "success" | "warning" | "neutral" =
    authStatus === "signed-in"
      ? "success"
      : authStatus === "checking"
        ? "warning"
        : "neutral";

  return (
    <section className="chat-console" aria-labelledby="chat-console-title">
      <header className="chat-console-header">
        <Heading level={3} id="chat-console-title">
          Hosted Relmio chat
        </Heading>
        <span className="auth-state" aria-live="polite">
          <StatusDot variant={statusVariant} label={statusLabel} />
          {statusLabel}
        </span>
      </header>

      <section className="auth-row" aria-label="ChatGPT connection">
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
        <p>Stored by the browser integration and sent with requests you make here.</p>
      </section>

      <section
        className="conversation"
        ref={conversationRef}
        aria-live="polite"
        aria-busy={isLoading}
        aria-label="Chat conversation"
      >
        {!lastPrompt && !completion ? (
          <article className="conversation-empty">
            <Icon icon="arrowUp" color="accent" size="lg" />
            <strong>Your request lane is ready.</strong>
            <p>Connect ChatGPT, choose a starter, or ask your own question.</p>
          </article>
        ) : (
          <>
            {lastPrompt ? (
              <article className="message message-user">
                <strong>You</strong>
                <p>{lastPrompt}</p>
              </article>
            ) : null}
            {completion || isLoading ? (
              <article className="message message-assistant">
                <strong>Relmio</strong>
                <p>
                  {completion || (
                    <span
                      className="typing-dots"
                      role="status"
                      aria-label="Relmio is composing a response"
                    >
                      <i />
                      <i />
                      <i />
                    </span>
                  )}
                </p>
              </article>
            ) : null}
          </>
        )}
      </section>

      {localError ? (
        <p className="chat-error" role="alert">
          {localError}
        </p>
      ) : null}

      <nav className="suggestion-row" aria-label="Suggested prompts">
        {suggestions.map((suggestion) => (
          <Button
            key={suggestion}
            label={suggestion}
            variant="secondary"
            size="sm"
            onClick={() => void ask(suggestion)}
            isDisabled={isLoading}
          />
        ))}
      </nav>

      <form className="chat-form" onSubmit={handleSubmit}>
        <TextArea
          className="chat-prompt"
          label="Ask anything"
          description="Enter sends. Shift+Enter adds a new line."
          htmlName="prompt"
          value={input}
          onChange={(value) => setInput(value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask Relmio to help with a workflow…"
          maxLength={3000}
          rows={3}
          width="100%"
          isDisabled={isLoading}
        />
        {isLoading ? (
          <Button
            className="chat-submit"
            label="Stop response"
            type="button"
            variant="secondary"
            icon={<Icon icon="stop" color="inherit" />}
            onClick={stop}
          />
        ) : (
          <Button
            className="chat-submit"
            label="Send message"
            type="submit"
            variant="primary"
            icon={<Icon icon="arrowUp" color="inherit" />}
            isDisabled={!input.trim()}
          />
        )}
      </form>
    </section>
  );
}
