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
import {
  ArrowDown,
  LoaderCircle,
  LockKeyhole,
  SendHorizontal,
  Square,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import styles from "./ChatConsole.module.css";
import { readRelmioEvents } from "./relmio-stream.js";

const suggestions = [
  "What is a robot?",
  "What is love?",
  "Explain what Relmio does in two sentences.",
] as const;
const streamErrors: Record<string, string> = {
  auth_unavailable: "Connect ChatGPT before sending a message.",
  hosting_network_blocked:
    "ChatGPT blocked this hosting network. Try Relmio from a supported Node.js host.",
  output_limit: "The response exceeded Relmio's safe display limit.",
  timeout: "The response took too long. Try again.",
  upstream_failed: "The response failed upstream. Reconnect ChatGPT and try again.",
};
const MAX_VISIBLE_TURNS = 12;
const STICK_TO_BOTTOM_DISTANCE = 72;
const COMPOSER_MIN_HEIGHT = 64;
const COMPOSER_MAX_HEIGHT = 192;

type AssistantTurnStatus =
  | "streaming"
  | "complete"
  | "incomplete"
  | "stopped"
  | "failed";

type ChatTurn = {
  content: string;
  id: string;
  requestId: string;
  role: "user" | "assistant";
  status: "complete" | AssistantTurnStatus;
};

type ActiveRequest = {
  controller: AbortController;
  requestId: string;
};

function assistantFallback(status: AssistantTurnStatus) {
  if (status === "stopped") return "Stopped before output was returned.";
  if (status === "failed") return "No response was returned.";
  return "";
}

export function ChatConsole() {
  const [authStatus, setAuthStatus] =
    useState<SignInWithChatGPTState["status"]>("checking");
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [localError, setLocalError] = useState("");
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [streamPhase, setStreamPhase] = useState("Ready");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const composingRef = useRef(false);
  const inFlightRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLElement>(null);

  const latestTurn = turns.at(-1);
  const latestTurnSignature = latestTurn
    ? `${latestTurn.id}:${latestTurn.content.length}:${latestTurn.status}`
    : "empty";

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "auto";
    const nextHeight = Math.min(
      Math.max(textarea.scrollHeight, COMPOSER_MIN_HEIGHT),
      COMPOSER_MAX_HEIGHT,
    );
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY =
      textarea.scrollHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden";
  }, [input]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;

    const frame = window.requestAnimationFrame(() => {
      if (turns.length === 0) {
        transcript.scrollTop = 0;
        isNearBottomRef.current = true;
        setShowJumpToLatest(false);
        return;
      }

      if (!isNearBottomRef.current) {
        setShowJumpToLatest(true);
        return;
      }
      transcript.scrollTop = transcript.scrollHeight;
      setShowJumpToLatest(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [latestTurnSignature, turns.length]);

  useEffect(() => {
    return () => {
      activeRequestRef.current?.controller.abort();
    };
  }, []);

  function isCurrentRequest(requestId: string) {
    return activeRequestRef.current?.requestId === requestId;
  }

  function updateAssistantTurn(
    requestId: string,
    update: (turn: ChatTurn) => ChatTurn,
  ) {
    setTurns((current) =>
      current.map((turn) =>
        turn.role === "assistant" && turn.requestId === requestId
          ? update(turn)
          : turn,
      ),
    );
  }

  function setAssistantStatus(
    requestId: string,
    status: AssistantTurnStatus,
  ) {
    updateAssistantTurn(requestId, (turn) => ({ ...turn, status }));
  }

  async function ask(prompt: string) {
    const message = prompt.trim();
    if (!message || inFlightRef.current) return;

    inFlightRef.current = true;
    const requestId = `request-${++requestSequenceRef.current}`;
    const controller = new AbortController();
    activeRequestRef.current = { controller, requestId };
    isNearBottomRef.current = true;
    setShowJumpToLatest(false);
    setInput("");
    setIsLoading(true);
    setLocalError("");
    setStreamPhase("Connecting");
    setTurns((current) =>
      [
        ...current,
        {
          content: message,
          id: `${requestId}-user`,
          requestId,
          role: "user" as const,
          status: "complete" as const,
        },
        {
          content: "",
          id: `${requestId}-assistant`,
          requestId,
          role: "assistant" as const,
          status: "streaming" as const,
        },
      ].slice(-MAX_VISIBLE_TURNS),
    );

    let receivedText = false;
    let pendingError = "";
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
      if (!isCurrentRequest(requestId)) return;
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
        if (!isCurrentRequest(requestId)) return;

        if (item.event === "progress") {
          setStreamPhase(
            item.data.phase === "working" ? "Thinking" : "Connecting",
          );
        } else if (item.event === "delta") {
          if (typeof item.data.text !== "string") {
            throw new Error("Relmio returned an invalid response chunk.");
          }
          receivedText = true;
          setStreamPhase("Streaming");
          updateAssistantTurn(requestId, (turn) => ({
            ...turn,
            content: turn.content + item.data.text,
          }));
        } else if (item.event === "error") {
          const code =
            typeof item.data.code === "string"
              ? item.data.code
              : "upstream_failed";
          pendingError = streamErrors[code] ?? streamErrors.upstream_failed;
        } else if (item.event === "terminal") {
          terminal = true;
          if (item.data.outcome !== "completed") {
            setLocalError(pendingError || streamErrors.upstream_failed);
            setStreamPhase("Failed");
            setAssistantStatus(
              requestId,
              receivedText ? "incomplete" : "failed",
            );
          } else if (!receivedText) {
            throw new Error("Relmio completed without a visible response.");
          } else {
            completed = true;
          }
        }
      }
      if (!terminal) throw new Error("The response ended before completion.");
      if (completed && isCurrentRequest(requestId)) {
        setAssistantStatus(requestId, "complete");
        setStreamPhase("Ready");
      }
    } catch (error) {
      if (!isCurrentRequest(requestId)) return;

      if (controller.signal.aborted) {
        setLocalError("");
        setStreamPhase("Stopped");
        setAssistantStatus(requestId, "stopped");
      } else {
        setLocalError(
          error instanceof Error
            ? error.message
            : "Connect ChatGPT before sending a message.",
        );
        setStreamPhase("Failed");
        setAssistantStatus(
          requestId,
          receivedText ? "incomplete" : "failed",
        );
      }
    } finally {
      if (isCurrentRequest(requestId)) {
        activeRequestRef.current = null;
        inFlightRef.current = false;
        setIsLoading(false);
      }
    }
  }

  function stop() {
    const activeRequest = activeRequestRef.current;
    if (!activeRequest) return;

    setStreamPhase("Stopping");
    activeRequest.controller.abort();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (
      composingRef.current ||
      event.nativeEvent.isComposing ||
      event.keyCode === 229
    ) {
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void ask(input);
    }
  }

  function updateStickiness() {
    const transcript = transcriptRef.current;
    if (!transcript) return;

    const distanceFromBottom =
      transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
    const isNearBottom = distanceFromBottom <= STICK_TO_BOTTOM_DISTANCE;
    isNearBottomRef.current = isNearBottom;
    setShowJumpToLatest(!isNearBottom);
  }

  function jumpToLatest() {
    const transcript = transcriptRef.current;
    if (!transcript) return;

    isNearBottomRef.current = true;
    transcript.scrollTop = transcript.scrollHeight;
    setShowJumpToLatest(false);
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
    <section className={styles.shell} aria-label="Hosted chat console">
      <header className={styles.header}>
        <HStack justify="between" align="center" gap={3} wrap="wrap">
          <HStack gap={2} align="center">
            <Text as="p" className={styles.kicker} type="code" color="accent">
              Hosted test lane
            </Text>
            <Text as="p" className={styles.model} type="code">
              gpt-5.4-mini
            </Text>
          </HStack>
          <HStack className="console-statuses" gap={2} wrap="wrap">
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
            <Text className={styles.authStatus} type="supporting">
              {statusLabel}
            </Text>
          </HStack>
        </HStack>
      </header>

      <section className={styles.sessionBoundary} aria-label="Session boundary">
        <HStack gap={3} align="center" wrap="wrap">
          <LockKeyhole className={styles.boundaryIcon} aria-hidden="true" />
          <SignInWithChatGPT
            className={styles.connectButton}
            loadingLabel="Checking ChatGPT…"
            redirectingLabel="Opening ChatGPT…"
            signedInLabel="Disconnect ChatGPT"
            showLogo
            onStateChange={(state) => {
              setAuthStatus(state.status);
              if (state.status === "error") {
                setLocalError(state.error.message);
              } else if (state.status === "signed-in") {
                setLocalError("");
              }
            }}
          />
          <Text as="p" className={styles.boundaryCopy} type="supporting">
            Encrypted in this browser. No tools, files, commands, or external
            browsing. The demo keeps only the latest six exchanges in this tab.
          </Text>
        </HStack>
      </section>

      <section className={styles.transcriptRegion}>
        <section
          className={styles.transcript}
          ref={transcriptRef}
          role="log"
          aria-label="Chat transcript"
          aria-relevant="additions"
          aria-busy={isLoading}
          tabIndex={0}
          onScroll={updateStickiness}
        >
          {turns.length === 0 ? (
            <section className={styles.emptyState} aria-label="Start a conversation">
              <LockKeyhole className={styles.emptyIcon} aria-hidden="true" />
              <Text as="p" type="label" weight="bold">
                Your private test lane is ready.
              </Text>
              <Text as="p" className={styles.emptyCopy} type="supporting">
                Connect ChatGPT, choose a starter, or ask your own question.
              </Text>
              <section className={styles.suggestions} aria-label="Suggested prompts">
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
            </section>
          ) : (
            <section className={styles.turnList}>
              {turns.map((turn) => {
                if (turn.role === "user") {
                  const lastPrompt = turn.content;
                  return (
                    <article
                      className={`${styles.message} ${styles.userMessage}`}
                      key={turn.id}
                    >
                      <Text as="span" type="code" color="secondary">You</Text>
                      <Text as="p" type="body">{lastPrompt}</Text>
                    </article>
                  );
                }

                const isIncomplete =
                  turn.status === "incomplete" ||
                  turn.status === "stopped" ||
                  turn.status === "failed";
                const completion = turn.content;
                const fallback = assistantFallback(turn.status);

                return (
                  <article
                    className={`${styles.message} ${styles.assistantMessage}${
                      isIncomplete
                        ? ` ${styles.messageIncomplete}`
                        : ""
                    }`}
                    key={turn.id}
                    data-status={turn.status}
                  >
                    <HStack className={styles.messageMeta} gap={2} align="center">
                      <Text as="span" type="code" color="accent">{isIncomplete ? "Relmio · incomplete" : "Relmio"}</Text>
                      {turn.status !== "complete" && turn.status !== "streaming" ? (
                        <Text as="span" type="supporting">
                          {turn.status}
                        </Text>
                      ) : null}
                    </HStack>
                    <Text as="p" type="body">
                      {completion || fallback || (
                        <LoaderCircle
                          className={styles.typingIndicator}
                          aria-hidden="true"
                        />
                      )}
                    </Text>
                  </article>
                );
              })}
            </section>
          )}
        </section>

        {showJumpToLatest ? (
          <button
            className={styles.jumpToLatest}
            type="button"
            onClick={jumpToLatest}
          >
            <ArrowDown aria-hidden="true" />
            Jump to latest
          </button>
        ) : null}
      </section>

      <footer className={styles.composerDock}>
        {localError ? (
          <Text
            as="p"
            className={styles.error}
            type="supporting"
            role="alert"
          >
            {localError}
          </Text>
        ) : null}

        <form className={styles.composer} onSubmit={handleSubmit}>
          <HStack className={styles.composerMeta} justify="between" gap={2} wrap="wrap">
            <label htmlFor="chat-prompt">Message Relmio</label>
            <Text id="chat-input-hint" type="supporting">
              Enter to send · Shift+Enter for a new line · {input.length}/3000
            </Text>
          </HStack>
          <section className={styles.composerRow}>
            <textarea
              id="chat-prompt"
              name="prompt"
              ref={textareaRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onKeyDown={handleKeyDown}
              placeholder="Ask about a workflow or Relmio boundary…"
              aria-describedby="chat-input-hint"
              maxLength={3000}
              rows={1}
            />
            {isLoading ? (
              <button
                className={`${styles.submitButton} ${styles.stopButton}`}
                type="button"
                onClick={stop}
                aria-label="Stop response"
              >
                <Square aria-hidden="true" />
              </button>
            ) : (
              <button
                className={styles.submitButton}
                type="submit"
                disabled={!input.trim()}
                aria-label="Send message"
              >
                <SendHorizontal aria-hidden="true" />
              </button>
            )}
          </section>
        </form>
      </footer>

      <Text
        as="p"
        className={styles.srOnly}
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        Response state: {streamPhase}.
      </Text>
    </section>
  );
}
