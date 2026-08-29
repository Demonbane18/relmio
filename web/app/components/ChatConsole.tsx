"use client";

import {
  openaiAuthHeaders,
  SignInWithChatGPT,
  type SignInWithChatGPTState,
} from "@openai-oauth/react";
import { HStack } from "@astryxdesign/core/HStack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { LoaderCircle, SendHorizontal, Square } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { readRelmioEvents } from "./relmio-stream.js";

const suggestions = [
  "What is a robot?",
  "What is love?",
  "Explain what Relmio does in two sentences.",
];
const streamErrors: Record<string, string> = {
  auth_unavailable: "Connect ChatGPT before sending a message.",
  hosting_network_blocked:
    "ChatGPT blocked this hosting network. Try Relmio from a supported Node.js host.",
  output_limit: "The response exceeded Relmio's safe display limit.",
  timeout: "The response took too long. Try again.",
  upstream_failed: "The response failed upstream. Reconnect ChatGPT and try again.",
};

export function ChatConsole() {
  const [authStatus, setAuthStatus] =
    useState<SignInWithChatGPTState["status"]>("checking");
  const [completion, setCompletion] = useState("");
  const [isIncomplete, setIsIncomplete] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [lastPrompt, setLastPrompt] = useState("");
  const [localError, setLocalError] = useState("");
  const [streamPhase, setStreamPhase] = useState("Ready");
  const abortRef = useRef<AbortController | null>(null);
  const conversationRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

    const controller = new AbortController();
    abortRef.current = controller;
    setCompletion("");
    setIsIncomplete(false);
    setInput("");
    setIsLoading(true);
    setLastPrompt(message);
    setLocalError("");
    setStreamPhase("Connecting");

    let receivedText = false;
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          ...(await openaiAuthHeaders()),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ prompt: message }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error("The request was rejected before streaming began.");
      }
      if (
        response.headers.get("content-type") !== "text/event-stream" ||
        response.headers.get("x-relmio-stream") !== "v1" ||
        !response.body
      ) {
        throw new Error("Relmio returned an unexpected response.");
      }

      let terminal = false;
      let completed = false;
      for await (const item of readRelmioEvents(response.body)) {
        if (item.event === "progress") {
          setStreamPhase(item.data.phase === "working" ? "Thinking" : "Connecting");
        } else if (item.event === "delta") {
          if (typeof item.data.text !== "string") {
            throw new Error("Relmio returned an invalid response chunk.");
          }
          receivedText = true;
          setStreamPhase("Streaming");
          setCompletion((current) => current + item.data.text);
        } else if (item.event === "error") {
          const code = typeof item.data.code === "string" ? item.data.code : "upstream_failed";
          setLocalError(streamErrors[code] ?? streamErrors.upstream_failed);
        } else if (item.event === "terminal") {
          terminal = true;
          if (item.data.outcome !== "completed") {
            setLocalError((current) => current || streamErrors.upstream_failed);
            setStreamPhase("Failed");
            setIsIncomplete(receivedText);
          } else if (!receivedText) {
            throw new Error("Relmio completed without a visible response.");
          } else {
            completed = true;
          }
        }
      }
      if (!terminal) throw new Error("The response ended before completion.");
      if (completed) setStreamPhase("Ready");
    } catch (error) {
      if (controller.signal.aborted) {
        setStreamPhase("Stopped");
        setIsIncomplete(receivedText);
      } else {
        setLocalError(
          error instanceof Error
            ? error.message
            : "Connect ChatGPT before sending a message.",
        );
        setStreamPhase("Failed");
        setIsIncomplete(receivedText);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setIsLoading(false);
    }
  }

  function stop() {
    abortRef.current?.abort();
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
  const phaseVariant =
    streamPhase === "Failed"
      ? "error"
      : streamPhase === "Stopped"
        ? "warning"
        : streamPhase === "Ready"
          ? "success"
          : "accent";
  const phaseColor =
    phaseVariant === "error"
      ? "red"
      : phaseVariant === "warning"
        ? "orange"
        : phaseVariant === "success"
          ? "green"
          : "teal";

  return (
    <section className="chat-console" aria-label="Hosted chat console">
      <header className="chat-console-header">
        <HStack justify="between" align="center" gap={3} wrap="wrap">
          <VStack gap={0.5}>
            <Text as="p" className="console-kicker" type="code" color="accent">Relmio chat</Text>
            <Text as="p" type="label" weight="bold">gpt-5.4-mini</Text>
          </VStack>
          <HStack className="console-statuses" aria-live="polite" gap={2} wrap="wrap">
            <Token
              label={streamPhase}
              size="sm"
              color={phaseColor}
              endContent={
                <StatusDot
                  variant={phaseVariant}
                  label={`Response state: ${streamPhase}`}
                  isPulsing={isLoading}
                />
              }
            />
            <Text className={`auth-pill auth-${authStatus}`} type="supporting" aria-live="polite">
              {statusLabel}
            </Text>
          </HStack>
        </HStack>
      </header>

      <HStack className="auth-row" gap={3} align="center" wrap="wrap">
        <SignInWithChatGPT
          className="chatgpt-connect"
          loadingLabel="Checking ChatGPT…"
          redirectingLabel="Opening ChatGPT…"
          signedInLabel="Disconnect ChatGPT"
          showLogo
          onStateChange={(state) => {
            setAuthStatus(state.status);
            if (state.status === "error") setLocalError(state.error.message);
          }}
        />
        <Text as="p" type="supporting">Encrypted locally. Sent only with requests you make here.</Text>
      </HStack>

      <section
        className="conversation"
        ref={conversationRef}
        aria-live="polite"
        aria-busy={isLoading}
      >
        {!lastPrompt && !completion ? (
          <VStack className="conversation-empty" gap={2}>
            <Text as="p" type="label" weight="bold">Your private test lane is ready.</Text>
            <Text as="p" type="supporting">Connect ChatGPT, choose a starter, or ask your own question.</Text>
          </VStack>
        ) : (
          <VStack gap={3}>
            {lastPrompt ? (
              <article className="message message-user">
                <Text as="span" type="code" color="secondary">You</Text>
                <Text as="p" type="body">{lastPrompt}</Text>
              </article>
            ) : null}
            {completion || isLoading ? (
              <article className={`message message-assistant${isIncomplete ? " message-incomplete" : ""}`}>
                <Text as="span" type="code" color="accent">{isIncomplete ? "Relmio · incomplete" : "Relmio"}</Text>
                <Text as="p" type="body">
                  {completion || (
                    <LoaderCircle
                      className="typing-indicator"
                      role="status"
                      aria-label={`Relmio is ${streamPhase.toLowerCase()}`}
                    />
                  )}
                </Text>
              </article>
            ) : null}
          </VStack>
        )}
      </section>

      {localError ? <Text as="p" className="chat-error" type="supporting" role="alert">{localError}</Text> : null}

      <section className="suggestion-row" aria-label="Suggested prompts">
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
      </section>

      <form className="chat-form" onSubmit={handleSubmit}>
        <VStack gap={2}>
          <HStack className="form-label-row" justify="between" gap={2} wrap="wrap">
            <label htmlFor="chat-prompt">Ask anything</label>
            <Text className="input-hint" type="supporting" aria-hidden="true">
              Enter to send. Shift+Enter for a new line.
            </Text>
          </HStack>
          <HStack className="chat-compose-row" gap={2} align="end">
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
              <button className="send-button stop-button" type="button" onClick={stop} aria-label="Stop response">
                <Square aria-hidden="true" />
              </button>
            ) : (
              <button className="send-button" type="submit" disabled={!input.trim()} aria-label="Send message">
                <SendHorizontal aria-hidden="true" />
              </button>
            )}
          </HStack>
        </VStack>
      </form>
    </section>
  );
}
