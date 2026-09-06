# Relmio design system

## Doorway Playground

Relmio opens a door between AI accounts and local tools. The public website
uses a playful animated world around the existing doorway mascot.
Connection guides make the available routes and their limits clear; installation
and operational surfaces remain calm and direct.

Product truth and safety copy take priority over decoration. Hallmark governs the
public redesign and its audit; the existing application system continues to govern
operational surfaces. The user explicitly authorized a bespoke cartoonish direction.

## Visual language

The public website has a bespoke playful system. It is not a clone of a reference
brand or a catalogue template. The central idea is an open illustrated world:
Relmio's doorway connects the AI a visitor already uses to the tools where they
make things. Lead with that idea, then make the product easy to understand.

- Marketing display: Bricolage Grotesque, upright, bold or extra-bold. Body and
  functional UI: existing Geist. Keep Geist Mono only for actual technical values.
- Palette: warm cream, deep pine ink, and the existing teal brand anchor. A small
  set of named coral, butter-yellow, and sky illustration tokens may support the
  scene. Functional warning amber keeps its meaning. Define all new values as
  semantic OKLCH tokens, including explicit and system-dark equivalents.
- Compose one wide illustrated stage into the page. Avoid the rejected left-serif
  headline plus framed-raster-card arrangement. The illustration must feel drawn
  for Relmio, not a dashboard diagram or collection of generic floating cards.
- Use friendly vector shapes or real 3D only when it materially serves the scene.
  Existing Motion, CSS and SVG are sufficient if the visible result is excellent.
  Do not label a CSS or SVG scene as Three.js.
- Give the hero one clear install action. Keep explanation short and plain.
  Preserve the five accurate connection choices in a secondary accessible guide.
- Preserve the original logo bytes, dimensions, aspect ratio and artwork. Any
  illustrated environment is separate artwork; never redraw or distort the logo.
- Keep operational pages on the existing Astru semantic system. Scope public
  styles so the installer, local wizard, hosted chat and docs remain dependable.

The original Signal Plotter token pairs remain compatibility tokens for existing
functional surfaces. New public tokens live in the homepage component system;
no framework stylesheet or global token system is replaced.

## Public page composition

- Headline: “Bring your AI sign-ins to your tools.”
- Supporting copy: “Keep every credential where it belongs. Relmio guides you
  through sign-in and setup for n8n and local tools.” Provider-specific availability
  belongs in the connection guide, not the hero introduction.
- Genre: playful. Hallmark route: custom, bespoke.
- Marketing family: Doorway Playground, a short invitation followed by a broad
  animated vector stage, a concise product explanation, and the connection guide.
- Navigation: preserve existing destinations and logo; use a composed flat header
  without fake browser chrome or floating glass. Keep How it works, Install,
  Docs, Changelog, Chat, GitHub, Support, and the System/Light/Dark controls in
  the header, as explicitly requested. Wrap them at narrow widths and browser
  zoom without changing their reading order. Keep the install action clear.
- Footer: a quiet closing invitation with useful destinations; no fake social proof.
- Motion: one coordinated scene loop with a visible pause/resume control. It must
  be apparent without hover, stop immediately for reduced motion, and pause when
  offscreen. Pointer depth is an optional enhancement, not the only animation.
- Mobile: maintain scene character at 320, 375, 414 and 768 px. Keep the headline,
  install action and navigation usable; do not conceal overflow as a layout fix.
- Reference collection: Awesome DESIGN.md is inspiration data. Preserve original
  identity and factual content; do not copy another brand's assets or wordmarks.

## Surface rules

### Home

The public homepage introduces Relmio through a playful illustrated world. Use
vector forms, expressive composition, and visible animation or depth around the
teal two-eye mascot and cream doorway. The logo file is fixed: preserve its
original proportions and artwork. A boxed raster scene beside a generic headline
does not meet this direction.

Lead with a short, plain explanation for ordinary visitors and one obvious install
action. Put the five connection choices and their truthful limits in an accessible
secondary guide. Keep the public site welcoming while the installer remains a
practical guided setup. The two surfaces share identity, not identical layouts.

