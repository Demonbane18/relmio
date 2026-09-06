# Relmio Design System: Doorway Playground

> The public website follows the current Hallmark direction in `../../DESIGN.md`
> and `pages/home.md`. The original Signal Plotter system remains a compatibility
> baseline for operational surfaces. Its earlier public composition has been
> superseded by the user's illustrated, animated brief.

**Project:** Relmio
**Direction:** Playful animated public website; clear guided installation
**Design dials:** cartoon illustration · visible controlled motion · plain public copy · readable docs · generous wizard controls
**Legacy Signal Plotter concept seed:** `95cdc256`

## Thesis

The public website introduces Relmio through its doorway mascot and a playful animated world. The route guide then shows where each option starts, which sign-in or key it uses, and where it ends. Installation stays direct and practical. The five options remain distinct without implying unsupported capabilities.

## Operational compatibility tokens

The public homepage defines its scoped, semantic OKLCH tokens beside its component
styles. These existing token pairs continue to govern operational surfaces.

| Role | Light | Dark | CSS token |
| --- | --- | --- | --- |
| Canvas | `#F4F2ED` | `#0B1211` | `--relay-canvas` |
| Primary surface | `#FAF9F5` | `#111B19` | `--relay-surface` |
| Raised surface | `#FFFFFF` | `#172320` | `--relay-surface-raised` |
| Ink | `#12211F` | `#F1F5F2` | `--relay-ink` |
| Muted ink | `#526661` | `#A8BBB5` | `--relay-muted` |
| Brand teal | `#137C74` | `#62D2C4` | `--relay-teal` |
| Signal tint | `#E7F3F0` | `#173D38` | `--relay-teal-soft` |
| Moss | `#71846F` | `#A6B8A0` | `--relay-moss` |
| Warning | `#9A5A16` | `#F0B56B` | `--relay-amber` |
| Critical | `#A83F39` | `#FF9B93` | `--relay-danger` |
| Hairline | `#CCD5D1` | `#30423E` | `--relay-line` |
| Focus | `#0A6F69` | `#79E0D4` | `--relay-focus` |

Rules:

- Use teal for the active route and the primary action. Amber is warning-only.
- Use graphite, off-white, and thin hairlines for structure. No AI purple, neon glow, decorative gradients, or full-page grid wallpaper.
- Status never relies on color alone: pair it with text and a Lucide icon or route shape.
- Normal text must meet 4.5:1; controls and meaningful route lines must meet 3:1 in both themes.

## Typography

- Body and UI: Geist via `next/font`, weights 400–700. Homepage display text uses
  upright, bold Bricolage Grotesque; functional headings retain Geist.
- Technical labels, model names, route IDs, and commands: Geist Mono with tabular figures.
- Display scale: `clamp(3rem, 7.5vw, 7.25rem)`, line-height 0.91–0.98, slightly negative tracking.
- Page title: `clamp(2.25rem, 5vw, 4.75rem)`.
- Section title: `clamp(1.75rem, 3vw, 3rem)`.
- Body: 16–18px, line-height 1.55–1.7, maximum 68 characters.
- Eyebrow and route metadata: 11–13px mono, uppercase only for short labels, 0.08em tracking.
- Prefer natural sentence case. Do not make every label a badge.

## Spacing, shape, and elevation

- Spacing scale: 4, 8, 12, 16, 24, 32, 48, 72, 96.
- Page gutters: 16px at 375; 24px at 768; 40px at 1024; 64px at 1440.
- Content max width: 1440px. Long-form copy max width: 72ch.
- Surfaces use 14px or 18px radii. Pills are reserved for tiny status or segmented controls.
- Shadows are rare: `0 16px 48px rgba(8, 20, 17, .10)` for one raised stage; hairlines carry most hierarchy.
- Buttons and cards must not shift surrounding layout on hover. Use color, border, and a 1–2px internal transform only.

## Interaction model

### Route controls

- The home opens with a short invitation, one install action, and a broad animated
  vector world. The interactive route guide follows the product story.
