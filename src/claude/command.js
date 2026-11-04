import { userInfo } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";

import { prepareClaudeCompanion } from "./companion.js";
import { CANDIDATE_VERSION, readKeyHashFile, runClaudeChat } from "./launcher.js";
import { MAX_APPROVAL_HOURS, initLocalClaude, prepareLocalClaude } from "./local.js";

export const DEFAULT_CLAUDE_MODELS = Object.freeze(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
export const CLAUDE_DISCLAIMER = Object.freeze([
  "Experimental. Not affiliated with or endorsed by Anthropic.",
  "Uses the official Claude Code CLI that you install and sign in to yourself. Relmio never opens, copies, refreshes or sends your Claude credentials.",
  "For your own personal use only. Do not share it or offer it to others as a service.",
  "Anthropic's terms and usage policies apply. Anthropic may change or block this at any time.",
  "Uses your plan limits, shared with other Claude apps. claude -p may use the 5-hour window faster than interactive Claude Code.",
  "Turn extra usage off. Relmio refuses Fable models, but extra-usage billing is your account's setting.",
  "Text only: no tools, AI Agent tools, n8n AI Assistant, Responses API or images. One request at a time.",
]);
const HELP = Object.freeze([
  "Usage: relmio claude <serve|local init|local prepare|companion prepare> [options]",
  `Experimental owner-only adapter for the official Claude Code CLI ${CANDIDATE_VERSION} on macOS and Linux.`,
  "  serve [--config <launch.json> --key-hash-file <key.sha256>]",
  "      Run the adapter. Without options it reads RELMIO_CLAUDE_LAUNCH_CONFIG and RELMIO_CLAUDE_CHAT_TOKEN_SHA256.",
  "  local init <dir> --claude <path>",
  "      Create a private folder for one dedicated Claude login and print the sign-in commands.",
  `  local prepare <dir> --claude <path> [--model <id>]... [--hours <1-${MAX_APPROVAL_HOURS}>]`,
  "      Ask the review questions, then write launch.json and the access key. Approval lasts 1 hour by default.",
  "  companion prepare <dir> --network <name> [--arch amd64|arm64] [--model <id>]...",
  "      Ask the review questions, then write a Docker companion bundle for n8n's network to an empty folder. Default arch amd64.",
  `  Default models: ${DEFAULT_CLAUDE_MODELS.join(" ")}`,
]);
const MANIFEST = `https://downloads.claude.ai/claude-code-releases/${CANDIDATE_VERSION}/manifest.json`;
const N8N_SETTINGS =
  "In the OpenAI Chat Model, turn Use Responses API off and set Max Retries 0 and Timeout to at least 135000 ms. Set the Basic LLM Chain Batch Size to 1.";
const USAGE_ERROR = "Unknown Relmio claude command. Run relmio claude --help.";
const COMMANDS = Object.freeze({
  serve: { options: { config: { type: "string" }, "key-hash-file": { type: "string" } } },
  "local init": { directory: true, required: "claude", options: { claude: { type: "string" } } },
  "local prepare": {
    directory: true, required: "claude",
    options: { claude: { type: "string" }, model: { type: "string", multiple: true }, hours: { type: "string" } },
  },
  "companion prepare": {
    directory: true, required: "network",
    options: { network: { type: "string" }, arch: { type: "string" }, model: { type: "string", multiple: true } },
  },
});

export function parseClaudeArguments(argumentsList) {
  if (argumentsList.length === 1 && ["--help", "-h"].includes(argumentsList[0])) return { command: "help" };
  const command = argumentsList[0] === "serve" ? "serve" : argumentsList.slice(0, 2).join(" ");
  if (!Object.hasOwn(COMMANDS, command)) throw new Error(USAGE_ERROR);
  const { directory, required, options } = COMMANDS[command];
  let parsed;
  try {
    parsed = parseArgs({ args: argumentsList.slice(command.split(" ").length), options, allowPositionals: true, strict: true });
  } catch {
    throw new Error(USAGE_ERROR);
  }
  if (parsed.positionals.length !== (directory ? 1 : 0) || (required && parsed.values[required] === undefined)) {
    throw new Error(USAGE_ERROR);
  }
  return { command, directory: parsed.positionals[0], ...parsed.values };
}

// Shell-safe single quoting for printed commands; paths often contain spaces.
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Any failure to read an answer, including Control+C, counts as No.
async function askTerminal(question) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  const cancel = new AbortController();
  terminal.once("SIGINT", () => cancel.abort());
  try {
    return await terminal.question(question, { signal: cancel.signal });
  } catch {
    return "";
  } finally {
    terminal.close();
  }
}

