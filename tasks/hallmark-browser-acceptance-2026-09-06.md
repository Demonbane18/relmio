# Doorway Playground: local browser acceptance

This is evidence for the unpublished public-homepage redesign, not provider,
installer, Windows, production, or user taste acceptance. The earlier raster-art
handoff is superseded for homepage design only. No services were changed.

## Current result

The current headline is **Bring your AI sign-ins to your tools.** The supporting
line is **Keep every credential where it belongs. Relmio guides you through
sign-in and setup for n8n and local tools.** These supersede the earlier proposed
travel headline. Provider-specific limitations stay in the connection guide.

Kimi K3 supplied the SVG scene, component, and scoped palette through OpenCode
Go. Its request ended with a provider rate-limit error after the three files were
written. Astra integrated those files, corrected the actual defects below, and
performed the recorded checks. Kimi's own incomplete verification is not used
as acceptance evidence. Requested Kimi reasoning was High; upstream-native
reasoning semantics remain unverified.

## Browser evidence

All browser checks used Opera GX on this Mac and the owned production preview
at http://localhost:42832. Captures and raw probes are in
the retained local browser acceptance archive.

- 320, 375, 414, 768, 1280, 1440 and 1920 CSS-pixel widths: sampled layouts fit.
  Measured document overflow is zero at 320, 375, 414, 768, 1440, 1920 and native
  200% zoom. At 320, all measured navigation, footer, CTA and route labels
  remain on one line.
- Light and dark screenshots: `phone-320-reduced.png`, `phone-375-light.png`,
  `phone-375-dark.png`, `phone-414-dark.png`, `tablet-768-dark.png`,
  `desktop-1440-light.png`, `desktop-1440-dark.png`, `desktop-1920-dark.png`.
- At 1280 by 800, the headline, supporting line, CTA and original mascot focal
  point fit the first screen. The bottom ground/caption can extend below it.
- The original PNG is referenced directly in the header, footer and SVG; its
  source bytes match the preserved snapshot, and measured scene-image ratio is
  one. The 768 layout was corrected to show the entire scene vertically.
- Local Bricolage Grotesque font loads. The new type/palette values are scoped
  to the hero rather than redefining application tokens.
- Native keyboard: the skip link focuses the hero; Tab reaches Install and
  Pause; Enter toggles Pause/Play. All five route buttons are reachable and
  update their detail heading. The How it works anchor navigates correctly.
- The visible Install Relmio CTA loads `/install`; Docs loads `/docs`. Existing
  local routes also have server-rendering tests. No OAuth or chat was submitted.
- Native Opera View > Zoom In reached 200%, with zero measured horizontal
  overflow. `native-zoom-200.png` records the browser's 200% indicator.
- Coarse-pointer emulation reports touch capability, keeps controls at 44px,
  and needs no hover. CUA accessibility activation produced a mouse pointer
  event, so this is not a claim of physical touchscreen testing.

### Final header correction and repeat checks

The user explicitly retained all five menu links, GitHub, Support, and theme
controls in the header. Earlier captures with simplified navigation are scene
evidence only. The final header has new evidence:

- `wrap-*-final` probes at 320, 375, 414, 768, 800, 1024, 1280, 1440 and 1920:
  zero page overflow, no intersection between header groups, all groups within
  the viewport. `homepage-final-light.png` shows the final 1440px composition.
- Native 200% zoom initially exposed a logo/nav overlap. After wrapping the
  homepage header, the 863px viewport has zero overflow and no group overlap;
  `native-zoom-200-header-final.png` includes Opera's 200% indicator.
- A real How it works click at 200% sets the expected hash. The target starts
  at 135.88px and its heading at 197.68px, below the 127px sticky header.
- Native header theme clicks select System, Light and Dark. Keyboard navigation
  follows brand, the five links, selected theme, Support, GitHub, then Install.
  Focus-event measurements taken while the page held keyboard focus show 3px
  outlines with 2px offsets on both hero Install and Pause controls.
- `social-preview.png` is the new 1200x630 social card. Its delivered PNG matches
  the source asset hash. It uses the unchanged logo and general product headline.

