import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentUrl = new URL(
  "../app/components/ChatConsole.tsx",
  import.meta.url,
);
const stylesUrl = new URL(
  "../app/components/ChatConsole.module.css",
  import.meta.url,
);

test("guards rapid duplicate submissions before any request await", async () => {
  const source = await readFile(componentUrl, "utf8");
  const guard = source.indexOf("if (!message || inFlightRef.current) return;");
  const lock = source.indexOf("inFlightRef.current = true;", guard);
  const requestAwait = source.indexOf("await requestChat(message, controller.signal)", lock);

  assert.ok(guard >= 0, "missing synchronous duplicate-submit guard");
  assert.ok(lock > guard, "missing synchronous in-flight lock");
  assert.ok(requestAwait > lock, "the request lock must be set before the first await");
  assert.match(source, /activeRequestRef\.current\?\.requestId === requestId/u);
});

test("isolates stale stream writes and preserves partial assistant output", async () => {
  const source = await readFile(componentUrl, "utf8");

  assert.match(source, /if \(!isCurrentRequest\(requestId\)\) return;/u);
  assert.match(source, /turn\.requestId === requestId/u);
  assert.match(source, /content: turn\.content \+ item\.data\.text/u);
  assert.match(source, /updateStreamFeedback\(\{ type: "failed" \}, requestId\)/u);
  assert.match(
    source,
    /if \(isCurrentRequest\(requestId\)\) \{[\s\S]*inFlightRef\.current = false;/u,
  );
  assert.match(source, /activeRequest\.controller\.abort\(\)/u);
});

test("uses stable bounded turns instead of one shared completion buffer", async () => {
  const source = await readFile(componentUrl, "utf8");

  assert.match(source, /useState<ChatTurn\[\]>\(\[\]\)/u);
  assert.match(source, /const MAX_VISIBLE_TURNS = 12;/u);
  assert.match(source, /\.slice\(-MAX_VISIBLE_TURNS\)/u);
  assert.match(source, /key=\{turn\.id\}/u);
  assert.doesNotMatch(source, /setCompletion|setLastPrompt|const \[lastPrompt/u);
});

test("keeps one conditional transcript scroll owner and an explicit jump control", async () => {
  const [source, styles] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);

  assert.match(source, /const transcriptRef = useRef<HTMLElement>\(null\)/u);
  assert.match(source, /isNearBottomRef\.current/u);
  assert.match(
    source,
    /if \(turns\.length === 0\) \{[\s\S]*transcript\.scrollTop = 0;[\s\S]*return;/u,
  );
  assert.match(source, /STICK_TO_BOTTOM_DISTANCE/u);
  assert.match(source, /Jump to latest/u);
  assert.doesNotMatch(source, /behavior:\s*"smooth"|scrollIntoView/u);
  assert.match(styles, /\.transcript\s*\{[\s\S]*min-height:\s*0;[\s\S]*overflow-y:\s*auto;/u);
  assert.match(styles, /\.transcriptRegion\s*\{[\s\S]*overflow:\s*hidden;/u);
});

test("keeps composer IME-safe, auto-growing, and in normal flow", async () => {
  const [source, styles] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);

  assert.match(source, /event\.nativeEvent\.isComposing/u);
  assert.match(source, /event\.keyCode === 229/u);
  assert.match(source, /onCompositionStart/u);
  assert.match(source, /onCompositionEnd/u);
  assert.match(source, /const COMPOSER_MIN_HEIGHT = 64;/u);
  assert.match(source, /const COMPOSER_MAX_HEIGHT = 192;/u);
  assert.match(source, /maxLength=\{3000\}/u);
  assert.match(styles, /\.composerRow textarea\s*\{[\s\S]*min-height:\s*4rem;[\s\S]*max-height:\s*12rem;[\s\S]*resize:\s*none;/u);
  assert.match(styles, /\.submitButton\s*\{[\s\S]*position:\s*static;/u);
  assert.match(
    styles,
    /\.composerDock\s*\{[^}]*width:\s*100%;[^}]*min-height:\s*0;[^}]*margin:\s*0;[^}]*display:\s*block;/su,
  );
  assert.doesNotMatch(styles, /\.submitButton\s*\{[^}]*position:\s*(?:absolute|fixed)/u);
});

test("separates transcript semantics from the atomic request phase announcement", async () => {
  const [source, styles] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);

  assert.match(source, /role="log"/u);
  assert.match(source, /aria-label="Chat transcript"/u);
  assert.match(source, /aria-relevant="additions"/u);
  assert.doesNotMatch(source, /aria-relevant="additions text"/u);
  assert.match(source, /role="status"/u);
  assert.match(source, /aria-live="polite"/u);
  assert.match(source, /aria-atomic="true"/u);
  assert.match(source, /No tools, files, commands, or external\s+browsing\./u);
  assert.match(source, /latest six exchanges in this tab/u);
  assert.doesNotMatch(styles, /--duration-normal/u);
});

test("distinguishes waiting for first text from active streaming without a spinner", async () => {
  const [source, styles] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);

  assert.match(source, /\| "waiting"[\s\S]*\| "streaming"/u);
  assert.match(source, /status: submittedFeedback\.assistantStatus/u);
  assert.match(
    source,
    /updateStreamFeedback\(\{\s*type: "progress",\s*upstreamPhase: item\.data\.phase/u,
  );
  assert.match(
    source,
    /item\.event === "delta"[\s\S]*status: feedback\.assistantStatus/u,
  );
  assert.match(source, /Preparing response/u);
  assert.match(source, /styles\.waitingIndicator/u);
  assert.match(source, /styles\.streamingCursor/u);
  assert.doesNotMatch(source, /LoaderCircle/u);
  assert.doesNotMatch(styles, /@keyframes spin/u);
  assert.match(
    styles,
    /\.message p\s*\{[^}]*min-height:\s*calc\(var\(--text-body-size\)\s*\*\s*var\(--text-body-leading\)\)/su,
  );
  assert.match(
    source,
    /as="p"\s*type="body"[\s\S]*styles\.waitingIndicator/u,
  );
  assert.doesNotMatch(
    styles,
    /\.waitingIndicator\s*\{[^}]*text-supporting|\.waitingIndicator\s*\{[^}]*min-height/su,
  );
  assert.match(
    styles,
    /\.streamingCursor\s*\{[^}]*display:\s*inline-block;/su,
  );
});

test("announces stream phase changes atomically and keeps reduced-motion feedback static", async () => {
  const [source, styles] = await Promise.all([
    readFile(componentUrl, "utf8"),
    readFile(stylesUrl, "utf8"),
  ]);

  assert.match(source, /function responsePhaseAnnouncement/u);
  assert.match(source, /Waiting[\s\S]*waiting for the first words/iu);
  assert.match(source, /Streaming[\s\S]*responding/iu);
  assert.match(source, /Stopping[\s\S]*Stopping the response/iu);
  assert.match(source, /Stopped[\s\S]*Response stopped/iu);
  assert.match(source, /Failed[\s\S]*Response failed/iu);
  assert.match(source, /responsePhaseAnnouncement\(streamPhase\)/u);
  assert.match(
    source,
    /styles\.waitingIndicator[\s\S]*aria-hidden="true"/u,
  );
  assert.match(
    source,
    /styles\.streamingCursor[\s\S]*aria-hidden="true"/u,
  );

  const reducedMotion = styles.slice(
    styles.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(
    reducedMotion,
    /\.waitingIndicator::before,[\s\S]*\.streamingCursor\s*\{[^}]*animation:\s*none;/u,
  );
  assert.match(
    reducedMotion,
    /\.waitingIndicator::before\s*\{[^}]*background:\s*var\(--chat-teal\);/u,
  );
  assert.match(
    reducedMotion,
    /\.streamingCursor\s*\{[^}]*background:\s*var\(--chat-teal\);/u,
  );
});

test("keeps the auth and fetch boundary injectable for deterministic stream QA", async () => {
  const source = await readFile(componentUrl, "utf8");

  assert.match(source, /type ChatConsoleProps =/u);
  assert.match(source, /type ChatRequest =/u);
  assert.match(source, /async function requestHostedChat/u);
  assert.match(source, /await openaiAuthHeaders\(\)/u);
  assert.match(source, /fetch\("\/api\/chat"/u);
  assert.match(
    source,
    /export function ChatConsole\(\{\s*requestChat = requestHostedChat,\s*\}: ChatConsoleProps = \{\}\)/u,
  );
  assert.match(source, /await requestChat\(message, controller\.signal\)/u);
});

test("keeps waiting metadata quiet and avoids repeating incomplete terminal text", async () => {
  const source = await readFile(componentUrl, "utf8");

  assert.match(
    source,
    /turn\.status === "stopped" \|\| turn\.status === "failed"/u,
  );
  assert.doesNotMatch(
    source,
    /turn\.status !== "complete" && turn\.status !== "streaming"/u,
  );
});

test("keeps response phases monotonic before the first streamed text", async () => {
  const source = await readFile(componentUrl, "utf8");
  const request = source.indexOf(
    "await requestChat(message, controller.signal)",
  );
  const accepted = source.indexOf(
    'updateStreamFeedback({ type: "accepted" });',
    request,
  );
  const streamLoop = source.indexOf(
    "for await (const item of readRelmioEvents(response.body))",
    request,
  );
  const firstDelta = source.indexOf('item.event === "delta"', streamLoop);

  assert.ok(request >= 0, "missing hosted request boundary");
  assert.ok(accepted > request, "accepted streams should remain Connecting");
  assert.ok(streamLoop > accepted, "stream processing must follow acceptance");
  assert.ok(firstDelta > streamLoop, "missing first-delta transition");
  assert.match(
    source.slice(streamLoop, firstDelta),
    /updateStreamFeedback\(\{[\s\S]*type: "progress",[\s\S]*item\.data\.phase/u,
  );
  assert.match(
    source,
    /phase === "Sending"\) return "Sending message to Relmio\."/u,
  );
});