function logDisclaimer(log) {
  for (const line of CLAUDE_DISCLAIMER) log(line);
  log("");
}

async function serve(request, { env, log, startLauncher, readKeyHash }) {
  if ((request.config === undefined) !== (request["key-hash-file"] === undefined)) {
    throw new Error("Use --config and --key-hash-file together.");
  }
  const launchEnv = request.config === undefined
    ? {
      RELMIO_CLAUDE_LAUNCH_CONFIG: env.RELMIO_CLAUDE_LAUNCH_CONFIG,
      RELMIO_CLAUDE_CHAT_TOKEN_SHA256: env.RELMIO_CLAUDE_CHAT_TOKEN_SHA256,
    }
    : {
      RELMIO_CLAUDE_LAUNCH_CONFIG: resolve(request.config),
      RELMIO_CLAUDE_CHAT_TOKEN_SHA256: await readKeyHash(resolve(request["key-hash-file"])),
    };
  await startLauncher({ env: launchEnv, argv: [], log });
  log("Press Control+C to stop.");
  return 0;
}

async function localInit(request, { log, initLocal }) {
  const setup = await initLocal({ directory: request.directory, executable: request.claude });
  const user = userInfo().username;
  logDisclaimer(log);
  log(`${setup.directory} is ready for one dedicated Claude login. No approval was written yet.`);
  log(`Claude Code: ${setup.executable}`);
  log(`SHA256: ${setup.executableSha256}`);
  log(`Check that SHA256 against ${MANIFEST} for your platform before you run this binary.`);
  log("");
  log("Next steps:");
  log("- Sign in once with this folder's own Claude config, not your everyday Claude login:");
  log(
    `  cd ${quote(join(setup.accountRoot, "empty"))} && env -i TERM="$TERM" HOME=${quote(setup.home)} USER=${quote(user)} ` +
      `LOGNAME=${quote(user)} CLAUDE_CONFIG_DIR=${quote(join(setup.accountRoot, "config"))} ` +
      `PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=/tmp ${quote(setup.executable)} auth login`,
  );
  log("- Run the same command with auth status instead of auth login. It must show loggedIn true and authMethod claude.ai.");
  log(`- Then answer the review questions: relmio claude local prepare ${quote(setup.directory)} --claude ${quote(setup.executable)}`);
  return 0;
}

// Every item defaults to No; the first answer other than y or yes stops the review.
async function confirmReview(summary, questions, { log, ask }) {
  for (const line of summary) log(line);
  log("Answer y to confirm each item. Any other answer stops without writing anything.");
  for (const question of questions) {
    if (!/^y(?:es)?$/iu.test(String((await ask(`${question} [y/N] `)) ?? "").trim())) return false;
  }
  return true;
}

async function localPrepare(request, context) {
  const { log, prepareLocal } = context;
  logDisclaimer(log);
  const result = await prepareLocal({
    directory: request.directory,
    executable: request.claude,
    models: request.model ?? [...DEFAULT_CLAUDE_MODELS],
    hours: request.hours === undefined ? 1 : /^\d{1,3}$/u.test(request.hours) ? Number(request.hours) : Number.NaN,
    confirm: (review) => confirmReview([
      `Review for ${review.directory}:`,
      `  Claude Code ${review.version}: ${review.executable}`,
      `  SHA256: ${review.executableSha256}`,
      `  Models: ${review.models.join(", ")}`,
      `  Approval: ${review.hours} hour${review.hours === 1 ? "" : "s"} from your answers`,
    ], [
      `Is this the official Claude Code ${review.version} binary, with the SHA256 above matching ${MANIFEST} for this platform?`,
      "Have you reviewed this computer's effective Claude Code policy (managed settings, MDM, policy helpers, managed MCP servers and hooks) and found nothing that runs commands, adds tools or changes sign-in or models?",
      "Did auth status for this folder's own login show loggedIn true and authMethod claude.ai on your own plan, with these models and extra usage turned off?",
      "Will you keep that policy, login and billing unchanged while the approval lasts and run this command again after any change?",
    ], context),
  });
  if (!result) {
    log("Not approved. Nothing was written.");
    return 1;
  }
  log("");
  log(`Wrote ${result.launchPath}, approved until ${result.expiresAt}.`);
  log(result.keyPath
    ? `Wrote the access key to ${result.keyPath} and its hash to ${result.keyHashPath}.`
    : `Kept the existing access key (${result.keyHashPath}).`);
  log("");
  log("Next steps:");
  log(
    `- Start the adapter, or restart it if it is running: relmio claude serve --config ${quote(result.launchPath)} ` +
      `--key-hash-file ${quote(result.keyHashPath)}`,
  );
  if (result.keyPath) {
    log("- In n8n on this computer, create an OpenAI credential with Base URL http://127.0.0.1:14502/v1 and the text in n8n-api-key.txt as API Key. Then delete n8n-api-key.txt.");
  }
  log(`- ${N8N_SETTINGS}`);
  log(`- Before ${result.expiresAt}, run relmio claude local prepare again to re-confirm.`);
  return 0;
}

