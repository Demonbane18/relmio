#!/usr/bin/env node
// Classifies changed repository paths into release areas so CI and release QA
// run only the checks a change can affect. No dependencies. The rule table below
// is the single source of truth; the first matching rule wins. A path no rule
// matches maps to `root`, which runs everything.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const AREAS = ["root", "web", "docs", "installers", "wizard-ui", "sidecar", "siwc-auth",
  "vps", "local-docker", "local-model", "supergrok", "assistant", "hosting", "packaging", "ci"];

export const RULES = [
  // Repository tooling, release process and tests.
  [/^AGENTS\.md$/u, ["ci"]],
  [/^\.agents\/skills\/(ship|release-relmio-everywhere|release-qa|changelog)\//u, ["ci", "root"]],
  [/^\.agents\/skills\/(installer-reliability|maintain-relmio-installers)\//u, ["ci", "installers"]],
  [/^\.agents\//u, ["ci"]],
  [/^(\.github|scripts)\//u, ["ci", "root"]],
  [/^(package\.json|package-lock\.json|\.npmrc|\.gitattributes)$/u, ["ci", "root"]],
  [/^(\.gitignore|\.coderabbit\.yaml)$/u, ["ci"]],
  [/^test\/integration\/n8n-nodes\//u, ["ci", "sidecar"]],
  [/^(test|dev|qa)\//u, ["ci"]],

  // Documentation. LICENSE and NOTICE ship in the npm package.
  [/^(LICENSE|NOTICE)$/u, ["docs", "packaging"]],
  [/^[^/]+\.md$/u, ["docs"]],
  [/^npm\/README\.md$/u, ["docs"]],
  [/^(docs|design-system|tasks|\.impeccable|\.hallmark)\//u, ["docs"]],

  // Hosted website and the installers it serves.
  [/^web\/public\/install\./u, ["installers"]],
  [/^web\//u, ["web"]],
  [/^Start Wizard\.(bat|command)$/u, ["installers"]],
  [/^packaging\//u, ["packaging"]],

  // Local browser wizard. The UI kit, fonts and icons are copied into web/.
  [/^src\/ui\/(relmio-ui\.css|fonts\/|relmio-icon)/u, ["wizard-ui", "web"]],
  [/^src\/ui\/hosting/u, ["wizard-ui", "hosting"]],
  [/^src\/ui\/local-model-vps/u, ["wizard-ui", "local-model", "vps"]],
  [/^src\/ui\/supergrok-vps/u, ["wizard-ui", "supergrok", "vps"]],
  [/^src\/ui\/assistant/u, ["wizard-ui", "assistant"]],
  [/^src\/ui\/(siwc|oauth-popup)/u, ["wizard-ui", "siwc-auth"]],
  [/^src\/ui\//u, ["wizard-ui"]],
  [/^src\/services\/(ui-preferences|project-meta)\.js$/u, ["wizard-ui"]],

  // Entry points and shared validation reach every feature.
  [/^src\/(cli\.js|web\/server\.js)$/u, ["root"]],
  [/^src\/domain\/(safety|validation|provider-lifecycle)\.js$/u, ["root"]],
  [/^src\/legacy-vps-cli\.js$/u, ["vps"]],
  [/^src\/(browser\.js|services\/browser-handoff\.js)$/u, ["installers"]],
  [/^src\/infrastructure\/(local-process|process-identity)\.js$/u, ["local-docker", "installers"]],

  // ChatGPT sidecar, its image files and SIWC sign-in.
  [/^src\/gateway\//u, ["sidecar"]],
  [/^src\/services\/(model-discovery|codex-images)\.mjs$/u, ["sidecar"]],
  [/^src\/(domain\/templates|domain\/vps-build-state|services\/installer)\.js$/u, ["vps", "sidecar"]],
  [/^src\/(domain\/local-n8n-sidecar|services\/local-n8n-sidecar-installer)\.js$/u, ["sidecar", "local-docker"]],
  [/^src\/domain\/codex-images\.js$/u, ["vps", "sidecar", "local-docker"]],
  [/^src\/services\/(siwc-|oauth\.js|codex-login\.js|local-chat-test\.js)/u, ["siwc-auth"]],
  [/^src\/domain\/local-endpoints\.js$/u, ["siwc-auth"]],
  [/^src\/services\/local-installer\.js$/u, ["local-docker", "siwc-auth", "supergrok"]],

  // Local model.
  [/^src\/(domain\/local-n8n-model|domain\/local-model-network|services\/local-n8n-model-installer)\.js$/u, ["local-model", "local-docker"]],
  [/^src\/services\/vps-local-model\.js$/u, ["local-model", "vps"]],
  [/^src\/local-model\//u, ["local-model"]],

  // SuperGrok.
  [/^src\/(domain\/local-n8n-supergrok|services\/local-n8n-supergrok-installer)\.js$/u, ["supergrok", "local-docker"]],
  [/^src\/services\/vps-supergrok\.js$/u, ["supergrok", "vps"]],
  [/^src\/(supergrok\/|services\/grok-login\.js)/u, ["supergrok"]],

  // n8n AI Assistant.
  [/^src\/(domain\/local-n8n-assistant|services\/local-n8n-assistant-installer)\.js$/u, ["assistant", "local-docker"]],
  [/^src\/(domain\/assistant|domain\/assistant-templates|services\/assistant-installer)\.js$/u, ["assistant", "vps"]],

  // Local Docker stack and dashboard.
  [/^src\/(domain\/local-n8n-stack|services\/local-n8n-stack-installer)\.js$/u, ["local-docker"]],
  [/^src\/templates\/local-n8n-stack\//u, ["local-docker"]],
  [/^src\/services\/(local-dashboard|local-dashboard-control|local-integration-lifecycle-lock)\.js$/u, ["local-docker"]],

  // Hosting profiles and VPS access.
  [/^src\/domain\/hosting-/u, ["hosting"]],
  [/^src\/(infrastructure\/ssh|services\/vps-operation-lock|services\/discovery)/u, ["vps"]],
];

export function areasForPath(path) {
  return RULES.find(([pattern]) => pattern.test(path))?.[1];
}

export function classifyPaths(paths) {
  const areas = new Set();
  const unknown = [];
  for (const path of paths) {
    const matched = areasForPath(path);
    if (matched) {
      matched.forEach((area) => areas.add(area));
    } else {
      areas.add("root");
      unknown.push(path);
    }
  }
  // An empty change list usually means a wrong base; run everything.
  if (paths.length === 0) areas.add("root");
  const sorted = [...areas].sort();
  return {
    areas: sorted,
    docsOnly: sorted.every((area) => area === "docs"),
    webOnly: sorted.every((area) => area === "web" || area === "docs"),
    unknown,
  };
}

export function runFlags({ areas, docsOnly, webOnly }) {
  const has = (...names) => names.some((name) => areas.includes(name));
  const runRoot = !(docsOnly || webOnly);
  return {
    run_root: runRoot,
    run_web: has("root", "web", "docs", "installers"),
    run_windows: runRoot,
    run_macos: runRoot,
    run_linux: runRoot,
    run_n8n_nodes: has("root", "sidecar", "siwc-auth", "assistant"),
  };
}

export function formatGithubOutput(result) {
  const lines = [
    `areas=${result.areas.join(",")}`,
    `docs_only=${result.docsOnly}`,
    `web_only=${result.webOnly}`,
    ...Object.entries(runFlags(result)).map(([name, value]) => `${name}=${value}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function formatSummary(result, { base, head }) {
  const rows = Object.entries(runFlags(result)).map(([name, value]) => `| \`${name}\` | ${value} |`);
  const unknown = result.unknown.length
    ? `\nUnmapped paths (classified as \`root\`, so everything runs):\n\n${result.unknown.map((path) => `- \`${path}\``).join("\n")}\n`
    : "";
  return [
    "## Release impact",
    "",
    `Compared \`${base}...${head}\`. Areas: ${result.areas.map((area) => `\`${area}\``).join(", ")}.`,
    "",
    "| Flag | Value |",
    "| --- | --- |",
    `| \`docs_only\` | ${result.docsOnly} |`,
    `| \`web_only\` | ${result.webOnly} |`,
    ...rows,
    unknown,
  ].join("\n");
}

export function changedPaths(base, head, { cwd = process.cwd() } = {}) {
  const output = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", `${base}...${head}`], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return output.split("\0").filter(Boolean);
}

function parseArgs(argv) {
  const options = { head: "HEAD", format: "json" };
  for (let index = 0; index < argv.length; index += 2) {
    const [flag, value] = [argv[index], argv[index + 1]];
    if (!["--base", "--head", "--format"].includes(flag) || value === undefined) {
      throw new Error(`Unknown or incomplete option: ${flag}`);
    }
    options[flag.slice(2)] = value;
  }
  if (!options.base) throw new Error("--base <ref> is required");
  if (!["json", "github"].includes(options.format)) throw new Error("--format must be json or github");
  return options;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const { base, head, format } = parseArgs(argv);
  const paths = changedPaths(base, head);
  const result = classifyPaths(paths);
  if (format === "json") {
    process.stdout.write(`${JSON.stringify({ ...result, ...runFlags(result), paths }, null, 2)}\n`);
    return;
  }
  const output = formatGithubOutput(result);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${formatSummary(result, { base, head })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`release-impact: ${error.message}\n`);
    process.exitCode = 1;
  }
}