Animation must be noticeable and deliberate, with a pause control for continuous
motion, immediate reduced-motion support, and a complete static presentation.
Interaction never waits for animation. Touch and keyboard paths must remain
complete, and the narrow layout must preserve the scene's character as well as
the install action.

### Hosted chat

The console is the primary object in Focus Mode. Explanatory copy remains
secondary. The transcript owns scrolling, messages use stable turns, the
composer stays in normal flow, and stopping a request preserves partial output.
Never imply tools, files, commands, browsing, persistent history, or a shared
subscription pool.

### Installer

The method selector and usable command appear before supporting explanation.
Tabs support pointer and arrow-key navigation. Copy feedback is announced, and
commands wrap without causing page overflow. Wording targets compatible
self-hosted n8n generally, not one hosting vendor.

### Local browser wizard

Use large, clearly labelled controls and plain instructions for nontechnical users.
Keep one obvious next action in each of the four steps. Connection choices are
full-width selectable rows; show the selected choice’s explanation and retain
short status labels for every choice. Computer requirements and supporting
credential details may use keyboard-accessible disclosures. Errors, the plan,
and required confirmations remain explicit. Keep tested behavior unchanged.

### Documentation

Documentation behaves like a field manual: searchable numbered guides, safe
generated Markdown, and compact adjacent navigation. Keep the index focused on
finding a guide; request-path explanations belong in the relevant guide.
Code and route panels may remain dark in either theme only when their foreground
colors are explicitly paired for contrast.

## Motion and interaction

- Motion explains route selection, state changes, or new transcript content.
  Public illustration may use visible decorative motion with a pause control.
  It stays still when reduced motion is requested and remains clear without hover.
- Use transform and opacity with short deceleration; never animate layout
  dimensions or padding.
- Honor `prefers-reduced-motion` with a stable final state and no decorative
  loops.
- All interactive targets remain keyboard reachable with visible focus.

## Acceptance bar

Every release must be inspected in Opera GX at desktop and mobile sizes in light
and dark modes. It must have no horizontal overflow, console errors, failed
resources, overlapping chat controls, or inaccessible terminal/status colors.
Unreviewed and undocumented is unfinished; completion requires the finish
review, its verdict, and this document.

## Portable token exports

The runtime source is `web/app/components/relay/tokens.css`, scoped to
`.doorway-theme`. It uses the existing theme selection and locally hosted
Bricolage Grotesque. These examples are optional mappings for another project;
Relmio continues using Astryx and CSS modules. Import the source tokens first.

### Tailwind v4 mapping

```css
@theme inline {
  --color-doorway-cream: var(--doorway-cream);
  --color-doorway-cream-soft: var(--doorway-cream-soft);
  --color-doorway-ink: var(--doorway-ink);
  --color-doorway-ink-soft: var(--doorway-ink-soft);
  --color-doorway-teal: var(--doorway-teal);
  --color-doorway-teal-deep: var(--doorway-teal-deep);
  --color-doorway-teal-soft: var(--doorway-teal-soft);
  --color-doorway-coral: var(--doorway-coral);
  --color-doorway-coral-soft: var(--doorway-coral-soft);
  --color-doorway-butter: var(--doorway-butter);
  --color-doorway-sky: var(--doorway-sky);
  --color-doorway-sky-soft: var(--doorway-sky-soft);
  --color-doorway-hill-back: var(--doorway-hill-back);
  --color-doorway-hill-front: var(--doorway-hill-front);
  --color-doorway-shadow: var(--doorway-shadow);
  --color-doorway-focus-ring: var(--doorway-focus-ring);
  --font-doorway-display: var(--doorway-font-display);
  --font-doorway-body: var(--doorway-font-body);
}
```

### Design token JSON

