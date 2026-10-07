import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { AREAS, classifyPaths, formatGithubOutput, runFlags } from "../scripts/release-impact.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../scripts/release-impact.mjs", import.meta.url));

test("every tracked file maps to a known area through an explicit rule", () => {
  const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  assert.ok(tracked.length > 100);
  for (const path of tracked) {
    const result = classifyPaths([path]);
    assert.deepEqual(result.unknown, [], `${path} has no rule`);
    assert.ok(result.areas.length > 0 && result.areas.every((area) => AREAS.includes(area)), path);
  }
});

test("docs-only is exact", () => {
  for (const paths of [["docs/faq.md"], ["README.md", "CHANGELOG.md", "npm/README.md"], ["docs/images/setup/00-install-methods.png"]]) {
    assert.equal(classifyPaths(paths).docsOnly, true, paths.join(" "));
  }
  for (const paths of [["AGENTS.md"], ["docs/faq.md", "web/app/page.tsx"], ["docs/faq.md", "src/cli.js"], ["LICENSE"], ["src/docs.md"]]) {
    assert.equal(classifyPaths(paths).docsOnly, false, paths.join(" "));
  }
  assert.deepEqual(classifyPaths(["AGENTS.md"]).areas, ["ci"]);
});

test("web-only is exact and excludes the served installers", () => {
  for (const paths of [["web/app/page.tsx"], ["web/app/page.tsx", "docs/faq.md"], ["web/AGENTS.md", "web/package-lock.json"]]) {
    assert.equal(classifyPaths(paths).webOnly, true, paths.join(" "));
  }
  for (const paths of [["web/public/install.sh"], ["web/app/page.tsx", "src/ui/app.js"], ["src/ui/relmio-ui.css"], ["web/app/page.tsx", "package.json"]]) {
    assert.equal(classifyPaths(paths).webOnly, false, paths.join(" "));
  }
  assert.deepEqual(classifyPaths(["web/public/install.ps1"]).areas, ["installers"]);
  assert.deepEqual(classifyPaths(["src/ui/relmio-ui.css"]).areas, ["web", "wizard-ui"]);
});

test("unknown and empty changes fail safe to root and run everything", () => {
  const result = classifyPaths(["docs/faq.md", "brand-new-dir/thing.txt"]);
  assert.deepEqual(result, { areas: ["docs", "root"], docsOnly: false, webOnly: false, unknown: ["brand-new-dir/thing.txt"] });
  assert.ok(Object.values(runFlags(result)).every(Boolean));
  assert.ok(Object.values(runFlags(classifyPaths([]))).every(Boolean));
});

test("feature paths select their areas and the n8n node harness", () => {
  const cases = [
    ["src/gateway/openai-oauth-sidecar.mjs", ["sidecar"], true],
    ["src/services/siwc-session.mjs", ["siwc-auth"], true],
    ["src/domain/local-n8n-assistant.js", ["assistant", "local-docker"], true],
    ["src/services/vps-local-model.js", ["local-model", "vps"], false],
    ["src/ui/app.js", ["wizard-ui"], false],
    ["package.json", ["ci", "root"], true],
    [".github/workflows/ci.yml", ["ci", "root"], true],
  ];
  for (const [path, areas, n8nNodes] of cases) {
    const result = classifyPaths([path]);
    assert.deepEqual(result.areas, areas, path);
    assert.equal(runFlags(result).run_n8n_nodes, n8nNodes, path);
    assert.equal(runFlags(result).run_root, true, path);
  }
});

test("GitHub output lists every flag in a fixed format", () => {
  assert.equal(
    formatGithubOutput(classifyPaths(["web/app/page.tsx", "docs/faq.md"])),
    [
      "areas=docs,web", "docs_only=false", "web_only=true", "run_root=false", "run_web=true",
      "run_windows=false", "run_macos=false", "run_linux=false", "run_n8n_nodes=false", "",
    ].join("\n"),
  );
});

async function gitRepository() {
  const directory = await mkdtemp(join(tmpdir(), "relmio-release-impact-"));
  const git = (...args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" });
  const commitFiles = async (message, files) => {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(dirname(join(directory, path)), { recursive: true });
      await writeFile(join(directory, path), contents);
    }
    git("add", "-A");
    git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", message);
    return git("rev-parse", "HEAD").trim();
  };
  git("init", "-q");
  const base = await commitFiles("base", { "docs/faq.md": "a\n", "web/app/page.tsx": "a\n", "src/gateway/old.mjs": "a\n" });
  return { directory, git, base, commitFiles };
}

async function runCli(directory, args) {
  const outputFile = join(directory, ".git", "github-output");
  const summaryFile = join(directory, ".git", "step-summary");
  await writeFile(outputFile, "");
  await writeFile(summaryFile, "");
  await execFileAsync(process.execPath, [cliPath, ...args, "--format", "github"], {
    cwd: directory,
    env: { ...process.env, GITHUB_OUTPUT: outputFile, GITHUB_STEP_SUMMARY: summaryFile },
  });
  const outputs = Object.fromEntries((await readFile(outputFile, "utf8")).trim().split("\n").map((line) => line.split("=")));
  return { outputs, summary: await readFile(summaryFile, "utf8") };
}

test("CLI writes GitHub outputs and a summary for docs, web and sidecar changes", async () => {
  const { directory, git, base, commitFiles } = await gitRepository();
  try {
    const docs = await commitFiles("docs", { "docs/faq.md": "b\n" });
    const web = await commitFiles("web", { "web/app/page.tsx": "b\n" });
    git("mv", "src/gateway/old.mjs", "src/gateway/new.mjs");
    const sidecar = await commitFiles("sidecar", {});

    const docsRun = await runCli(directory, ["--base", base, "--head", docs]);
    assert.equal(docsRun.outputs.areas, "docs");
    assert.equal(docsRun.outputs.docs_only, "true");
    assert.equal(docsRun.outputs.run_root, "false");
    assert.equal(docsRun.outputs.run_web, "true");
    assert.match(docsRun.summary, /\| `docs_only` \| true \|/u);

    const webRun = await runCli(directory, ["--base", docs, "--head", web]);
    assert.deepEqual([webRun.outputs.areas, webRun.outputs.web_only, webRun.outputs.run_root], ["web", "true", "false"]);

    const sidecarRun = await runCli(directory, ["--base", web, "--head", sidecar]);
    assert.deepEqual(
      [sidecarRun.outputs.areas, sidecarRun.outputs.run_root, sidecarRun.outputs.run_n8n_nodes, sidecarRun.outputs.run_web],
      ["sidecar", "true", "true", "false"],
    );

    const { stdout } = await execFileAsync(process.execPath, [cliPath, "--base", web, "--head", sidecar], { cwd: directory });
    assert.deepEqual(JSON.parse(stdout).paths, ["src/gateway/new.mjs", "src/gateway/old.mjs"]);

    await assert.rejects(execFileAsync(process.execPath, [cliPath, "--base", "no-such-ref"], { cwd: directory }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
