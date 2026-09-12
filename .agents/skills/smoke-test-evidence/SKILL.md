---
name: smoke-test-evidence
description: Capture and report Relmio browser-test evidence when screenshots or a test report are requested.
---

# Smoke test evidence

Use this workflow for requested Relmio screenshot or test-report evidence. Follow the current project's browser and mutation boundaries. For Relmio use Opera GX and communicate in English.

For ordinary browser QA, report observed results inline. Save or upload evidence
only when requested or required by the acceptance criteria; do not infer a Drive
destination from a request for a local report.

## Establish the run

- Identify the dedicated test workflow, environment, candidate version if known, and actions to check. Distinguish VPS, local Docker, and automated code tests.
- Follow the user's current operating mode. In guided mode, the user clicks and executes; the assistant reads results and captures evidence. A request to capture or report does not restore earlier permission to run tests autonomously.
- In agent-operated QA, continue authorized checks, fixes, and affected reruns until acceptance criteria pass or an external/user decision is required. Honor explicit pauses; reporting alone does not authorize new executions or fixes.
- Reuse verified results, stating their provenance. Do not rerun costly requests solely to create an attractive report. If a fresh run is needed, label it as new.
- Use public or synthetic fixtures matching the input type. A JPEG is not an audio fixture. Confirm the actual downloaded filename, MIME type, size, and binary field before testing the downstream node.
- Use synthetic IDs for destructive-operation boundary tests. Never substitute an existing real resource to get past client validation.

## Verify each result

Read the current UI and identify the executed operation, input, and resulting output. n8n can retain old output after changing an operation; a renamed node alone is not evidence of a new execution.

Classify each action separately:

| Status | Meaning |
|---|---|
| PASS | Execution succeeded and the output met the test assertion |
| EXPECTED-UNSUPPORTED | The request reached the bridge and returned the expected capability error |
| FAIL | Observed behavior contradicted the intended supported behavior |
| BLOCKED | Client validation, missing model, authentication, or setup prevented the intended check |
| NOT-RUN | No execution evidence exists |

Do not classify all HTTP errors as failures or all expected errors as working features. A successful health check does not prove model access. Validate content as well as status: inspect edited images, parse JSON text when relevant, and distinguish prompt-requested JSON from schema-enforced output.

## Capture evidence

- Capture with the available computer-use screenshot tool. A screen-context read verifies visible state but does not prove a screenshot was persisted or uploaded.
- Save captures in temporary staging outside public source. Name deliverables consistently, for example `08-translate-recording-EXPECTED-UNSUPPORTED.png`.
- Crop to the operation, relevant input, and result/error details. Exclude unrelated tabs, desktop apps, secrets, and account details. Retain enough context to interpret the result.
- Use deterministic cropping or opaque redaction when needed, never generative image editing. Inspect the final crop for readability and missing evidence before uploading. Do not reuse fixed crop coordinates without checking the current screenshot size and layout.
- Preserve the distinction between an observed run with no saved screenshot and one with archived screenshot evidence.

## Store and report

Use the Google Drive skill and connector for a requested Drive destination. In Relmio sessions the owner's preferred layout is `Relmio/<date - environment - test run>`. Find an existing matching folder before creating one; do not hardcode personal folder IDs into this reusable skill.

Upload only relevant cropped evidence and the report. Preserve sharing permissions. After a timeout or interrupted upload, list the destination before retrying to avoid duplicates. Read back uploaded files before claiming delivery or presenting their links.

Write a concise Markdown report with date/environment, one row per requested action, input/expected/actual result, screenshot reference or explicit gap, and remaining tests. Include fixture sources. Separate local checks from live acceptance and environment-specific results. Keep private evidence and account-specific reports outside public repository and npm artifacts.

Finish with verified artifact links when artifacts were requested, and any unresolved checks. If all requested checks are complete, state completion without inventing a follow-up. Never claim every action passed when some are blocked or untested. If paused, preserve the latest result, evidence destination, upload state, and next safe action without executing more tests.
