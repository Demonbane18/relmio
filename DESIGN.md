# Relmio design system

## Signal Plotter

Relmio is a calm signal desk for self-hosted AI infrastructure. The interface
shows every request as a legible route with a source, credential boundary,
transport, and destination. It should feel precise and operational, not like a
generic AI landing page.

The concept seed is `95cdc256`. Product truth and safety copy take priority over
decoration.

## Visual language

- Use warm off-white or graphite canvases with muted teal as the functional
  accent. Amber is reserved for caution and incomplete states.
- Use Geist for interface text and Geist Mono for routes, commands, labels, and
  machine-readable state.
- Prefer asymmetric editorial layouts, fine rules, and bounded work surfaces.
  Avoid repetitive card grids, gradient text, thick side-tab accents, decorative
  status clusters, and elastic motion.
- Use solid text colors and restrained shadows. The installer terminal remains
  black in both light and dark page themes.
- Keep Relmio's rounded-square gateway icon unchanged.

The generated Astru theme remains the canonical source for shared semantic
tokens. Signal Plotter-specific pairs live under `--relay-*` in
`web/app/globals.css` and must remain equivalent in explicit and system dark
modes.

## Surface rules

### Home

The first viewport pairs a concise product thesis with one interactive topology.
Each of the four supported contracts is a real pressed button and changes the
same route map rather than spawning four feature cards.

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

### Documentation

Documentation behaves like a field manual: numbered canonical guides, a clear
request-path legend, safe generated Markdown, and compact adjacent navigation.
Code and route panels may remain dark in either theme only when their foreground
colors are explicitly paired for contrast.

## Motion and interaction

- Motion explains route selection, state changes, or new transcript content.
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
