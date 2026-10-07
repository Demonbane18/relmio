---
name: release-qa
description: Decide and record the release QA a Relmio candidate needs from the areas it changed since the last release tag. Covers the CI gate, the CodeRabbit gate, live Cua acceptance on the Hostinger VPS and local Docker n8n for touched areas only, Windows/macOS/Linux proof, and the PR evidence comment. Use before every Relmio release and before a merge that will ship.
---

# Release QA for Relmio

Run this after the candidate is final and before tagging. `ship` and
`release-relmio-everywhere` require it. Every area decides its own checks: a
change that cannot affect a feature does not re-test it.

## 1. Classify the candidate

From the repository root:

```sh
git fetch --tags origin
LAST=$(git tag --sort=-version:refname --list 'v*' | head -n 1)
node scripts/release-impact.mjs --base "$LAST" --head <candidate-commit> --format json
```

`scripts/release-impact.mjs` holds the only path-to-area table. Read `areas`,
`docs_only`, `web_only`, the `run_*` flags and `unknown`. An unmapped path
classifies as `root`, which runs every check below. If `unknown` is not
empty, add rules for those paths in the same PR; until then, treat the
release as `root`.

## 2. CI gate

The required check is `CI gate` on the PR head and on the merged `main`
commit. It must be green. Pushes to `main`, `v*` tags and the publish/hotfix
`workflow_call` always run every job, so the post-merge run is the full proof.

Open the `CI gate` summary and confirm each job ran or was skipped for the
reason the flags give:

| Job | Runs when | Proves |
| --- | --- | --- |
| `quality` | `run_root` | Linux (ubuntu-latest): lint, release metadata, root tests, production audit, package preview |
| `docs-checks` | `run_root` is false | lint, release metadata, and the tests that read the README, changelog and docs |
| `web-quality` | `run_web` | hosted web lint, types, build, blocking production audit |
| `windows-bootstrap` | `run_windows` | Windows: native installer, PowerShell 5.1, CMD, browser wizard, loopback SIWC |
| `macos` | `run_macos` | macOS: root checks, POSIX installer, foreground wizard start |
| `linux` | `run_linux` | Linux: root checks, `install.sh`, foreground wizard start |
| `n8n-nodes` | `run_n8n_nodes` | n8n 2.40.7 nodes against the real sidecar handler and a mock upstream |

Windows and macOS are proven by their CI jobs alone. Linux is proven by the
`quality`, `linux` and `n8n-nodes` jobs on ubuntu-latest plus the live checks
on the Hostinger VPS, which runs Ubuntu. A skipped OS job is acceptable only when
`docs_only` or `web_only` is true.

## 3. CodeRabbit gate

CodeRabbit reviews every PR to `main` (config in `.coderabbit.yaml`). Before
merging:

- CodeRabbit has reviewed the latest PR head commit;
- every CodeRabbit thread is resolved, either fixed or answered with a reason;
- no CodeRabbit "changes requested" review is outstanding.

When the CodeRabbit CLI is installed and signed in, run
`coderabbit review --agent --base main` locally before pushing and fix what it
finds. This is optional and never replaces the PR review.

## 4. Live acceptance

Every release runs live checks for the areas it touched, whether it is a
patch, minor or major release. A release whose areas are only `web` and
`docs` (`web_only` true) needs no live checks. Use the n8n workflow
"Relmio release acceptance" (`qa/acceptance/relmio-release-acceptance.json`).
It is the standard QA workflow for every self-hosted n8n: the Hostinger VPS,
a local Docker n8n or any other setup. Search the target n8n for it first and
reuse the copy that is there; never import a second copy. Update it in place
when its `acceptanceVersion` is missing or older than the repository file, and create
it only when that n8n has none (steps in `qa/acceptance/README.md`). It stays
inactive; run it with **Execute workflow** and open each node's output. A node
passes only when its output shows the expected text. Use the statuses from the
`smoke-test-evidence` skill (PASS, EXPECTED-UNSUPPORTED, FAIL, BLOCKED,
NOT-RUN). Before running, set the `Settings` node's `model` to a model that
the wizard's **Check installed account** shows as Ready (default
`gpt-6-astra`), and `sidecarBaseUrl` where that n8n reaches the sidecar at
another address.

