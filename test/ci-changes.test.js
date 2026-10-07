import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { comparisonBase, decideJobs, forcedReason, main } from "../scripts/ci-changes.mjs";

const CI = "Demonbane18/relmio/.github/workflows/ci.yml@refs/pull/7/merge";
const HOTFIX = "Demonbane18/relmio/.github/workflows/hotfix.yml@refs/pull/7/merge";
const SHA = "a".repeat(40);
const EVERYTHING = {
  run_root: true, run_web: true, run_windows: true,
  run_macos: true, run_linux: true, run_n8n_nodes: true,
};

function fakeGit(answers) {
  const calls = [];
  return {
    calls,
    git(args) {
      calls.push(args.join(" "));
      return answers[args.join(" ")] ?? "";
    },
  };
}

test("tags, reusable calls and pushes to main force a full run; other events do not", () => {
  assert.ok(forcedReason({ workflowRef: HOTFIX, eventName: "pull_request", ref: "refs/pull/7/merge" }));
  assert.ok(forcedReason({ workflowRef: CI, eventName: "push", refType: "tag", ref: "refs/tags/v1.0.0" }));
  assert.ok(forcedReason({ workflowRef: CI, eventName: "push", refType: "branch", ref: "refs/heads/main" }));
  assert.equal(forcedReason({ workflowRef: CI, eventName: "push", refType: "branch", ref: "refs/heads/feature" }), "");
  assert.equal(forcedReason({ workflowRef: CI, eventName: "pull_request", ref: "refs/pull/7/merge" }), "");
  assert.ok(forcedReason({ eventName: "pull_request" }), "an unknown workflow ref fails safe");
});

test("a forced run executes every job even when the diff touches only docs", () => {
  const docs = decideJobs({ forced: "", paths: ["docs/reference.md"] });
  assert.equal(docs.flags.run_root, false);
  assert.equal(docs.flags.run_macos, false);
  assert.equal(docs.flags.run_n8n_nodes, false);
  assert.equal(docs.flags.run_web, true);
  assert.deepEqual(decideJobs({ forced: "Release tag.", paths: ["docs/reference.md"] }).flags, EVERYTHING);
  assert.deepEqual(decideJobs({ forced: "", paths: null }).flags, EVERYTHING);
});

test("a sidecar change runs every OS job and n8n nodes but not the website", () => {
  const { flags } = decideJobs({ forced: "", paths: ["src/gateway/openai-oauth-sidecar.mjs"] });
  assert.deepEqual(flags, { ...EVERYTHING, run_web: false });
});

test("pull requests compare against a validated base commit only", () => {
  const { git, calls } = fakeGit({});
  assert.equal(comparisonBase({ workflowRef: CI, eventName: "pull_request", pullRequestBase: SHA }, git), SHA);
  assert.equal(
    comparisonBase({ workflowRef: CI, eventName: "pull_request", pullRequestBase: "--output=/tmp/x" }, git),
    "",
  );
  assert.deepEqual(calls, []);
});

test("tags and reusable calls compare against the previous release tag", () => {
  const { git, calls } = fakeGit({ "describe --tags --abbrev=0 --match v* HEAD^": "v0.19.0" });
  assert.equal(comparisonBase({ workflowRef: CI, eventName: "push", refType: "tag" }, git), "v0.19.0");
  assert.equal(
    comparisonBase({ workflowRef: HOTFIX, eventName: "pull_request", pullRequestBase: SHA }, git),
    "v0.19.0",
  );
  assert.equal(calls.length, 2);
});

test("pushes use the previous push and fall back to main for new or rewritten branches", () => {
  const known = fakeGit({
    [`rev-parse --verify --quiet ${SHA}^{commit}`]: SHA,
    "rev-parse --verify --quiet origin/main": "b".repeat(40),
  });
  const push = { workflowRef: CI, eventName: "push", refType: "branch" };
  assert.equal(comparisonBase({ ...push, pushBefore: SHA }, known.git), SHA);
  assert.equal(comparisonBase({ ...push, pushBefore: "0".repeat(40) }, known.git), "b".repeat(40));
  const rewritten = fakeGit({ "rev-parse --verify --quiet origin/main": "b".repeat(40) });
  assert.equal(comparisonBase({ ...push, pushBefore: "c".repeat(40) }, rewritten.git), "b".repeat(40));
});

test("the CLI classifies a real pull request diff into job flags", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "relmio-ci-changes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", [
    "-c", "user.name=CI", "-c", "user.email=ci@example.test", "-c", "commit.gpgsign=false", ...args,
  ], { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet");
  await writeFile(join(root, "README.md"), "one\n");
  git("add", ".");
  git("commit", "--quiet", "-m", "base");
  const base = git("rev-parse", "HEAD");
  await writeFile(join(root, "README.md"), "two\n");
  git("commit", "--quiet", "-am", "docs");

  const eventPath = join(root, "event.json");
  const outputPath = join(root, "output.txt");
  await writeFile(eventPath, JSON.stringify({ pull_request: { base: { sha: base } } }));
  main({
    GITHUB_EVENT_NAME: "pull_request",
    GITHUB_REF: "refs/pull/7/merge",
    GITHUB_WORKFLOW_REF: CI,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: outputPath,
  }, root);

  const output = Object.fromEntries((await readFile(outputPath, "utf8")).trim().split("\n")
    .map((line) => line.split(/=(.*)/su).slice(0, 2)));
  assert.equal(output.areas, "docs");
  assert.equal(output.run_root, "false");
  assert.equal(output.run_windows, "false");
  assert.equal(output.run_web, "true");
});
