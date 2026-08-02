---
name: Relmio
description: A calm Patchbay Ledger for verifying a private relay route.
colors:
  canvas: "#f4f2ed"
  surface: "#fbfaf6"
  card: "#fffdf8"
  muted: "#e7f3f0"
  ink: "#12211f"
  ink-soft: "#51625d"
  signal: "#137c74"
  signal-dark: "#0b675f"
  line: "#d4ddd8"
  line-strong: "#a8b7b1"
  success: "#007004"
  warning: "#745b00"
  error: "#a50c25"
typography:
  display:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "clamp(3rem, 5.8vw, 5.5rem)"
    fontWeight: 400
    lineHeight: 0.98
    letterSpacing: "-0.038em"
  headline:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "clamp(2.25rem, 4.5vw, 4.5rem)"
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: "-0.035em"
  body:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 650
    lineHeight: 1.5
  code:
    fontFamily: "Geist Mono, Consolas, monospace"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  inner: "6px"
  element: "12px"
  container: "18px"
  full: "9999px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "20px"
  6: "24px"
  8: "32px"
  10: "40px"
  12: "48px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "#ffffff"
    rounded: "{rounded.element}"
    padding: "0 24px"
    height: "48px"
  button-secondary:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.element}"
    padding: "0 24px"
    height: "48px"
  route-panel:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.container}"
  input-field:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.inner}"
    padding: "10px 12px"
    height: "46px"
---

# Design System: Relmio

## Overview

**Creative North Star: "Patchbay Ledger"**

Relmio makes an otherwise invisible relay legible as a route that can be checked before it is trusted. Warm paper surfaces, midnight ink, relay teal, graphite seams, and numbered signal paths give a safety-first technical product its own operational world rather than a generic SaaS hero or card grid.

The hosted surface follows the route from understanding to boundary verification and choosing hosted or local use. The local wizard applies the same grammar at higher density: its persistent route rail, active gate, and sanitized preview keep the current operational decision visible. Motion establishes or verifies a route; it does not decorate it.

**Key Characteristics:**

- Warm, quiet paper grounds a compact technical ledger.
- Teal is evidence of an established signal, not ambient decoration.
- Graphite seams, ordered rows, and numbered circles explain sequence and boundaries.
- The prominent surface is a route panel or work panel with visible state, never an anonymous card collection.

## Colors

The palette uses warm neutrals for calm reading, restrained midnight contrast for commitment, and relay teal for verified movement and primary action.

### Primary

- **Relay Teal:** carries primary actions, active signal lines, verified route markers, and focused input borders.
- **Deep Relay:** darkens the relay color for hovered actions and stronger text-accent moments.

### Secondary

- **Signal Tint:** supports route devices, status rows, segmented controls, and safety surfaces without competing with the verified teal.

### Neutral

- **Warm Canvas:** the page ground for both hosted pages and the local wizard.
- **Paper Surface:** the quiet interior surface for messages, fields, and selected controls.
- **Ledger Card:** the brightest paper plane for route, chat, and installation stages.
- **Midnight Ink:** carries primary reading text, the brand mark, and inverted command stages.
- **Soft Ink:** carries explanatory copy and metadata.
- **Graphite Seam / Strong Seam:** divide ledger rows and bound important panels.

### Named Rules

**The Verified Signal Rule.** Use relay teal for an actionable route, a confirmed state, or the one control that advances the user. Do not spend it as a decorative wash.

**The Safety Color Rule.** Warning, error, and success colors appear inside bounded notices, confirmation states, and status indicators; they do not replace the relay color as the product identity.

## Typography

**Display Font:** Geist, with Arial fallback.

**Body Font:** Geist, with Arial fallback.

**Label/Mono Font:** Geist Mono, with Consolas fallback, for route indices, commands, paths, and tabular status.

**Character:** A single modern sans family keeps instructions plain and approachable while the monospaced utility voice marks exact operational facts. Large display copy is tight and decisive; support copy opens its line height to slow the user down where caution matters.

### Hierarchy

- **Display:** a near-black headline with a tight, balanced measure; reserved for the main route proposition and major wizard entry.
- **Headline:** the large section voice for deliberate gates, safety boundaries, and installation framing.
- **Title:** semibold compact headings for route panels, command stages, and chat surfaces.
- **Body:** normal-weight explanatory text with a 1.6 line-height; reading measures stay near 52–70ch where the implementation sets a constraint.
- **Label:** semibold small text for controls, state labels, and metadata; numerical route labels use the mono face with tabular numerals.

### Named Rules

**The Route Has a Number Rule.** Ordered gates and route points use a small, tabular numeric index so sequence remains scannable independent of prose.

## Layout

The shared page container is capped at 76rem and keeps a narrow mobile gutter before widening into a generous desktop ledger. The hosted first view uses the approved 5/7 split: narrative on the left and the Signal Spine route panel on the right. Major sections use a strong vertical cadence that expands with viewport width; ledger content is organized as grids and full-width rows separated by seams.

On medium widths, hosted content stacks into a single column and the sticky chat explanation becomes static. At phone widths, five-gate diagrams turn from horizontal to vertical routes, assurance grids collapse to one column, and primary actions expand to full width. The local wizard is operationally denser: at 60rem and above, a sticky left route rail stays beside the active work column; below that breakpoint, it becomes a compact horizontal progress rail before the current gate.

