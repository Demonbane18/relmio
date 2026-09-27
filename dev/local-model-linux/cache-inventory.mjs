// Runs only in the digest-pinned n8n image with the exact owned model volume mounted read-only.
// The optional root is for a local boundary smoke, never a production Docker CLI argument.
export function createCacheInventoryProgram(root = "/cache/models") {
  return `
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = ${JSON.stringify(root)};
const rows = [];
let bytes = 0;
const buffer = Buffer.alloc(1024 * 1024);
function visit(directory) {
  for (const name of fs.readdirSync(directory).sort()) {
    const file = path.join(directory, name);
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw Error('Cache symlink rejected');
    if (stat.isDirectory()) { visit(file); continue; }
    if (!stat.isFile() || stat.nlink !== 1 || rows.length >= 128) throw Error('Unexpected cache entry');
    bytes += stat.size;
    if (bytes > 2 * 1024 * 1024 * 1024) throw Error('Cache inventory byte bound exceeded');
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    try {
      let count;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
      const after = fs.fstatSync(fd);
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw Error('Cache changed during read-only inventory');
    } finally { fs.closeSync(fd); }
    rows.push({ name: path.relative(root, file), bytes: stat.size, sha256: hash.digest('hex') });
  }
}
visit(root);
process.stdout.write(JSON.stringify(rows));
`.replaceAll("\n", " ");
}

export function validatePartialInventory(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 128 || rows.some(row =>
    typeof row?.name !== "string" || !/^(?:blobs|manifests)\/[a-zA-Z0-9._/-]+$/u.test(row.name) || row.name.split("/").includes("..") ||
    !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !/^[a-f0-9]{64}$/u.test(row.sha256))) {
    throw new Error("Invalid stopped-writer cache inventory.");
  }
  if (rows.some(row => row.name.startsWith("manifests/")) || !rows.some(row => row.bytes > 0 && /^blobs\/sha256-[a-f0-9]{64}-partial(?:-\d+)?$/u.test(row.name))) {
    throw new Error("No genuine incomplete cold-download cache was established; requested mid-pull scenario is NOT-RUN.");
  }
  return rows;
}
