# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is a non-technical Hostinger or other self-hosted VPS owner
who already runs n8n in Docker and wants guided access to a supported
ChatGPT/Codex OAuth relay. Technical evaluators and contributors are secondary
users of the hosted explanation, chat demo, source repository, and manual
documentation.

## Product Purpose

Relmio gives a VPS owner a local browser wizard that signs in on their own
computer, verifies the remote SSH host, discovers an existing n8n deployment,
shows an exact installation plan, and deploys a separate private
OpenAI-compatible sidecar. Success means the user completes the setup without
editing, rebuilding, recreating, stopping, or restarting their existing n8n
deployment.

## Positioning

Relmio is a safety-first relay setup experience, not an API-key generator or a
shared credential service. Its differentiator is the combination of a local
guided flow, explicit SSH host verification, read-only n8n discovery, a dry-run
plan, and a separate sidecar confined to the existing Docker network.

## Operating Context

Users start from the Relmio website, README, Curl bootstrap command, or NPX.
The local wizard runs on the user's computer and communicates with the target
VPS over SSH/SFTP. The hosted site separately offers a browser-extension-based
ChatGPT connection and request-bound chat demonstration. The current supported
installation path targets self-hosted n8n; broader OpenAI-compatible clients
remain a future direction.

## Capabilities and Constraints

- Keep the existing n8n Compose file, image, container, and workflows intact.
- Deploy only under `/docker/n8n-openai-oauth`.
- Never publish VPS host port `10531` or add a public proxy route.
- Require SSH host-key confirmation before authenticated connection.
- Require final human confirmation before any remote write.
- Never print, return, persist, or commit OAuth tokens, SSH passwords, or
  private keys.
- Preserve the operational `n8n-openai-oauth` names and paths for compatibility.
- Explain that the project is unofficial, experimental, and does not create an
  OpenAI Platform API key or bypass quotas, safeguards, account controls, or
  terms.

## Brand Commitments

The public name is Relmio. Preserve the checked-in Relmio mark and its meaning:
two lanes converging around a right-facing negative-space arrow. Relay teal
`#137c74`, midnight ink `#12211f`, signal tint `#e7f3f0`, and canvas `#f4f2ed`
are established brand colors that may be expanded into an accessible semantic
token system. Do not rotate, stretch, outline, recolor with provider branding,
or add gradients to the mark. The voice is plain, calm, transparent, and
beginner-friendly without hiding technical or legal risk.

## Evidence on Hand

- Product specification and safety model: `SPEC.md`
- Brand source and usage guidance: `docs/brand.md`
- Relmio mark: `docs/images/brand/relmio-mark.svg`
- Setup and successful-run screenshots: `docs/images/setup/` and
  `docs/images/examples/`
- Current hosted and local interfaces: `web/app/` and `src/ui/`
- Existing documentation and tested installation behavior: `README.md`,
  `npm/README.md`, and `docs/`

No customer logos, testimonials, performance benchmarks, or commercial claims
are available and none may be fabricated.

## Product Principles

- Make the safe action the clearest action.
- Show the exact boundary before asking for trust.
- Keep advanced details available without forcing beginners to decode them.
- Preserve user control at identity, host verification, plan review, and write
  confirmation boundaries.
- Prefer verifiable product behavior over marketing claims.

## Accessibility & Inclusion

Both interfaces must meet WCAG 2.1 AA, remain fully keyboard operable, support
screen readers, honor reduced-motion and system color preferences, and work
from 320px mobile viewports through large desktop screens. Copy must remain
understandable to users who do not already know Docker, SSH, OAuth, or sidecar
terminology.
