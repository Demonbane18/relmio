# Relmio public-site reference study

## Purpose and boundary

This is a design-direction brief for a **new public Relmio site only**. It does not propose changes to the practical installer, provider/OAuth flow, product behavior, or project files.

The intended direction is original: a broad-audience, cartoonish animated vector (with optional bespoke 3D depth) site that explains Relmio as a model relay. Preserve the existing teal two-eye mascot and cream doorway logo as Relmio's own identity. Do not copy another brand's assets, mascots, fonts, colors, layouts, or motion.

## Exact scope inspected

I inspected the `main` repository tree and these seven public `DESIGN.md` records in VoltAgent's Awesome DESIGN.md collection:

1. [Figma](https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/figma/DESIGN.md)
2. [Miro](https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/miro/DESIGN.md)
3. [PostHog](https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/posthog/DESIGN.md)
4. [Clay](https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/clay/DESIGN.md)
5. [Framer](https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/framer/DESIGN.md)
6. [Zapier](https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/zapier/DESIGN.md)
7. [Notion](https://raw.githubusercontent.com/VoltAgent/awesome-design-md/main/design-md/notion/DESIGN.md)

Collection root: [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md).

These are textual reference records, used as inert design data. I did **not** inspect the live sites, run their code, copy assets, or verify their real visual rhythm, responsiveness, or motion. The reference records themselves do not establish live visual or motion behavior.

## Comparative read

| System | Useful abstract lesson | Relmio translation | Do not carry over |
| --- | --- | --- | --- |
| Figma | Let a neutral shell make a small number of full-width color stages feel deliberate. | Use a calm cream field, then let the relay journey move through a few generous color moments. Each moment represents a routing state, not a feature card. | Figma's pastel palette, all-pill CTA language, mono-label density, or sticky-note visual identity. |
| Miro | Product storytelling can be carried by a large, legible visual artifact rather than copy volume. | The hero artifact can be an original animated relay: mascot enters the doorway, passes a message token through model stations, then receives a response. | Miro yellow, whiteboard/sticky-note vocabulary, centered SaaS hero, or stock board mockups. |
| PostHog | A mascot can be a navigational anchor while a warm canvas keeps a technical product humane. | The teal two-eye mascot can guide one clear story path and appear as a small helper at transition points. | Hedgehog imagery, engineering-blog style, emoji callout system, generic feature-card mascot placement, or uppercase-eyebrow clutter. |
| Clay | A warm base plus authored character/illustration creates personality without making every surface loud. | Keep the cream doorway and create a bespoke, simplified vector/3D relay world around the existing mascot. Give each model station a distinct silhouette, not a branded model logo collage. | Clay's commissioned claymation look, palette, characters, layout, or color-card sequencing. |
| Framer | A page can feel memorable when it makes one large statement per band and leaves real breathing room. | Use short, plain sentences and one relay action per scroll stage. Make the motion serve the explanation. | Dark-canvas identity, spotlight gradients, extreme type compression, generic luminous 3D decoration, or template-gallery styling. |
| Zapier | A connection product can explain a complex flow with warm, direct language and a single conversion focus. | Put the relay itself in the foreground: choose a model, send a request, get a response. Keep calls to action practical and short. | Orange conversion signature, workflow-zap iconography, generic app-grid diagrams, or a conventional split SaaS hero. |
| Notion | A strong opening scene plus a distinct showcase artifact can organize a colorful product story. | Use the original doorway as the opening scene and reserve the largest animated relay artifact for a single showcase moment. | Navy/purple identity, sticky-note dots, workspace mockup, or the centered hero-plus-product-card formula. |

## Recommended bespoke system

1. **Build a relay story, not a SaaS feature tour.** Shape the page as doorway → greeting → message relay → response arrival → practical install/try action. The relay is the visual explanation, so it replaces a boxed technical hero and a three-feature grid.

2. **Make the existing marks structural.** The cream doorway is the entry/exit portal; the teal two-eye mascot is the guide and acknowledgement state. Use them in their current recognizable roles rather than adding a new mascot, abstract blob, or copied character style.

3. **Use chromatic pacing with a restrained base.** Give cream the largest footprint and teal the identity role. Add only a few named stage colors for distinct relay states, separated by open space. Large story panels may be useful, but they should be irregularly paced and purpose-led rather than a repeated card system.

4. **Give motion one explanatory job.** Animate the message token moving between clearly different stations; let the mascot react on successful return. Keep all other motion quiet, transform/opacity based, and fully reduced to a readable static relay state under `prefers-reduced-motion`.

5. **Use plain, display-led copy.** Short headings should describe an observable action (for example, “Pick a model. Keep moving.”). Use an upright display face with a calm body face. Avoid italic headline emphasis, faux technical labels, and invented proof metrics.

## Suggested structural direction for the implementer

- **Opening:** doorway logo on cream, mascot already in motion; a left-biased short headline and one practical action.
- **Relay stage:** a broad, unboxed landscape with 3–4 differently shaped route stops. The route should be comprehensible without reading a caption. Each stop is an abstract service role, not a third-party logo wall.
- **Response stage:** message returns through the doorway; the mascot gives a small acknowledgement. This provides an emotional close without making a claim the product cannot prove.
- **Practical close:** concise installation/usage route using the existing installer information and interaction model, visually quieter than the public narrative. The installer remains unchanged.

This is closer to a small animated picture book for a useful technical tool than to a dashboard or a generic AI landing page.

## Rejected patterns

- A centered headline, centered paragraph, pill CTA, then a three-column feature row.
- A dark, glassy, gradient/orb-heavy “AI” hero or a generic spinning 3D object with no interaction or explanatory role.
- A boxed technical diagram, fake browser/terminal chrome, or a model-logo carousel used as the main hero.
- Repeated equal cards, icon tiles, repetitive section eyebrows, or a standard four-column SaaS footer as the page's dominant rhythm.
- Any copied signature: Figma color blocks, Miro boards/yellow, PostHog hedgehogs, Clay claymation, Framer spotlights, Zapier orange/workflow marks, or Notion's navy-purple-sticky-note language.
- Invented metrics, customer logos, testimonials, uptime claims, or performance claims.

## Hallmark checks that matter here

- Use a named macrostructure with a distinct nav/footer choice; do not default to a generic SaaS sequence.
- Keep colors and fonts behind named tokens once selected.
- Create original SVG/CSS artwork for the surrounding relay scene and display the
  existing mascot/logo asset unchanged, at its original aspect ratio. Never redraw
  the fixed mark or imitate another brand's illustration assets.
- Check mobile layouts at 320, 375, 414, and 768 px; primary actions and nav labels must not wrap.
- Keep headings upright, interactions accessible, focus states visible, and motion optional/reduced.

## Handoff note

The current evidence supports a **bespoke playful relay narrative** with a warm cream/teal core and original illustrated motion. It does not support claiming that any reference's live animation, responsive behavior, or visual rhythm has been verified. Before implementation, inspect the actual Relmio logo/mascot assets and current public-site route so the preserved identity is based on source assets, not memory.