// The companion signs in only after it starts, so its login item reviews the account it will use.
async function companionPrepare(request, context) {
  const { log, prepareCompanion } = context;
  logDisclaimer(log);
  const result = await prepareCompanion({
    directory: request.directory,
    network: request.network,
    arch: request.arch ?? "amd64",
    models: request.model ?? [...DEFAULT_CLAUDE_MODELS],
    confirm: (review) => confirmReview([
      `Review for ${review.directory} on Docker network ${review.network}:`,
      `  Claude Code ${review.version} for ${review.platform}: ${review.executable} in the image, checked by the Dockerfile during docker compose build`,
      `  SHA256: ${review.executableSha256}`,
      `  Models: ${review.models.join(", ")}`,
      "  Approval: 7 days minus 1 hour from your answers",
    ], [
      `Is this the official Claude Code ${review.version} binary for ${review.platform}, with the SHA256 above matching ${MANIFEST}?`,
      "Have you reviewed the effective Claude Code policy for the companion on that Docker host (managed settings, policy helpers, managed MCP servers and hooks) and found nothing that runs commands, adds tools or changes sign-in or models?",
      "Will the companion sign in with sh login.sh to your own plan, with these models and extra usage turned off, and will you check that auth status shows loggedIn true and authMethod claude.ai before any prompt?",
      "Will you keep that policy, login and billing unchanged while the approval lasts and prepare a new bundle after any change?",
    ], context),
  });
  if (!result) {
    log("Not approved. Nothing was written.");
    return 1;
  }
  log("");
  log(`Prepared ${result.directory} for Docker network ${result.network} (${result.arch}); models: ${result.models.join(", ")}.`);
  log(`launch.json records your answers until ${result.expiresAt}. Relmio does not check them.`);
  log("");
  log("Next steps:");
  log("- On the managed VPS, use only /docker/n8n-openai-oauth/claude. Confirm the SSH host key and the exact files to write before copying the whole bundle, including .env.");
  log("- On the Docker host, as root, in the bundle folder: chown 10001:10001 launch.json && chmod 0600 launch.json");
  log("- docker compose build && docker compose up -d");
  log("- sh login.sh for the one-time Claude sign-in inside the companion. Check its auth status before any prompt.");
  log("- In n8n, create an OpenAI credential with Base URL http://relmio-claude:14502/v1 and the text in n8n-api-key.txt as API Key. Then delete every copy of n8n-api-key.txt.");
  log(`- ${N8N_SETTINGS}`);
  log(`- Before ${result.expiresAt}, run sh renew.sh on the Docker host.`);
  return 0;
}

export async function runClaudeCommand({
  argumentsList,
  env = process.env,
  log = console.log,
  isInteractive = () => false,
  ask = askTerminal,
  platform = process.platform,
  startLauncher = runClaudeChat,
  readKeyHash = readKeyHashFile,
  initLocal = initLocalClaude,
  prepareLocal = prepareLocalClaude,
  prepareCompanion = prepareClaudeCompanion,
} = {}) {
  const request = parseClaudeArguments(argumentsList);
  if (request.command === "help") {
    for (const line of [...HELP, ...CLAUDE_DISCLAIMER]) log(line);
    return 0;
  }
  if (platform !== "darwin" && platform !== "linux") throw new Error("relmio claude runs on macOS and Linux only.");
  if (request.command.endsWith(" prepare") && !isInteractive()) {
    log(`relmio claude ${request.command} needs an interactive terminal for the review questions. Nothing was written.`);
    return 1;
  }
  const context = { env, log, ask, startLauncher, readKeyHash, initLocal, prepareLocal, prepareCompanion };
  if (request.command === "serve") return await serve(request, context);
  if (request.command === "local init") return await localInit(request, context);
  if (request.command === "local prepare") return await localPrepare(request, context);
  return await companionPrepare(request, context);
}
