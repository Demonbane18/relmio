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
  const authAwait = source.indexOf("await openaiAuthHeaders()", lock);

  assert.ok(guard >= 0, "missing synchronous duplicate-submit guard");
  assert.ok(lock > guard, "missing synchronous in-flight lock");
  assert.ok(authAwait > lock, "the request lock must be set before the first await");
  assert.match(source, /activeRequestRef\.current\?\.requestId === requestId/u);
});

test("isolates stale stream writes and preserves partial assistant output", async () => {
  const source = await readFile(componentUrl, "utf8");

  assert.match(source, /if \(!isCurrentRequest\(requestId\)\) return;/u);
  assert.match(source, /turn\.requestId === requestId/u);
  assert.match(source, /content: turn\.content \+ item\.data\.text/u);
  assert.match(source, /receivedText \? "incomplete" : "failed"/u);
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