| Area touched | Where | Checks |
| --- | --- | --- |
| `sidecar`, `siwc-auth`, `vps` | Hostinger VPS n8n | Run the acceptance workflow. Read HTTP Request: Responses, HTTP Request: Chat Completions, AI Agent, Basic LLM Chain, OpenAI: Message a Model, and OpenAI: Generate an Image when the image add-on is on. In the n8n AI Assistant, send "Reply with OK" and one question that makes it use a tool. |
| `sidecar` with a runtime change | Hostinger VPS, Relmio wizard | Walk through **Review sidecar update** and apply it only after the owner's final confirmation. Then rerun the workflow. |
| `siwc-auth` | Relmio wizard | Exercise the ChatGPT sign-in refresh path, then rerun one text node. |
| `local-docker`, `sidecar` | Local Docker n8n | Run the same acceptance workflow and read the same nodes. There is no image add-on locally. |
| `local-model` | VPS and local Docker n8n | Read Local Model Chain on both. |
| `assistant` | Hostinger VPS n8n | The two AI Assistant messages above. |
| `wizard-ui` | Isolated Chrome | Wizard QA per `relmio-isolated-chrome-qa`, never the owner's browser. The main agent supplies that skill's text to the release run. |
| `web` or `docs` only | none | No live acceptance. CI plus a check of the Vercel preview. |
| `qa/acceptance/` changed | Hostinger VPS n8n | Update the existing workflow in place (README steps) and run it once, reading every node it changed, even when no other area is touched. |
| `installers`, `packaging`, `hosting`, `supergrok`, `ci` | none | CI jobs above and the `release-relmio-everywhere` audit matrix. |
| `root` | all of the above | Every row that applies to the installed targets. |

A check that cannot run because an add-on is not installed is NOT-RUN with
that reason, never PASS.

### Safety during live checks

Cua drives the owner's Opera GX, so the `opera-gx-guard` rules apply:

- Before browser work run `memory_pressure -Q`; below 25% free, stop and
  report.
- Run `opera-gx.sh status` before the first Cua action and again about every
  five actions. WARN pauses for the owner; STOP ends the session.
- Read the address bar before each click. Tab titles mislead.
- Never press Opera's toolbar or menus (Back, Forward, Reload, menu bar). Act
  only inside page content.
- Close the Cua session when the checks end, and at once if the owner reports
  a freeze.

Every VPS write, including a sidecar update, still needs the owner's final
confirmation. Never restart, rebuild or stop n8n. Never open credential
dialogs in screenshots or print a bearer.

One workflow run spends six text requests from the ChatGPT plan and one Codex
image request when the image add-on is on. Each AI Assistant message adds one
or two requests. State the total in the evidence.

## 5. Evidence

Post this as a PR comment, filled in from what was observed. Leave nothing as
assumed; a check without evidence is NOT-RUN.

```markdown
## Release QA: v<version> (<YYYY-MM-DD>)

Candidate: <commit>  Compared with: <last tag>
Areas: <areas from release-impact>  Unmapped paths: <none or list>

### CI
- CI gate: <pass/fail> <run link>
- Jobs: quality <ran/skipped>, web-quality <...>, windows-bootstrap <...>,
  macos <...>, linux <...>, n8n-nodes <...>
- Post-merge main run: <run link or pending>

### CodeRabbit
- Reviewed head <commit>: <yes/no>; open threads: <0 or count>

### Live acceptance
| Check | Target | Result | Screenshot |
| --- | --- | --- | --- |
| HTTP Request: Responses | VPS | PASS | relmio-qa-v<version>-vps-http-responses-<date>.png |
| ... | | | |

Plan usage: <n> text requests, <n> image requests.

### Skipped
- <check>: <reason, e.g. area not touched, add-on not installed>
```

Name screenshots `relmio-qa-v<version>-<target>-<check>-<YYYY-MM-DD>.png` and
store them as the `smoke-test-evidence` skill describes, outside the public
repository. Crop out other tabs, account details and secrets.