An attempted accessibility click in 320px device emulation did not navigate;
its unchanged-hash probe remains in the log. Actual native navigation was
verified separately. Interrupted clipboard/native-pipe calls changed no source.

## Motion

`browser-probes.txt` records live results, including failed probes and corrections.
The original failing reduced-motion probe remains deliberately visible.

- Normal scene movement is automatic and follows the account-to-tools route.
- Pause stops both SMIL and CSS animation; two samples preserve exactly the same
  animation time. Resume advances the time again.
- Offscreen and hidden-document checks pause the scene; foreground returns it
  to the running state when otherwise eligible.
- Live reduced-motion switches to zero animation time, disables the motion
  control, and removes ambient CSS animations. Switching back resumes motion.
- A rewind bug initially hid the packet. Initialization now pauses and rewinds
  before starting SMIL. The corrected reduced-motion packet stays at the cloud
  position. The still composition is captured at 320px.

## Corrections made during integration

1. Replaced the redrawn mascot face with the unchanged original logo artwork.
2. Nested static SVG positioning separately from animated transforms.
3. Corrected SMIL initialization so reduced-motion stills retain the packet.
4. Tightened laptop headline/spacing and increased tablet scene height.
5. Kept the CTA's dark teal fill on hover after the proposed lighter fill failed
   small-text contrast; the hover change is now limited to its border.
6. Scoped page-edge clipping to homepage html/body, preserving other routes.
7. Preserved DOM/visual navigation order, then restored every requested header
   link, GitHub button, Support button, and System/Light/Dark control following
   the user's explicit correction. The footer GitHub destination is intentional.
8. Replaced the obsolete ChatGPT/network social image with the new illustrated
   world and provider-neutral headline; updated its description and keywords.
9. Matched the hero keyboard-focus ring to the 3px outline / 2px offset contract.
10. Corrected header crowding discovered by the final native 200% zoom check.
    Homepage header groups now wrap; medium-width anchors leave room beneath it.

## Verification and limits

- 63 web tests pass; lint, type checking and documentation generation checks pass.
- Vinext preview and Next/Vercel production builds pass.
- All 122 protected runtime files match the pre-design baseline. The original
  logo matches the implementation snapshot. Existing dirty work is retained.
- `design-system/relmio/palette-contrast.json` records calculated token-pair
  contrasts and the rejected hover color. This is not a full assistive-technology
  or every-pixel contrast certification.
- No page error was observed during the inspected interactions. The Console
  retained one SyntaxError from a malformed QA expression; its corrected probe
  is recorded. That error came from the probe, not application source.
- Native Windows and hosted deployment acceptance remain outside this local
  homepage pass. No commit, deployment, release, or runtime restart occurred.
  Only the owned local web preview was rebuilt/restarted.

Rendered hero text/controls also have browser-computed color contrast evidence
in `browser-probes.txt` (contrast-light and contrast-dark). All active hero text
pairs exceed 4.5:1. The final reduced-motion probe and capture retain the visible
packet at time zero.

Fresh independent review: no remaining material findings for the local homepage
candidate. Requested reviewer configuration: Sol High; the review agent could
not independently verify its observed model/effort from the available surface.
Review was behaviorally read-only under `danger-full-access`, not hard isolation.
Independent Hallmark scores: P4 H4 E4 S4 R3 V4. Final human design preference
remains the user's. The prior Windows handoff predates this final design.


## Follow-up: scene logic and original mascot

User inspection superseded the earlier square-logo-in-an-arch treatment. The
GitHub banner defines the mascot as a green, two-eyed, mouthless figure and its
cream doorway as a separate vector. The hero now reuses those exact checked-in
paths and fixed brand fills. Header logo assets remain unchanged. A thin scene
outline keeps the cream arch readable against the light background.

Removed the detached flag, smiling cloud face, extra houses and incidental
ornaments. Two leaf-shaped saplings frame three destinations: account, Relmio,
and tools. The route and packet are painted before the foreground destinations.
Opera hit tests confirm the packet is behind the mascot at time 1.898 and behind
the workshop doorway at time 5.005. These are browser checks, not conclusions
from the image-generation concept study.