**The Persistent Context Rule.** A multi-step local task keeps route context visible at every width; the active gate and its safety boundary stay adjacent to the work rather than hidden in a separate progress screen.

## Elevation & Depth

This is a seam-led, tonal system. Most hierarchy comes from warm canvas, paper planes, strong borders, and muted status bands instead of floating cards. Hosted route and chat panels are flat at rest; the local wizard's active work panel alone receives a soft, low midnight shadow to make the current gate the clear working plane.

### Shadow Vocabulary

- **Wizard work-panel shadow:** `0 0.125rem 0.25rem rgb(18 33 31 / 5%), 0 1rem 2.5rem -1.5rem rgb(18 33 31 / 24%)`; used only under the local active panel.
- **Selected control shadow:** the theme's low, restrained shadow; used on the selected installation-method tab rather than on every segmented choice.

### Named Rules

**The Seams Before Shadows Rule.** Establish structure with borders and tonal planes first. Add a shadow only when it identifies the immediate working or selected surface.

## Shapes

Rectilinear ledger rows meet gently rounded containers: 18px rounds a major route, chat, command, or wizard panel; 12px rounds controls and contained notices; 6px rounds inputs and inner selections. Route checks and gate indices are fully circular. Borders are thin graphite seams, with a stronger seam enclosing a panel that carries a decision.

The signal spine is a native form, not ornament: a teal vertical or horizontal line joins circular checks, device tiles, and numbered steps. Bubbles retain the container roundness but cut one conversation corner back to an inner radius, making direction legible without introducing a separate visual language.

## Components

### Buttons

**Character:** Direct, quiet controls that make the safe next move unmistakable.

- **Shape:** gently rounded controls (12px in hosted Astryx surfaces; 10px in the local wizard) with a 44–48px minimum touch target.
- **Primary:** relay-teal fill with white or dark-on-light scheme text; hosted primary actions use a 48px height and 24px horizontal padding.
- **Hover / Focus:** the local primary shifts to deep relay and rises by 1px; all keyboard focus uses a high-contrast teal or amber outline/ring rather than relying on color alone.
- **Secondary / Ghost:** secondary controls stay paper-filled behind a strong seam and turn to signal tint with a teal border on hover; ghost controls remain transparent and subdued until hover.

### Cards / Containers

**Character:** Bordered operational stages, not a decorative grid.

- **Corner Style:** 18px for hosted route, chat, and command stages; 12px local panels.
- **Background:** brightest ledger paper, with signal tint reserved for internal status bands and selected control backgrounds.
- **Shadow Strategy:** flat by default; only the active local panel lifts softly.
- **Border:** a 1px strong graphite seam at the outer edge, with ordinary graphite seams between rows.
- **Internal Padding:** panels use a 20–24px ledger inset, growing responsively for the local work panel.

### Inputs / Fields

**Character:** Exact values are presented as inspectable facts, not vague settings.

- **Style:** paper-raised fill, a strong graphite 1px border, and a 6px corner radius.
- **Focus:** relay border plus a 3px translucent relay ring; local global keyboard focus uses a visible amber outline.
- **Error / Disabled:** error stays in a pale red bounded notice; disabled fields shift to signal tint with soft ink copy rather than disappearing.

### Navigation

**Character:** A slim, sticky route header on hosted pages and a local-only status header in the wizard.

- **Style:** a warm-canvas bar with a bottom seam; the Relmio mark and wordmark stay left, simple text links center, and one hosted-chat action sits right.
- **Mobile treatment:** text navigation is removed before the header becomes crowded; the action and brand remain. The local header keeps the local-only badge visible.

### Signal Spine

**Character:** The signature explanation of a verified relay.

- **Structure:** sequential rows bind a circular check, a bordered device tile, route copy, and a tabular index to a teal spine.
- **State:** the hosted spine establishes from the top and devices verify in brief staggered order; local route markers switch from neutral to teal as gates complete.
- **Responsive behavior:** desktop ledger sequences can run horizontally for overview; narrow screens always resolve to a readable vertical route.

### Chat Console

**Character:** A request-bound test lane with clear ownership of each message.

- **Structure:** a bordered, 18px paper console with a status header, muted authentication band, conversation field, suggestions, and composer.
- **Messages:** user messages are relay teal and align to the end; assistant messages stay paper-filled with a graphite seam and align to the start; each uses one reduced corner to show direction.

## Do's and Don'ts

### Do:

- **Do** use warm canvas, paper planes, and graphite seams to make a technical step feel inspectable.
- **Do** show sequence as a route with numbered gates, explicit boundaries, and an evident current state.
- **Do** reserve relay teal for the verified route, a primary action, or an active/confirmed control.
- **Do** keep motion short and causal: establish a route, verify a device, show a loading response; honor reduced-motion preferences.
- **Do** keep exact paths, commands, fingerprints, and indices in the mono utility voice.

### Don't:

- **Don't** turn the product into a generic SaaS hero followed by a card grid; make the route and safety ledger carry the first view.
- **Don't** use gradients, provider branding, or altered treatments of the Relmio mark.
- **Don't** hide a safety boundary behind an interaction or make a remote write look like an ordinary continuation button.
- **Don't** use elevation as decoration; a seam and tonal plane should explain structure before any shadow does.
- **Don't** introduce heading eyebrows or kicker labels as a house pattern; the finished interfaces communicate hierarchy through route position, titles, and ledger structure.