Light and dark are separate groups. Colors use the object representation in the
[Design Tokens Color Module](https://www.designtokens.org/tr/2025.10/color/#format).
The CSS file remains authoritative for responsive typography and timing.

```json
{
  "light": {
    "cream": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.955,0.028,92.0]}},
    "cream-soft": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.98,0.014,95.0]}},
    "ink": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.3,0.038,175.0]}},
    "ink-soft": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.48,0.03,175.0]}},
    "teal": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.55,0.095,185.0]}},
    "teal-deep": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.44,0.08,186.0]}},
    "teal-soft": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.91,0.04,186.0]}},
    "coral": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.65,0.155,45.0]}},
    "coral-soft": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.9,0.055,58.0]}},
    "butter": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.89,0.115,95.0]}},
    "sky": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.83,0.05,225.0]}},
    "sky-soft": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.94,0.02,225.0]}},
    "hill-back": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.79,0.065,158.0]}},
    "hill-front": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.87,0.06,152.0]}},
    "shadow": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.3,0.038,175.0],"alpha":0.16}},
    "focus-ring": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.42,0.085,186.0]}}
  },
  "dark": {
    "cream": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.25,0.022,95.0]}},
    "cream-soft": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.19,0.016,95.0]}},
    "ink": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.91,0.02,170.0]}},
    "ink-soft": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.72,0.022,170.0]}},
    "teal": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.77,0.105,178.0]}},
    "teal-deep": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.63,0.09,180.0]}},
    "teal-soft": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.32,0.038,184.0]}},
    "coral": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.73,0.13,48.0]}},
    "coral-soft": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.37,0.065,50.0]}},
    "butter": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.8,0.095,95.0]}},
    "sky": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.55,0.07,225.0]}},
    "sky-soft": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.28,0.03,225.0]}},
    "hill-back": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.38,0.045,163.0]}},
    "hill-front": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.3,0.038,160.0]}},
    "shadow": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.0,0.0,0.0],"alpha":0.4}},
    "focus-ring": {"$type":"color","$value":{"colorSpace":"oklch","components":[0.8,0.11,178.0]}}
  }
}
```

### shadcn variable mapping

```css
.doorway-theme {
  --background: var(--doorway-cream-soft);
  --foreground: var(--doorway-ink);
  --card: var(--doorway-cream);
  --card-foreground: var(--doorway-ink);
  --popover: var(--doorway-cream-soft);
  --popover-foreground: var(--doorway-ink);
  --primary: var(--doorway-ink);
  --primary-foreground: var(--doorway-cream-soft);
  --secondary: var(--doorway-teal-soft);
  --secondary-foreground: var(--doorway-ink);
  --muted: var(--doorway-cream);
  --muted-foreground: var(--doorway-ink-soft);
  --accent: var(--doorway-teal-soft);
  --accent-foreground: var(--doorway-ink);
  --border: var(--doorway-ink-soft);
  --input: var(--doorway-ink-soft);
  --ring: var(--doorway-focus-ring);
}
```

These aliases map the colors this scene uses. Add component-specific validation
and status colors when introducing forms; the scene does not define those states.


### Mascot clarification from user review
The homepage scene may use the existing green, mouthless, two-eyed mascot and
separate cream doorway vectors from `docs/images/brand/relmio-banner-animated.svg`.
Do not frame the square logo inside another arch. Preserve the original header
logo asset. Keep three purposeful stops (VPS cloud, Relmio, local workshop), no smiling
cloud or detached flag, and put moving messages behind foreground destinations.


### Final landscape behavior
The illustration spans the browser width with curved ground edges and a raised
cloud. The neutral traveller passes behind destinations. Local and VPS labels
appear briefly on arrival, sharing the same pause clock; permanent scene labels
are omitted. Night mode adds a moon, stars and a warmly lit workshop window while
retaining object colors. Unsupported SVG animation and reduced motion show a
complete still scene. Header links, theme controls and the original logo remain.

At the user's request, the illustrated ghost wears a blue sleep cap with closed
eyes and quiet Zzz in night mode. Day mode restores the original blinking eyes.
This is a scene accessory; the header logo asset is unchanged. All added motion
obeys pause, reduced motion, visibility and unsupported-animation fallback.