- The website may be spacious and expressive. The local wizard retains its practical large controls and direct guidance; shared branding does not require identical composition.
- A route control is a real `button` with visible text, `aria-pressed`, and a 44px minimum target.
- Selecting a route crossfades its description, moves one signal packet along a fixed path, updates the destination state, and exposes a direct deep link.
- Keyboard: Tab selects a control; Enter/Space activates it; no hover-only information.

### Buttons

- Primary: solid teal, high-contrast label, short direct verb.
- Secondary: transparent or surface fill with a hairline border.
- Icon-only controls: 44px target, Lucide outline style, explicit `aria-label`.
- Hover 120–180ms; press feedback within 100ms; focus ring 3px with offset.
- Disabled/loading states use native semantics and do not accept repeat actions.

### Terminal selector

- Installer command is always a black/graphite terminal surface in both themes.
- Methods are a wrapping segmented control above it. Changing method replaces content in place and announces the change politely.
- Copy provides non-blocking success text and does not move focus.

### Chat

- One transcript scroll owner with `min-height: 0`; the browser window never competes with transcript scrolling.
- Stable turn IDs; one in-flight request ID; stale streams cannot write or clear a newer request.
- Stick to bottom only when already near the bottom. Otherwise show a keyboard-accessible “Jump to latest” control.
- Composer is stable at the bottom, 64–192px auto-grow, IME-safe Enter, explicit Send/Stop in one fixed location.
- Transcript uses `role="log"`; request phase is announced in a separate atomic live region.
- Hosted chat visibly states its boundary: no tools, files, commands, or external resources.

## Motion language

Motion explains cause and path. Keep the static information readable before animation.

- Route selection: interruptible spring (`stiffness 340`, `damping 32`) for the active marker.
- Signal packet: 650–900ms path travel, constant-rate segment movement, then a 180ms destination confirmation.
- Content replacement: 140ms exit, 220ms enter, opacity + 6px transform only.
- Button feedback: 90ms press, 160ms release.
- Entrance: one restrained sequence for the stage title and connection map; no per-card fly-in sequence.
- Use `transform` and `opacity`; never animate layout dimensions, top, or left.
- Under `prefers-reduced-motion: reduce`, remove travel and spring movement, render final states immediately, and retain text/status feedback.

## Local browser wizard

Keep large buttons, full-row connection choices, plain language, and one clear next
action. Show the selected connection’s explanation; use native disclosures for
requirements and supporting sign-in details. Do not hide errors, review facts,
or required confirmations. Preserve the four-step flow and all service safeguards.

## Responsive behavior

| Viewport | Layout |
| --- | --- |
| 375px | One-column; route controls wrap or scroll only inside their labeled control row; stage remains fully operable; no page overflow. |
| 768px | Illustrated stage remains legible; guide stacks as needed; installer tabs wrap; chat keeps its own work area. |
| 1024px | Broad integrated stage with persistent global navigation; the practical guide follows below. |
| 1440px | Full illustrated world with generous gutters and max-width containment. |

All mobile body/input text is at least 16px. Touch targets are at least 44×44px and separated by at least 8px.

## Accessibility and performance floor

- Semantic landmarks, sequential headings, skip link, visible current navigation state.
- Focus is never hidden by sticky UI. Route detail changes do not steal focus.
- Decorative SVG geometry is hidden from assistive technology; the route summary is available as text.
- Respect reduced motion and forced colors; do not disable zoom.
- Client code is isolated to the interactive connection map, chat, theme, and copy controls.
- Reserve connection-map and message dimensions to prevent CLS; no scroll listener that performs continuous React state writes.
- No third-party animation runtime larger than needed; lazy load below-fold interactive detail when practical.

## Product-truth guardrails

- Keep these labels distinct and visible: **n8n with ChatGPT sign-in**, **Grok Build OAuth**, **n8n Code Sandbox**, **Codex Chat Adapter**, and **Codex App Server**.
- SuperGrok remains unreleased. The current private Chat Completions candidate passed disposable n8n Assistant and workflow tool-call acceptance; do not imply every model or client was tested.
- n8n Code Sandbox is an AI Assistant companion with a user-owned Platform key entered in n8n and optional SearXNG.
- Chat Adapter and App Server use supported ChatGPT sign-in paths and are experimental trusted-client surfaces.
- Hosted chat is a bounded demo and does not claim tools, files, commands, or external browsing.
- Do not add customer counts, benchmarks, uptime, adoption, or permanent model claims without authoritative evidence.

