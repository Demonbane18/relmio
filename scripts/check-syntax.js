import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { spawn } from "node:child_process";

const roots = ["src", "test", "scripts"];

async function collectJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectJavaScriptFiles(path)));
    } else if (extname(entry.name) === ".js") {
      files.push(path);
    }
  }

  return files;
}

function checkFile(path) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--check", path], {
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Syntax check failed for ${path}`));
      }
    });
  });
}

const files = (
  await Promise.all(
    roots.map(async (root) => {
      try {
        return await collectJavaScriptFiles(root);
      } catch (error) {
        if (error.code === "ENOENT") {
          return [];
        }
        throw error;
      }
    }),
  )
).flat();

for (const file of files) {
  await checkFile(file);
}

console.log(`Syntax checked ${files.length} JavaScript files.`);
