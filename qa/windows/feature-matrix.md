# Windows feature matrix

## Historical checkpoint, 2026-10-10

The table below records that checkpoint, not the final v0.22.1 release gate.
Later Help checks and current integration limits are recorded in
[the release-preparation note](README.md#v0221-release-preparation-2026-10-11).

Candidate: v0.22.0, main `2a112767aa857bf359d51db1b6f950b21a80c81b`, local branch `qa/windows-2026-10-10`, 2026-10-10. Tested checkout includes uncommitted CRLF and stopped-stack readiness fixes and native test-fixture portability fixes; this is not a release certification. Private evidence is outside the checkout.

| Area | Evidence-backed current result | Remaining coverage |
|---|---|---|
| CLI/dashboard/handoff | PASS native help/version, start/status/repeated start, stop/restart without restarting QA containers; private handoff in isolated Chrome; fresh tab dashboard API 401 | Foreground hosted/default-browser launch remains NOT-RUN |
| Native installer tests | PASS PowerShell/CMD fixtures, native Git Bash fixture, authentic installed/no-Node PS5.1 and CMD launch through real registry NPX to isolated Chrome; PS portable checksum/extraction and scoped cleanup/restore complete | Browser destination injected; actual default Explorer/manual console cancellation NOT-RUN. Piped TTY, self-checkout npm resolution, quoting and inherited PS7 module-path failures were harness issues. CMD terminal did not signal standalone Node control; exact QA leftovers reconciled |
| Root aggregate | PASS native gate: 1,823 total, 1,719 passed, 0 failed, 104 skipped | See skipped-tests.md; OS/container-only skips are not Windows passes |
| Web | PASS lint/types/Vinext tests (29)/Next build; production audit clean | Hosted browser routes not all exercised; 8 dev audit findings remain |
| New private n8n | PASS actual Windows install, ownership labels, loopback binding, healthz/editor owner form, eight-service dashboard inventory | Owner credentials, UI workflow editing and owner/project visibility BLOCKED |
| n8n node compatibility | PASS five real Docker workflows including HTTP APIs, agents + Calculator, chain and OpenAI Message through production Relmio handler | Provider/auth/lease are synthetic, so live SIWC acceptance is BLOCKED |
| Local model | PASS production Ollama/Qwen, private inference/automatic credential; real canonical chain `4`; real SSE content, first-content cancellation and normal-thinking follow-up `4` | Small model returned incorrect math answer with thinking disabled. Reasoning consumed a short output budget in first probe; neither empty completion nor wrong answer counts as PASS. Tool calling/Assistant not proven |
| UI | PASS reserved-port rejection, busy-action disabling, eight service cards, planner ZIP, 390px layout/theme/reload; actual Chrome notice matrix 34/34 (local/VPS, seven sizes, light/dark, keyboard/cancel/acknowledgment/failure states) | Notice account/API are synthetic, not complete live wizard/provider acceptance; remaining unrelated interactions NOT-RUN |
| ChatGPT/Codex | Existing human-authorized identity and plan permission verified; one approved bounded interactive text request completed with exact content and 33 reported tokens (23 input, 10 output) | Fresh first-grant default, background n8n, native clients, VPS and images remain unverified; no new grant or inference repeated |
| Images | BLOCKED separate Codex login/grants and approved usage | Generation/edit/restart/sign-out live checks NOT-RUN |
| SuperGrok | Existing isolated companion passes production healthy/ownership attestation; approval-gated official device-login handoff prepared | Installer failed without returning the one-time local client key. No credential extraction or duplicate install. Provider consent, models/inference and n8n client credential remain unverified |
| Assistant/SearXNG | PASS Compose generation only | Privileged sandbox implications need review before runtime activation; real search NOT-RUN |
| Ngrok/Gmail/Drive | BLOCKED approved owner/client and explicit grants; ngrok authentication unverified by status-only check | Google OAuth supports localhost without ngrok. External webhooks need approved path-restricted TLS/authenticated exposure; no tunnel/data operation performed |
| Recovery/update/removal | PASS actual QA n8n stopped/resume after readiness fix, exact identities preserved; repeated healthy resume rejected; dashboard restart; separate disposable stack production removal; UI review/cancel | Live provider/model updates and model cache deletion NOT-RUN; primary QA stack retained |
| Hostinger/VPS | Git-ignored QA metadata editor opened in VSCode; contents remain unread/private; POSIX/SSH boundaries tested with injected fixtures | No confirmed approved target/fingerprint/private credential; no live SSH or remote mutation; no VPS dotenv loader |
| Existing resources | PASS six existing containers match exact baseline at checkpoint5; all five mounted user volumes still exist | Recheck at final teardown; no prune/broad cleanup |

PASS applies only to the asserted observed path. Mark disabled acceptance branches NOT-RUN. Track BLOCKED, FAIL and EXPECTED-UNSUPPORTED separately. Preserve exact fixture resource IDs, screenshot paths, command logs and local diff in the private run report.
