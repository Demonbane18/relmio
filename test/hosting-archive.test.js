import assert from "node:assert/strict";
import test from "node:test";

import { createHostingArchive } from "../src/ui/hosting-archive.js";

function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const end = bytes.byteLength - 22;
  assert.equal(view.getUint32(end, true), 0x06054b50);
  const count = view.getUint16(end + 10, true);
  const directory = view.getUint32(end + 16, true);
  const entries = new Map();
  let position = directory;
  for (let index = 0; index < count; index++) {
    assert.equal(view.getUint32(position, true), 0x02014b50);
    assert.equal(view.getUint16(position + 10, true), 0); // stored, no decompression required
    const size = view.getUint32(position + 24, true);
    const nameLength = view.getUint16(position + 28, true);
    const extraLength = view.getUint16(position + 30, true);
    const commentLength = view.getUint16(position + 32, true);
    const local = view.getUint32(position + 42, true);
    const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
    assert.equal(view.getUint32(local, true), 0x04034b50);
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    assert.equal(decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)), name);
    const contentStart = local + 30 + localNameLength + localExtraLength;
    entries.set(name, {
      content: decoder.decode(bytes.subarray(contentStart, contentStart + size)),
      crc: view.getUint32(position + 16, true),
    });
    position += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(position, end);
  return entries;
}

test("downloadable ZIP retains runnable nested paths and hidden configuration files", () => {
  const entries = readZip(createHostingArchive([
    { name: "api/chat.mjs", content: "export const answer = 4;", mediaType: "text/javascript" },
    { name: "src/index.mjs", content: "hello", mediaType: "text/javascript" },
    { name: ".dockerignore", content: "*\n!Dockerfile\n", mediaType: "text/plain" },
    { name: "INSTRUCTIONS.md", content: "Review and deploy", mediaType: "text/markdown" },
  ]));
  assert.deepEqual([...entries.keys()], ["api/chat.mjs", "src/index.mjs", ".dockerignore", "INSTRUCTIONS.md"]);
  assert.equal(entries.get("api/chat.mjs").content, "export const answer = 4;");
  assert.equal(entries.get(".dockerignore").content, "*\n!Dockerfile\n");
  assert.equal(entries.get("src/index.mjs").crc, 0x3610a686); // published CRC-32 for ASCII "hello"
});

test("archive rejects traversal, duplicate paths, and oversized artifacts", () => {
  const file = (name, content = "ok") => ({ name, content, mediaType: "text/plain" });
  for (const name of ["../secret", "api/../secret", "/absolute", "C:/absolute", "api\\chat.mjs", ".gitignore", "api//chat.mjs"]) {
    assert.throws(() => createHostingArchive([file(name)]));
  }
  assert.throws(() => createHostingArchive([file("api/chat.mjs"), file("api/chat.mjs")]));
  assert.throws(() => createHostingArchive([]));
  assert.throws(() => createHostingArchive([file("large.txt", "x".repeat(2 * 1024 * 1024 + 1))]));
  const twoMiB = "x".repeat(2 * 1024 * 1024);
  assert.throws(() => createHostingArchive(Array.from({ length: 5 }, (_, i) => file(`file-${i}.txt`, twoMiB))));
  assert.throws(() => createHostingArchive(Array.from({ length: 129 }, (_, i) => file(`file-${i}.txt`))));
});
