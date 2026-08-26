export const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_STREAM_WIRE_BYTES = 4 * 1024 * 1024;
const textEncoder = new TextEncoder();

/**
 * @typedef {object} RelmioEvent
 * @property {Record<string, unknown>} data
 * @property {string} event
 */

/**
 * @param {string} block
 * @returns {RelmioEvent | null}
 */
function parseEventBlock(block) {
  const dataLines = [];
  let event = "";
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
  }
  if (!event || dataLines.length === 0) return null;
  const value = JSON.parse(dataLines.join("\n"));
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { event, data: value };
}

/**
 * @param {ReadableStream<Uint8Array>} stream
 * @returns {AsyncGenerator<RelmioEvent>}
 */
export async function* readRelmioEvents(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let wireBytes = 0;
  let outputBytes = 0;
  let exhausted = false;

  function acceptEvent(block) {
    const event = parseEventBlock(block);
    if (!event) throw new Error("The response stream was unreadable.");
    if (event.event === "delta" && typeof event.data.text === "string") {
      outputBytes += textEncoder.encode(event.data.text).byteLength;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        throw new Error("The response exceeded Relmio's safe display limit.");
      }
    }
    return event;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        exhausted = true;
        break;
      }
      wireBytes += value.byteLength;
      if (wireBytes > MAX_STREAM_WIRE_BYTES) {
        throw new Error("The response exceeded Relmio's safe display limit.");
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/u);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        if (!block.trim() || block.trimStart().startsWith(":")) continue;
        yield acceptEvent(block);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() && !buffer.trimStart().startsWith(":")) {
      yield acceptEvent(buffer);
    }
  } finally {
    if (!exhausted) {
      try {
        await reader.cancel();
      } catch {
        // The same-origin stream may already be closed after a terminal event.
      }
    }
    reader.releaseLock();
  }
}