## Forbidden patterns

- Generic centered hero + four equal feature cards + oversized CTA band.
- Purple/pink AI gradients, glow halos, glassmorphism as decoration, or cyberpunk scan lines.
- Decorative motion without a pause control or reduced-motion still state.
- Multiple transcript scroll owners, smooth-scroll on every stream delta, or React state as the only submit lock.
- Floating composer that overlaps messages, tiny icon targets, hover-only descriptions, or auto-rotating content.
- Excess badges, excessive pills, emoji icons, gradient text, and repeated rounded containers nested three levels deep.

## Delivery checklist

- [ ] Product labels and credential boundaries match `PRODUCT.md`.
- [ ] 375, 768, 1024, and 1440 layouts have no horizontal page overflow.
- [ ] Light and dark contrast independently pass.
- [ ] Keyboard, screen reader, IME input, repeat-submit, Stop, and stale-stream paths pass.
- [ ] Reduced-motion state is complete and usable.
- [ ] Installer terminal stays black in light and dark modes.
- [ ] Opera GX desktop and mobile evidence covers home, chat, installer, and docs.
- [ ] No unrelated root/runtime/n8n/VPS behavior changed.

## Previous homepage artwork, retained for comparison

The original logo files are unchanged and must retain their aspect ratios.
`assets/doorway-source.png` is generated presentation artwork inspired by the
approved doorway concept, not a replacement logo or a product screenshot.
Its former delivery WebP is excluded from the public bundle; the source is
retained only as a historical design study. The current hero uses authored SVG.
The illustrated forms are decorative; connection capabilities are described in
the route guide. Pointer depth uses the existing motion library, is bounded and
resets on leave, and is disabled for reduced motion and coarse pointers.

## Active Kimi redesign direction

The user rejected the boxed raster-art composition. The public homepage must
change structurally, with an authored cartoon/vector scene and noticeable motion.
The scene belongs in the page composition, not in a generic product card. Keep the
original logo, five truthful connection options, working actions, and accessible
reading order. Continuous motion needs a pause control and a complete static
reduced-motion path. The existing installer retains its practical design.


## Hallmark redesign, current direction

The user rejected the framed doorway artwork as still too technical and static.
The current public direction is Doorway Playground in `DESIGN.md`: original
cartoon/vector art, a wide animated stage, upright Bricolage display, Geist body,
warm cream/deep pine with the original teal brand anchor. The logo stays intact.
The practical local wizard and operational surfaces keep the existing system.

Hallmark 1.1.0 is installed as a personal Codex plugin. Its design, redesign and
audit rules apply within the user's authorized scope; prior creative delegation
supplies the audience, mood, bespoke direction and permission to proceed.
References are recorded in `REFERENCE-STUDY.md`; seven textual design systems
were compared, with no claim of live visual or motion verification.

Astra owned the design contract and integration. Kimi K3 through OpenCode Go
delivered the SVG scene, scoped palette and component; root integrated and
verified the output after the worker ended on a provider rate limit.
Opera checks and a fresh independent review passed for the local candidate.
The reviewer was requested as Sol High, but could not independently expose its
observed model/effort. No completed-code check implies user aesthetic approval.
See `HALLMARK-CHECKLIST.md` and the browser acceptance report for proof and limits.


### Final landscape behavior
The illustration spans the browser width with curved ground edges and a raised
cloud. The neutral traveller passes behind destinations. Local and VPS labels
appear briefly on arrival, sharing the same pause clock; permanent scene labels
are omitted. Night mode adds a moon, stars and a warmly lit workshop window while
retaining object colors. Unsupported SVG animation and reduced motion show a
complete still scene. Header links, theme controls and the original logo remain.