Final scene evidence in the retained local browser acceptance archive:
- `scene-final-desktop.png`, `scene-final-dark.png`
- `scene-final-phone320.png`, `scene-final-phone375.png`,
  `scene-final-phone414.png`, `scene-final-tablet768.png`
- `scene-final-reduced-dark.png`: browser reports reduced motion true,
  SMIL paused at time zero, CSS running false, and Motion off disabled.
- `scene-final-social.png`: refreshed 1200x630 social image copied to public OG.
- `browser-probes.txt`: all four narrow widths have no horizontal overflow.
- `scene-clarity-tests.log`: 63 passed; lint, typecheck, Vinext and Next builds pass.

Small screens now use the SVG's intrinsic proportions, with Pause in a separate
row; this removes the intermediate fixed-height letterboxing. The first
`scene-mascot-*` captures predate that fix and are not final acceptance evidence.
Fresh independent source/browser review found no material issues in this bounded
revision. Review is local acceptance only, not authorization to deploy or release.

Final playback check: Pause reports SMIL paused; Resume reports running true and
SMIL paused false. Browser test overrides were cleared, DevTools closed, and the
revised homepage was left playing in Opera GX. All 122 protected runtime hashes
still match the baseline. The social-image-only preview server was stopped; the
main local homepage preview remains running. Nothing deployed or released.


## Final full-width day/night and arrival-label revision

The user requested edge-to-edge landscape, a floating cloud, no permanent scene
captions, and an actual night interpretation. The hero is now full page width
with a curved ground silhouette, a faceless airborne cloud, fixed mascot colours,
moon/stars, darker hills, and a warm workshop window at night. Original header
logo, all navigation, GitHub, Support, and theme controls remain.

Local and VPS labels appear only at their respective traveller arrivals. Browser
clock probes show Local opacity 1/VPS 0 at 4.823 seconds, VPS 1/Local 0 at 11.908,
and both 0 at the loop start. The labels and traveller are started together on
the SVG clock; pause, offscreen, visibility and reduced-motion controls govern
all animation. Reduced motion reports paused true, clock zero, both labels zero.
The accessible illustration description names VPS, Relmio and the local workshop.

Opera captures: wide-day-desktop, wide-night-desktop, wide-local-arrival,
wide-vps-arrival, wide-final-phone320/375/414, wide-final-tablet768,
wide-night-tablet768, wide-reduced-night, and wide-final-social. Desktop geometry
reports the scene starts at zero and ends at the page client width, without
horizontal overflow. Final social image uses the same corrected artwork.

Provider-logo animation was considered at the user's request. The neutral
traveller was retained after reviewing https://openai.com/brand/ and
https://x.ai/legal/brand-guidelines ; the user accepted this treatment.
Native Windows and publication remain separate gates.


## Final night mascot and candidate verification

The night illustration adds a blue sleep cap, closed eyes and rising Zzz;
day mode retains the original blinking eyes. The header logo is unchanged.
Opera GX verified the desktop and 375px phone render in both themes, no
horizontal overflow, pause freezing the SVG and Zzz, and reduced motion
resetting the traveller clock to zero with arrival labels hidden. Simulated
missing SVG animation controls kept both CSS motion and the control disabled.
The explicit mock was removed by reloading the page; reduced-motion emulation
was cleared after the checks. Screenshots are in the Windows handoff evidence.

Final local candidate checks used Node 22.23.2 and npm 10.9.8: root 994 passed,
12 expected skips, zero failures; web 64 passed. Root/web lint, web typecheck,
Vinext and native Next production builds passed. Root audit had no findings;
the web all-dependency audit retained one moderate development-only fflate
advisory, with no high/critical finding. The package preview contains 111 files.
Review corrected stale release versions, removed the unused ACP adapter, and
added an attested per-project name to credential-action containers to prevent
an interrupted login racing a replacement after stale process-lock recovery.
Those recovery checks are synthetic; native Windows Docker acceptance remains
open. Nothing here establishes a published or production deployment.
