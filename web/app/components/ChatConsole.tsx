"use client";

import {
  openaiAuthHeaders,
  SignInWithChatGPT,
  type SignInWithChatGPTState,
} from "@openai-oauth/react";
import Link from "next/link";
import { SendHorizontal, Square } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import styles from "./ChatConsole.module.css";
import { Callout } from "./ui/Callout";
import { Icon } from "./ui/Icon";
import {
  INITIAL_STREAM_FEEDBACK,
  nextStreamFeedback,
  readRelmioEvents,
} from "./relmio-stream.js";

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
  upstream_failed: "The response failed upstream. Check account access and try again later.",
};
const MAX_VISIBLE_TURNS = 12;
const STICK_TO_BOTTOM_DISTANCE = 72;
const COMPOSER_MIN_HEIGHT = 64;
const COMPOSER_MAX_HEIGHT = 192;
// The sign-in button ships inline styles. Clearing them lets the kit button
// classes style it like every other Relmio button.
const kitButtonStyle: CSSProperties = {
  alignItems: undefined,
  background: undefined,
  border: undefined,
  borderRadius: undefined,
  color: undefined,
  cursor: undefined,
  display: undefined,
  fontFamily: undefined,
  fontSize: undefined,
  fontWeight: undefined,
  gap: undefined,
  justifyContent: undefined,
  lineHeight: undefined,
  minHeight: undefined,
  minWidth: undefined,
  padding: undefined,
  whiteSpace: undefined,
};

type AssistantTurnStatus =
  | "waiting"
  | "streaming"
  | "complete"
  | "incomplete"
  | "stopped"
  | "failed";

type StreamPhase =
  | "Ready"
  | "Sending"
  | "Connecting"
  | "Waiting"
  | "Streaming"
  | "Complete"
  | "Stopping"
  | "Stopped"
  | "Failed";

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

type ChatRequest = (prompt: string, signal: AbortSignal) => Promise<Response>;

type ChatConsoleProps = {
  requestChat?: ChatRequest;
};

function assistantFallback(status: AssistantTurnStatus) {
  if (status === "stopped") return "Stopped before output was returned.";
  if (status === "failed") return "No response was returned.";
  return "";
}

function responsePhaseAnnouncement(phase: StreamPhase) {
  if (phase === "Sending") return "Sending message to Relmio.";
  if (phase === "Connecting") return "Connecting to Relmio.";
  if (phase === "Waiting") return "Relmio is waiting for the first words.";
  if (phase === "Streaming") return "Relmio is responding.";
  if (phase === "Complete") return "Response complete.";
  if (phase === "Stopping") return "Stopping the response.";
  if (phase === "Stopped") return "Response stopped.";
  if (phase === "Failed") return "Response failed.";
  return "Ready for a message.";
}

async function requestHostedChat(prompt: string, signal: AbortSignal) {
  return fetch("/api/chat", {
    method: "POST",
    headers: {
      ...(await openaiAuthHeaders()),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prompt }),
    signal,
  });
}

