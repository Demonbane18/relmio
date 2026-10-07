#!/usr/bin/env node
// Decides which CI jobs run (the `changes` job in ci.yml). Release tags,
// reusable calls from hotfix.yml and pushes to main run everything. Otherwise
// release-impact.mjs classifies the diff against the pull request base or the
// previous push. A missing or unusable base runs everything.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { changedPaths, classifyPaths, formatSummary, runFlags } from "./release-impact.mjs";

const COMMIT = /^[0-9a-f]{40}$/u;

// In a reusable workflow GitHub reports the caller's workflow ref.
function isReusableCall({ workflowRef }) {
  return !String(workflowRef ?? "").includes("/.github/workflows/ci.yml@");
}

export function forcedReason(context) {
  if (isReusableCall(context)) return "Reusable workflow call, so everything runs.";
  if (context.refType === "tag") return "Release tag, so everything runs.";
  if (context.eventName === "push" && context.ref === "refs/heads/main") {
    return "Push to main, so everything runs.";
  }
  return "";
}

/** `git(args)` returns trimmed stdout, or "" when git fails. */
export function comparisonBase(context, git) {
  if (isReusableCall(context) || context.refType === "tag") {
    return git(["describe", "--tags", "--abbrev=0", "--match", "v*", "HEAD^"]);
  }
  if (context.eventName === "pull_request") {
    return COMMIT.test(context.pullRequestBase ?? "") ? context.pullRequestBase : "";
  }
  const before = context.pushBefore ?? "";
  if (COMMIT.test(before) && !/^0+$/u.test(before)) {
    const known = git(["rev-parse", "--verify", "--quiet", `${before}^{commit}`]);
    if (known) return known;
  }
  return git(["rev-parse", "--verify", "--quiet", "origin/main"]);
}

/** `paths` is null when no comparison base exists. */
export function decideJobs({ forced, paths }) {
  const result = classifyPaths(paths ?? []);
  const everything = runFlags(classifyPaths([]));
  const reason = forced || (paths
    ? `Changed areas: ${result.areas.join(", ")}.`
    : "No comparison base was found, so everything runs.");
  return { result, reason, flags: forced ? everything : runFlags(result) };
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

export function main(env = process.env, cwd = process.cwd()) {
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  const context = {
    eventName: env.GITHUB_EVENT_NAME,
    ref: env.GITHUB_REF,
    refType: env.GITHUB_REF_TYPE,
    workflowRef: env.GITHUB_WORKFLOW_REF,
    pullRequestBase: event.pull_request?.base?.sha,
    pushBefore: event.before,
  };
  const base = comparisonBase(context, (args) => git(args, cwd));
  const paths = base ? changedPaths(base, "HEAD", { cwd }) : null;
  const { result, reason, flags } = decideJobs({ forced: forcedReason(context), paths });
  const output = [
    `areas=${result.areas.join(",")}`,
    `reason=${reason}`,
    ...Object.entries(flags).map(([name, value]) => `${name}=${value}`),
  ].join("\n");
  const summary = `${base ? formatSummary(result, { base, head: "HEAD" }) : "## Release impact\n"}\n${reason}\n`;
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${output}\n`);
  else process.stdout.write(`${output}\n`);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, summary);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
