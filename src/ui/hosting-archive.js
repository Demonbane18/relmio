const MAX_FILES = 128;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const SEGMENT = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*|\.dockerignore)$/u;
const encoder = new TextEncoder();

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index++) {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  crcTable[index] = crc >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function archiveFile(file) {
  if (!file || typeof file.name !== "string" || file.name.length > 128 ||
    !file.name.split("/").every((segment) => SEGMENT.test(segment)) ||
    typeof file.content !== "string" || file.content.length > MAX_FILE_BYTES) {
    throw new TypeError("A hosting archive file has an unsafe path or content.");
  }
  const name = encoder.encode(file.name);
  const content = encoder.encode(file.content);
  if (content.length > MAX_FILE_BYTES) throw new RangeError("A hosting archive file exceeds the size limit.");
  return { name, content, checksum: crc32(content), offset: 0 };
}

/** Builds a bounded ZIP with stored UTF-8 files and their original relative paths. */
export function createHostingArchive(files) {
  if (!Array.isArray(files) || files.length < 1 || files.length > MAX_FILES) {
    throw new RangeError("The hosting archive file count is invalid.");
  }
  const names = new Set();
  const entries = [];
  let localSize = 0;
  let directorySize = 0;
  for (const file of files) {
    if (names.has(file?.name)) throw new TypeError("The hosting archive has a duplicate path.");
    const entry = archiveFile(file);
    names.add(file.name);
    entry.offset = localSize;
    localSize += 30 + entry.name.length + entry.content.length;
    directorySize += 46 + entry.name.length;
    if (localSize + directorySize + 22 > MAX_ARCHIVE_BYTES) {
      throw new RangeError("The hosting archive exceeds the size limit.");
    }
    entries.push(entry);
  }
  const totalSize = localSize + directorySize + 22;
  const bytes = new Uint8Array(totalSize);
  const view = new DataView(bytes.buffer);
  let position = 0;
  const word = (value) => { view.setUint16(position, value, true); position += 2; };
  const dword = (value) => { view.setUint32(position, value, true); position += 4; };

  for (const entry of entries) {
    dword(0x04034b50); word(20); word(0x0800); word(0);
    word(0); word(0x0021); dword(entry.checksum);
    dword(entry.content.length); dword(entry.content.length);
    word(entry.name.length); word(0);
    bytes.set(entry.name, position); position += entry.name.length;
    bytes.set(entry.content, position); position += entry.content.length;
  }
  for (const entry of entries) {
    dword(0x02014b50); word(20); word(20); word(0x0800); word(0);
    word(0); word(0x0021); dword(entry.checksum);
    dword(entry.content.length); dword(entry.content.length);
    word(entry.name.length); word(0); word(0); word(0);
    word(0); dword(0); dword(entry.offset);
    bytes.set(entry.name, position); position += entry.name.length;
  }
  dword(0x06054b50); word(0); word(0);
  word(entries.length); word(entries.length);
  dword(directorySize); dword(localSize); word(0);
  return bytes;
}
