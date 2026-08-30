# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Relmio serves people running AI tools on their own computers or compatible self-hosted Docker infrastructure. The primary web audience is a technical builder evaluating Relmio before launching its local wizard, plus self-hosted n8n operators who need a guided companion setup without risking their existing deployment.

## Product Purpose

Relmio provides private, explicitly bounded paths between a user's own provider credentials and the AI tools they operate. The hosted web app explains those paths, offers a browser-local chat demonstration, and directs users to the local installer and documentation.

## Positioning

Relmio separates authentication, transport, and client compatibility instead of presenting one credential as interchangeable across products. Each route states which credential it accepts, where it can run, and what it will not change.

## Operating Context

- A hosted chat can test a supported ChatGPT sign-in stored in the user's browser.
- The local wizard can expose an OpenAI-compatible endpoint backed by a user-supplied OpenAI Platform API key.
- Experimental Codex App Server and Codex Chat Adapter routes use ChatGPT sign-in within their documented trust boundaries.
- The n8n path installs a separate private Docker sidecar and can prepare an isolated AI Assistant code sandbox with optional SearXNG search.
- Documentation, local installation commands, and explicit human confirmation gates are part of the normal evaluation and setup flow.

## Capabilities and Constraints

- Preserve the existing routes and navigation destinations: `/`, `/install`, `/docs`, and generated documentation routes.
- Preserve the hosted chat sign-in and streaming API behavior.
- Keep the hosted chat visibly bounded: no tools, file inspection, commands, or external-resource access.
- Keep credential types visibly distinct. ChatGPT sign-in is not an OpenAI Platform API key.
- Never claim that experimental ChatGPT/Codex routes are approved OpenAI API providers.
- Never edit, rebuild, recreate, stop, restart, or execute inside an existing n8n container.
- Never expose the private n8n sidecar port on the VPS host.
- Require SSH host-key confirmation and final human confirmation before remote writes in the local wizard.
- Never print, return, or commit OAuth tokens, SSH passwords, private keys, or provider API keys.
- Keep remote deployment work inside `/docker/n8n-openai-oauth`.

## Brand Commitments

- Preserve the Relmio name, rounded-square relay android mark, and muted teal identity.
- Support light, dark, and system appearance modes.
- Use direct, technically precise language. Avoid hype, provider-approval claims, and invented proof.
- The installer command remains presented as a black terminal surface.

## Evidence on Hand

- The repository contains working hosted chat, installer, documentation, streaming, theme, and project metadata routes under `web/app/`.
- `README.md`, `SPEC.md`, `docs/security.md`, and `docs/ai-assistant.md` document current capabilities and boundaries.
- Automated web tests cover documentation generation, streaming, rendering, migration, and the current Editorial Console behavior.
- No verified customer logos, testimonials, performance benchmarks, pricing claims, or usage statistics are available. The web app must not fabricate them.

## Product Principles

1. Make every credential boundary understandable before asking for trust.
2. Demonstrate the real relay mechanism instead of decorating the page with generic AI imagery.
3. Keep interactive setup reversible and human-gated.
4. Preserve the user's existing infrastructure unless a separately confirmed action explicitly targets it.
5. Prefer verifiable product behavior over broad policy or compatibility claims.

## Accessibility & Inclusion

The web app must retain semantic navigation, keyboard operation, visible focus, screen-reader status announcements, responsive layouts, WCAG AA contrast, and a complete reduced-motion experience.