export function ChatConsole({
  requestChat = requestHostedChat,
}: ChatConsoleProps = {}) {
  const [authStatus, setAuthStatus] =
    useState<SignInWithChatGPTState["status"]>("checking");
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [localError, setLocalError] = useState("");
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [streamPhase, setStreamPhase] = useState<StreamPhase>("Ready");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const composingRef = useRef(false);
  const inFlightRef = useRef(false);
  const isNearBottomRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const transcriptRef = useRef<HTMLElement>(null);
  const streamFeedbackRef = useRef<ReturnType<typeof nextStreamFeedback>>({
    ...INITIAL_STREAM_FEEDBACK,
  });

  function updateStreamFeedback(
    event: Parameters<typeof nextStreamFeedback>[1],
    requestId?: string,
  ) {
    const feedback = nextStreamFeedback(streamFeedbackRef.current, event);
    streamFeedbackRef.current = feedback;
    setStreamPhase(feedback.phase);
    if (requestId) setAssistantStatus(requestId, feedback.assistantStatus);
    return feedback;
  }

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
    const submittedFeedback = updateStreamFeedback({ type: "send" });
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
          status: submittedFeedback.assistantStatus,
        },
      ].slice(-MAX_VISIBLE_TURNS),
    );

    let pendingError = "";
    try {
      const response = await requestChat(message, controller.signal);
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
      updateStreamFeedback({ type: "accepted" });

      let terminal = false;
      let completed = false;
      for await (const item of readRelmioEvents(response.body)) {
        if (!isCurrentRequest(requestId)) return;

        if (item.event === "progress") {
          updateStreamFeedback({
            type: "progress",
            upstreamPhase: item.data.phase,
          });
        } else if (item.event === "delta") {
          if (typeof item.data.text !== "string") {
            throw new Error("Relmio returned an invalid response chunk.");
          }
          const feedback = updateStreamFeedback({
            type: "delta",
            text: item.data.text,
          });
          if (item.data.text.length === 0) continue;
          updateAssistantTurn(requestId, (turn) => ({
            ...turn,
            content: turn.content + item.data.text,
            status: feedback.assistantStatus,
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
            updateStreamFeedback({ type: "failed" }, requestId);
          } else if (!streamFeedbackRef.current.receivedText) {
            throw new Error("Relmio completed without a visible response.");
          } else {
            completed = true;
          }
        }
      }
      if (!terminal) throw new Error("The response ended before completion.");
      if (completed && isCurrentRequest(requestId)) {
        updateStreamFeedback({ type: "complete" }, requestId);
      }
    } catch (error) {
      if (!isCurrentRequest(requestId)) return;

      if (controller.signal.aborted) {
        setLocalError("");
        updateStreamFeedback({ type: "stopped" }, requestId);
      } else {
        setLocalError(
          error instanceof Error
            ? error.message
            : "Connect ChatGPT before sending a message.",
        );
        updateStreamFeedback({ type: "failed" }, requestId);
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

    updateStreamFeedback({ type: "stopping" }, activeRequest.requestId);
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

    transcript.focus();
    isNearBottomRef.current = true;
    transcript.scrollTop = transcript.scrollHeight;
    setShowJumpToLatest(false);
  }

  const statusLabel =
    authStatus === "signed-in"
      ? "Signed in"
      : authStatus === "checking"
        ? "Checking session"
        : "Signed out";
  const phaseTone =
    streamPhase === "Failed"
      ? "danger"
      : streamPhase === "Stopped"
        ? "warning"
        : streamPhase === "Ready" || streamPhase === "Complete"
          ? "success"
          : streamPhase === "Sending" ||
              streamPhase === "Connecting" ||
              streamPhase === "Waiting"
            ? "busy"
            : "accent";

  return (
    <section className={`rm-panel ${styles.shell}`} aria-label="Hosted chat console">
      <div className={styles.header}>
        <div className={styles.cluster}>
          <span className="rm-eyebrow">Hosted test lane</span>
          <span className={`rm-badge ${styles.model}`}>gpt-5.6-luna</span>
        </div>
        <div className={styles.cluster}>
          <span className="rm-status" data-tone={phaseTone}>
            <span className="rm-status__dot" aria-hidden="true" />
            <span className="rm-visually-hidden">Response state: </span>
            {streamPhase}
          </span>
          <span
            className={
              authStatus === "signed-in" ? "rm-badge rm-badge--success" : "rm-badge"
            }
          >
            {statusLabel}
          </span>
        </div>
      </div>

      <div className={styles.sessionBoundary} role="group" aria-label="Session boundary">
        <SignInWithChatGPT
          className="rm-button"
          style={kitButtonStyle}
          loadingLabel="Checking ChatGPT…"
          redirectingLabel="Opening ChatGPT…"
          signedInLabel="Sign out"
          showLogo
          onStateChange={(state) => {
            setAuthStatus(state.status);
            if (state.status === "signed-out") {
              const active = activeRequestRef.current;
              activeRequestRef.current = null;
              active?.controller.abort();
              inFlightRef.current = false;
              isNearBottomRef.current = true;
              streamFeedbackRef.current = { ...INITIAL_STREAM_FEEDBACK };
              setInput("");
              setTurns([]);
              setIsLoading(false);
              setShowJumpToLatest(false);
              setStreamPhase("Ready");
              setLocalError("");
            } else if (state.status === "error") {
              setLocalError(state.error.message);
            } else if (state.status === "signed-in") {
              setLocalError("");
            }
          }}
        />
        <p className={styles.boundaryCopy}>
          <Icon name="lock" size="sm" className={styles.boundaryIcon} />
          <span>
            Unofficial third-party openai-oauth Codex sign-in, not OpenAI&apos;s documented Sign in with ChatGPT integration. Policy status is uncertain. No tools, files, commands or browsing. The demo keeps six exchanges in this tab.{" "}
            <Link className="rm-link" href="/docs/security#hosted-chat-demo">How prompts and sign-in are handled</Link>.
          </span>
        </p>
      </div>

      <div className={styles.transcriptRegion}>
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
            <div className={styles.emptyState}>
              <span className={styles.emptyIcon}>
                <Icon name="message" />
              </span>
              <p className={styles.emptyTitle}>Your private test lane is ready.</p>
              <p className={styles.emptyCopy}>
                Connect ChatGPT, choose a starter, or ask your own question.
              </p>
              <div className={styles.suggestions} role="group" aria-label="Suggested prompts">
                {suggestions.map((suggestion) => (
                  <button
                    className="rm-button rm-button--sm"
                    key={suggestion}
                    type="button"
                    onClick={() => {
                      textareaRef.current?.focus();
                      void ask(suggestion);
                    }}
                    disabled={isLoading}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className={styles.turnList}>
              {turns.map((turn) => {
                if (turn.role === "user") {
                  const lastPrompt = turn.content;
                  return (
                    <article
                      className={`${styles.message} ${styles.userMessage}`}
                      key={turn.id}
                    >
                      <span className={styles.speaker}>You</span>
                      <p>{lastPrompt}</p>
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
                    <div className={styles.messageMeta}>
                      <span className={styles.speaker}>
                        {isIncomplete ? "Relmio · incomplete" : "Relmio"}
                      </span>
                      {turn.status === "stopped" || turn.status === "failed" ? (
                        <span className={styles.turnStatus}>{turn.status}</span>
                      ) : null}
                    </div>
                    <p
                      className={
                        turn.status === "waiting"
                          ? styles.waitingIndicator
                          : undefined
                      }
                      aria-hidden={turn.status === "waiting" ? "true" : undefined}
                    >
                      {turn.status === "waiting"
                        ? "Preparing response"
                        : completion || fallback}
                      {turn.status === "streaming" ? (
                        <span className={styles.streamingCursor} aria-hidden="true">
                          {" "}
                        </span>
                      ) : null}
                    </p>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        {showJumpToLatest && turns.length > 0 ? (
          <button
            className={`rm-button rm-button--sm ${styles.jumpToLatest}`}
            type="button"
            onClick={jumpToLatest}
          >
            <Icon name="chevron-down" size="sm" />
            Jump to latest
          </button>
        ) : null}
      </div>

      <div className={styles.composerDock}>
        {localError ? (
          <Callout tone="danger" role="alert" className={styles.error}>
            {localError}
          </Callout>
        ) : null}

        <form className={styles.composer} onSubmit={handleSubmit}>
          <div className={styles.composerMeta}>
            <label className="rm-field__label" htmlFor="chat-prompt">
              Message Relmio
            </label>
            <span id="chat-input-hint" className="rm-field__hint">
              Enter to send · Shift+Enter for a new line · {input.length}/3000
            </span>
          </div>
          <div className={styles.composerRow}>
            <textarea
              className="rm-textarea"
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
                className={`rm-button ${styles.submitButton}`}
                type="button"
                onClick={stop}
                aria-label="Stop response"
              >
                <Square aria-hidden="true" size={16} strokeWidth={1.75} />
              </button>
            ) : (
              <button
                className={`rm-button rm-button--primary ${styles.submitButton}`}
                type="submit"
                disabled={!input.trim()}
                aria-label="Send message"
              >
                <SendHorizontal aria-hidden="true" size={18} strokeWidth={1.75} />
              </button>
            )}
          </div>
        </form>
      </div>

      <p
        className="rm-visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {responsePhaseAnnouncement(streamPhase)}
      </p>
    </section>
  );
}
