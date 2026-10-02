# Relmio design system

This file is the design contract for every Relmio interface: the local browser
wizard in `src/ui` and the hosted web app in `web/`. Read it with
[BRANDKIT.md](BRANDKIT.md), which holds the logo, colors, type and voice. Agents
and frontend skills should treat both files as the project brief and the
existing design tokens.

The two apps share one component kit, `src/ui/relmio-ui.css`. The wizard links
it directly. The web app imports a generated copy, `web/app/relmio-ui.css`,
which `npm run ui:sync` in `web/` refreshes and `npm run ui:check` verifies in
CI. Edit only the source file.

## Principles

1. One screen, one job in the wizard. Each wizard and dashboard view answers
   one question or completes one step, and it fits the window at laptop size.
   The next action is always visible. The hosted site is a scrolling page; see
   [The hosted site](#the-hosted-site).
2. Safety stays in sight. Warnings that change a decision are visible without a
   click. Background and technical detail sits behind a labelled disclosure.
3. Same parts everywhere. A button, field, notice or top bar looks and behaves
   the same in the wizard and on the website.
4. Two themes, one accent. Light is pastel yellow, dark is black. The accent
   (black in light, yellow in dark) marks the primary action, the current
   place and selection.
5. Plain words. Short sentences, sentence case, no jargon without a hint. See
   the voice rules in BRANDKIT.md.

## Surfaces

| Surface | Where | Job |
| --- | --- | --- |
| Setup wizard | `src/ui/index.html` (`/`) | Choose a route, check the server, choose n8n, review, finish |
| Local dashboard | `src/ui/local.html` (`/local`) | See and manage connections on this computer |
| Route wizards | `/supergrok-vps`, `/local-model-vps`, `/assistant` | Provider or companion setup on a server |
| Hosting options | `/hosting` | Compare hosts and build a plan without remote changes |
| Home | `web/app/page.tsx` (`/`) | Explain Relmio, show the routes, host the chat demo and start the install |
| Install | `/install` | Pick a terminal and copy the command |
| Chat | `/#chat`, a section of the home page (`/chat` redirects there) | Try the hosted chat demo |
| Docs | `/docs`, `/docs/[slug]` | Find and read a guide |
| Changelog | `/changelog` | Read release notes |

The wizard runs on the user's computer with a strict Content Security Policy:
same-origin scripts, styles, fonts and images only, no inline styles or
scripts, and `data:` images allowed. The web app runs on Vercel.

## The one-screen rule

This rule covers the local wizard and dashboard (`src/ui`) only. The hosted
web app does not use it; see [The hosted site](#the-hosted-site).

Every wizard step and dashboard view must show all of its controls and content
without a page scrollbar or a panel scrollbar at these window sizes:

- 1280 x 720, 1366 x 768, 1440 x 900 and 1920 x 1080
- 1024 x 768

The rule covers every default, busy and error state. When a person opens an
optional disclosure, the panel body may scroll; the footer actions stay
visible. A chat transcript and an activity log may scroll inside their own
region.

The shell makes this possible: put `rm-app rm-app--fit` on `<body>`. From
1024 x 600 the shell is exactly one window tall and `.rm-app__main` is the only
scroll container. Views are designed to fit, so that container never scrolls
at the target sizes. If a view still overflows, for example at 200% zoom, the
main area scrolls instead of clipping. Below 1024 pixels wide the page scrolls
normally. Never hide overflow to pass the rule.

Ways to fit a view, in order of preference:

1. Remove repetition. Say a safety fact once, in the place it matters.
2. Split a long step into two steps, or move secondary tasks to their own view
   or route.
3. Put optional explanation in an `rm-disclosure` and long warnings in an
   `rm-notice`. Keep the warning's first sentence visible.
4. Use the width: two-column forms, a `rm-grid` of choices, a definition list
   for review facts.
5. Keep actions in the panel footer, which stays visible.

Narrow screens (390 x 844 and 320 wide) must never scroll sideways. The first
screen of every view shows its title and its primary action or first choice.

Verify the rule by measuring, not by eye: at each target size,
`document.documentElement.scrollHeight` must equal `innerHeight`, and no
element with `overflow: auto` or `scroll` may have `scrollHeight` above its
`clientHeight`, except a chat transcript or an activity log.

## The hosted site

The web app in `web/` is a marketing and documentation site. It scrolls as a
normal page and may be expressive, as long as it stays in the brand: the same
tokens, kit components, top bar and themes as the wizard.

- The root layout renders `rm-app` without `rm-app--fit`, then the top bar,
  the page's `main` and the shared `SiteFooter`. Never lock a page to the
  window height. Only the chat transcript keeps its own bounded scroll
  region.
- Home runs top to bottom: the hero with the Doorway scene, How it works
  (`#how-it-works`), the hosted chat (`#chat`), the safety boundary
  (`#security`), then the footer. Install, docs, changelog and the 404 page
  follow the same rhythm: a large title, generous sections, the footer. Docs
  and changelog keep their sidebar in view while the page scrolls.
- Full-width bands carry the sections. A soft hill edge joins one band to the
  next. The safety boundary is a night band that re-points the ink, accent
  and focus tokens to the terminal values, which stay dark in both themes.
- Depth comes from kit shadows and a tilted `--rm-accent-soft` sheet behind a
  key surface, such as the scene, the chat console or the install toolbox.
- Brand teal and cream are illustration accents only: the doorway and mascot,
  and the teal wavy underline in the home headline. They never mark state.
- Sections may rise into view with scroll-driven animation
  (`animation-timeline: view()`). Content stays visible without support and
  with reduced motion. Animate transform and opacity only.
- Every page ends with the footer: brand and one-line description, product
  links (Install, Docs, Changelog, Chat, npm, GitHub), the creator's profiles
  with icon and visible handle, the openai-oauth credit and the line
  `© <year> John Paul Fusin. Relmio is released under the Apache-2.0 license.`
  The year is computed, never typed.
- Pages never scroll sideways at 320 px, keep 24 px targets and AA contrast in
  both themes, and hide decoration in forced colors.

## Layout

```
┌ rm-topbar ─────────────────────────────────────────────────────────┐
│ brand   nav links                     theme  GitHub  support  menu │
├ rm-split ──────────────────────────────────────────────────────────┤
│ rail            │ rm-panel                                         │
│  rm-stepper     │  header: eyebrow, title, one-line description    │
│  safety summary │  body: the step                                  │
│                 │  footer: Back · secondary · primary action       │
└─────────────────┴──────────────────────────────────────────────────┘
```

- Top bar 56 px. Rail 272 px. Gutter 16 to 32 px, fluid.
- Content width caps at 1216 px; long-form text caps at 46rem.
- The rail holds the stepper and a compact status or safety summary. It never
  holds long notices.
- Below 1024 px the rail moves above the panel and the stepper turns
  horizontal (`rm-stepper--auto`).
- Web pages without a rail use `rm-container` inside `rm-app__main`, and
  full-width bands put their content in an `rm-container`.
- Below 64rem, the panel footer sticks to the bottom of the viewport while its
  panel scrolls past, with a surface fill, top divider and safe-area padding.
  Keep the desktop panel layout unchanged.
- On narrow screens, document scroll padding leaves room for the sticky top
  bar and panel footer when focusing or scrolling to content.

## Navigation

Both apps use the same top bar markup and classes. Only the destinations
differ.

| App | Primary links | Actions |
| --- | --- | --- |
| Wizard | Setup (`/`), This computer (`/local`), Hosting options (`/hosting`), Docs (external, new tab) | Theme switch, GitHub chip with version, Ko-fi support |
| Web | Home, Install, Docs, Changelog, Chat | Theme switch, GitHub chip with stars and version, Ko-fi support |

Rules:

- Mark the current page with `aria-current="page"`. A route wizard such as
  `/supergrok-vps` marks Setup with `aria-current="true"`.
- At 1024 px and wider the links sit in `.rm-nav`. Narrower windows hide
  `.rm-nav` and show the native `<details class="rm-menu">` with the same links.
  Elements with `rm-topbar__wide` hide on narrow windows; the menu repeats
  anything essential.
- External links open in a new tab, show the `external` icon and use
  `rel="noopener noreferrer"`. The accessible name says "opens in a new tab".
- Wizard links between routes keep the private session with
  `bindWizardNavigation` from `src/ui/session.js`. `src/ui/topbar.js` binds
  every `[data-wizard-route]` link and blocks navigation while an operation is
  running.
- The theme switch is the same radio group in both apps: name `color-theme`,
  values `system`, `light`, `dark`, stored under `relmio-color-mode`. An explicit
  choice sets `data-theme` on `<html>`; System removes it.
- Section navigation inside a page uses `rm-sidebar`. Guided flows use
  `rm-stepper`.

Top bar markup (the web renders the same structure from
`web/app/components/ui/TopBar.tsx`):

```html
<header class="rm-topbar">
  <div class="rm-topbar__inner">
    <a class="rm-brand" href="/">
      <img class="rm-brand__logo" src="/relmio-icon-96.png" width="32" height="32" alt="" />
      <span>Relmio</span>
    </a>
    <nav class="rm-nav" aria-label="Primary">
      <ul class="rm-nav__list">
        <li><a class="rm-nav__link" href="/" aria-current="page">Setup</a></li>
      </ul>
    </nav>
    <div class="rm-topbar__actions">
      <!-- theme switch, rm-chip GitHub link, support rm-icon-button -->
      <details class="rm-menu">
        <summary class="rm-icon-button" aria-label="Menu">
          <span class="rm-icon rm-icon--menu" aria-hidden="true"></span>
        </summary>
        <div class="rm-menu__panel"><nav aria-label="Primary">…same links as rm-menu__link…</nav></div>
      </details>
    </div>
  </div>
</header>
```

## Components

All classes start with `rm-`. One class makes a component; a `--modifier`
class picks a variant; ARIA and `data-*` attributes carry state. Base element
styles use `:where()`, so a page stylesheet can override anything without
`!important`. Class names are public API: rename one only together with every
caller in both apps.

| Component | Classes | Use |
| --- | --- | --- |
| App shell | `rm-app`, `rm-app--fit`, `rm-app__main`, `rm-split`, `rm-container` | Page frame; `rm-app--fit` applies the one-screen rule in the wizard and dashboard only |
| Top bar | `rm-topbar`, `rm-brand`, `rm-nav`, `rm-menu`, `rm-topbar__actions` | Global navigation |
| Sidebar | `rm-sidebar`, `rm-sidebar__link` | Views inside a page |
| Stepper | `rm-stepper`, `rm-stepper__item`, `rm-stepper__link`, `rm-stepper__marker` | Progress through a flow; `aria-current="step"`, `data-state="done"` |
| Panel | `rm-panel`, `__header`, `__heading`, `__body`, `__footer` | The working surface of a view |
| Card | `rm-card`, `--flat`, `--muted`, `--compact` | Grouped content |
| Choice | `rm-choice` and its `__icon`, `__title`, `__text` | A selectable option row or card |
| Button | `rm-button`, `--primary`, `--ghost`, `--danger`, `--sm` | Actions; `aria-busy="true"` shows progress |
| Icon button | `rm-icon-button`, `--outline`, `--sm` | Icon-only actions with an accessible name |
| Link | `rm-link`, `--quiet` | Text links |
| Chip | `rm-chip`, `rm-chip__meta` | GitHub link with stars and version |
| Field | `rm-field`, `__label`, `__hint`, `__error`, `rm-input`, `rm-select`, `rm-textarea`, `rm-form-grid`, `rm-fieldset` | Forms |
| Check | `rm-check`, `--boxed`, `rm-check__hint` | Checkbox or radio with its label |
| Segmented | `rm-segmented`, `__item`, `__input` | Theme switch and small exclusive choices |
| Tabs | `rm-tabs__list`, `rm-tabs__tab` | Switch panels in place |
| Callout | `rm-callout`, `--success`, `--warning`, `--danger`, `--neutral`, `__icon`, `__content`, `__title`, `__body`, `__close` | A short message in a view |
| Notice | `rm-notice`, `--info`, `__title`, `__text`, `__toggle`, `__body` | A one-line warning that expands for detail |
| Badge | `rm-badge`, `--accent`, `--success`, `--warning` | Short labels |
| Status | `rm-status`, `rm-status__dot`, `data-tone` | A dot plus a sentence |
| Progress | `rm-progress`, `--indeterminate`, `rm-progress__bar` | Work in progress |
| Definition list | `rm-dl` | Review facts and results |
| Table | `rm-table-wrap`, `rm-table` | Tabular data; the wrap scrolls sideways on narrow screens |
| Terminal | `rm-terminal`, `__bar`, `__actions`, `__body`, `__prompt`, `__note` | Commands; always dark |
| Disclosure | `rm-disclosure`, `--plain`, `rm-disclosure__body` | Optional detail |
| Prose | `rm-prose` | Generated Markdown and long text |
| Type | `rm-display`, `rm-h1`, `rm-h2`, `rm-h3`, `rm-eyebrow`, `rm-lede`, `rm-muted`, `rm-small` | Text styles |
| Icon | `rm-icon` plus `rm-icon--<name>`, sizes `--xs`, `--sm`, `--lg` | Lucide icons drawn in `currentColor` |
| Utilities | `rm-cluster`, `rm-grid`, `rm-push`, `rm-visually-hidden`, `rm-skip-link` | Layout and accessibility helpers |

Icon names: monitor, sun, moon, menu, x, check, check-circle, alert, info,
external, coffee, copy, chevron-down, chevron-right, arrow-right, arrow-left,
arrow-up-right, terminal, server, laptop, shield, lock, book, home, plug, key,
activity, refresh, network, cloud, bot, message, search, box, star, download,
help, list-checks, log-out, settings, github. Add an icon by appending its
Lucide geometry to the token list in the kit and documenting it here. The
hosted footer's social links are the only exception: the web `Icon` component
draws the X, LinkedIn, YouTube and Facebook brand marks from
`simple-icons@13.21.0` (CC0-1.0) as inline SVG.

Component rules:

- One primary button per view, in the panel footer or next to the field it
  submits. Destructive actions use `rm-button--danger` and say what they
  remove.
- Every icon-only control has an accessible name. Decorative icons get
  `aria-hidden="true"`.
- Choices are real controls: a `<button>` with `aria-pressed` or
  `aria-expanded`, a link, or a `<label>` around `rm-choice__input`.
- Fields keep a visible label. Hints and errors connect through
  `aria-describedby`; invalid fields set `aria-invalid="true"`.
- Status never relies on color: a status dot always sits next to text, and
  badges carry words.
- Errors that block progress use `rm-callout--danger` with `role="alert"` and
  take focus when they appear. In a step panel at 1024 px and wider, place the
  error in the panel header beside the step title or in the rail, so it never
  pushes the step past one screen; on narrower screens, place it next to the
  footer actions.
  Passing progress messages use `role="status"`.
- Commands use `rm-terminal`. The copy button announces success through a
  polite live region and does not move focus.
- Long tokens such as fingerprints, hostnames and URLs wrap
  (`overflow-wrap: anywhere` is built into fields, checks, callouts and
  definition lists).

Example step panel:

```html
<section class="rm-panel" aria-labelledby="vps-title">
  <header class="rm-panel__header">
    <div class="rm-panel__heading">
      <span class="rm-eyebrow">Step 2 of 5</span>
      <h2 id="vps-title" class="rm-h1" tabindex="-1">Check your server</h2>
      <p class="rm-muted">Confirm the server identity before you sign in to it.</p>
    </div>
  </header>
  <div class="rm-panel__body">…</div>
  <footer class="rm-panel__footer">
    <button class="rm-button rm-button--ghost" type="button">Back</button>
    <button class="rm-button rm-button--primary rm-push" type="submit">Connect</button>
  </footer>
</section>
```

## Color

Use semantic tokens only. Never write a raw color in a page stylesheet; add a
token to the kit when a new role appears. Hex values and contrast ratios are in
BRANDKIT.md.

| Token | Role |
| --- | --- |
| `--rm-canvas` | Page background |
| `--rm-surface` | Panels, cards, inputs |
| `--rm-surface-muted` | Quiet fills: tracks, table headers, hover |
| `--rm-surface-sunken` | Progress tracks and wells |
| `--rm-ink`, `--rm-ink-muted`, `--rm-ink-subtle` | Text, secondary text, placeholders and decoration |
| `--rm-line`, `--rm-line-strong`, `--rm-field-line` | Dividers, button outlines, form control borders |
| `--rm-accent`, `--rm-accent-hover`, `--rm-on-accent` | Primary action and selection |
| `--rm-accent-soft`, `--rm-accent-line`, `--rm-accent-ink` | Selected backgrounds, borders and text |
| `--rm-focus` | Focus ring |
| `--rm-success`, `--rm-warning`, `--rm-danger` and their `-soft`, `-line` pairs | Status |
| `--rm-terminal-*` | Terminal and code blocks, dark in both themes |
| `--rm-terminal-hover` | Terminal copy-button hover in both themes |
| `--rm-brand-*` | Logo colors for illustration only, never for UI state |

Light theme: pastel yellow surfaces, warm black ink, black primary buttons
with yellow text. Dark theme: black surfaces with no green tint, warm white
ink, yellow primary buttons with black text. Orange is only for warnings, red
only for failures and destructive actions, green only for success. Teal
appears only in the logo and mascot artwork, plus the hosted site's
illustration accents described above. No purple AI gradients, neon glows,
glass panels or decorative gradients.

## Typography

| Role | Family | Size | Weight |
| --- | --- | --- | --- |
| Display (web home headline) | Bricolage Grotesque | `--rm-text-display`, 36 to 60 px; the hosted home hero may reach 76 px | 800 |
| Web page and section titles | Bricolage Grotesque | 30 to 72 px, set per page | 800 |
| Page and step titles | Bricolage Grotesque | `--rm-text-h1`, 24 to 32 px | 760 |
| Section titles | Geist | 20 px | 650 |
| Body | Geist | 16 px | 400 |
| Interface labels | Geist | 14 px | 560 to 650 |
| Hints and metadata | Geist | 13 px | 400 |
| Eyebrows | System monospace | 12 px uppercase, 0.08em tracking | 600 |
| Commands and IDs | System monospace | 14 to 15 px | 400 |

Inputs use 16 px text so mobile browsers do not zoom. Keep body text under 75
characters per line. Use sentence case for headings, buttons and labels.

## Spacing, shape and elevation

- Spacing follows a 4 px grid: `--rm-space-1` (4) to `--rm-space-16` (64).
- Radii: 6 px small labels, 10 px controls, 14 px cards, 18 px panels, full
  round only for badges, chips and status dots.
- Elevation is rare. Cards use `--rm-shadow-sm`, panels `--rm-shadow-md`, menus
  and toasts `--rm-shadow-lg`. Lines carry most hierarchy, especially in dark
  mode.
- Do not nest more than two bordered containers.

## Motion

- Motion confirms a change: selection, a state change, new content. 120 to
  280 ms with `--rm-ease`.
- Animate only `transform` and `opacity`; never width, height, padding or
  position.
- `prefers-reduced-motion: reduce` stops spinners, pulses and slides; the kit
  provides static fallbacks.
- The home illustration may loop. It needs a visible pause control, pauses
  offscreen, and shows a complete still scene for reduced motion or missing
  SVG animation support.
- Hosted-site sections may rise into view as they scroll in. With reduced
  motion they are simply there.

## Copy

- Read the `humanizer` skill before writing interface text.
- Lead with the action or the fact. One idea per sentence. No em dashes in
  interface text.
- Keep these product labels exact and distinct: n8n with ChatGPT sign-in,
  SuperGrok OAuth, n8n Code Sandbox, Codex Chat Adapter, Codex App Server, and
  Local model.
- The ChatGPT bridge is unofficial, private and policy-uncertain; say so where
  the user chooses it. Sign-in is never an OpenAI Platform API key.
- Never imply a capability, permission or test result that has no recorded
  evidence. Hosted chat has no tools, files, commands or browsing.
- Prerelease builds show an `rm-notice` whose summary names the version and
  says "Use a test setup". The details hold the stable fallback command.
  Stable releases show no release notice.
- Label each experimental feature or provider with an `Experimental` badge
  (`rm-badge rm-badge--accent`) beside its name and one short warning that
  names the untested part. Do not repeat the warning on the same screen.

## Accessibility floor

- WCAG 2.2 AA. Text contrast at least 4.5:1, large text and controls at least
  3:1, in both themes. The focus ring is 3 px `--rm-focus` with a 2 px offset.
- Landmarks: one `header`, one `main`, labelled `nav` and `aside`. One `h1`
  per page; headings in order.
- Keyboard: everything reachable in reading order, no traps, visible focus,
  Escape closes menus. Do not reorder focusable content visually.
- Focused or scrolled-to elements must clear sticky controls. On narrow
  screens the document reserves top-bar and footer space through scroll
  padding; check heading focus, skip links and both Tab directions on phones.
- Targets at least 24 x 24 px; primary controls 40 px or taller.
- Do not disable zoom. Content reflows at 320 px wide without sideways
  scrolling.
- Respect `prefers-reduced-motion`, `forced-colors` and `prefers-color-scheme`.

## Implementation rules

Wizard (`src/ui`):

- Link `/relmio-ui.css` first, then any page stylesheet. Page stylesheets hold
  only layout specific to that page.
- Every new file in `src/ui` needs an entry in the server file map in
  `src/web/server.js` and in the package allowlist in
  `test/package-contents.test.js`.
- Keep element IDs, `data-*` hooks and class names that scripts or tests use.
  Search `src/ui/*.js` and `test/` before renaming.
- Write untrusted text with `textContent`, never `innerHTML`.
- Never weaken a safety step: host-key confirmation before authentication,
  the reviewed plan, and the final confirmation before remote writes.

Web (`web/`):

- Import `./relmio-ui.css` in the root layout before other styles.
- Use the React components in `web/app/components/ui/`. They render the kit
  markup; add to them instead of creating new styling systems.
- Page-specific styles go in a CSS module next to the page and use kit tokens.
  Styles shared across site pages, such as section titles, hill edges and
  scroll reveals, live in `app/site.module.css`.
- The root layout renders `SiteFooter` after every page. Keep its links and
  computed copyright year.
- Keep install commands and security attributes exact; tests guard them.

## Verification

For each changed view, before handing off:

1. Run it: the wizard through `npm run preview` (sanitized, no live sign-in)
   or a QA launcher with fake services; the web app with `next dev`.
2. Use one headless browser tab and close it afterwards. Do not drive the
   owner's personal browser for routine checks.
3. Check 1280 x 720, 1440 x 900, 1024 x 768 and 390 x 844 in light and dark
   themes. In the wizard and dashboard, measure the one-screen rule. On the
   hosted site, check that the page scrolls naturally and add 320 px wide.
   Everywhere, measure horizontal overflow, check focus order with the
   keyboard, and read the console.
4. Audit against the Front-End Checklist with the `frontend-checklist-global`
   skill. Report findings with rule ids.
5. Run the affected root and web tests. Tests guard behavior, not class names
   or wording.

## Home illustration

The home page keeps the Doorway scene: the green two-eyed mascot, its cream
doorway, a VPS cloud and a local workshop, drawn as original vectors. It is
the hero of the scrolling home page, a wide framed window below the headline
and the install action.
Preserve the original logo files exactly; the scene is separate artwork. Its
backdrop follows the theme: pastel yellow sky and ochre hills by day, black
sky and charcoal hills by night. Night mode may add a moon, stars, a lit
window and the mascot's sleep cap. Keep the pause control and the still
fallback described under Motion.

## Do and don't

Do:

- Reuse a kit component before writing new CSS.
- Write the shortest copy that keeps the meaning, then test it in the layout.
- Put the next action where the eye ends: the panel footer, right side.

Don't:

- Add a second component library, CSS framework or icon set.
- Stack warnings. One notice per view, with details inside it.
- Use a scrollbar to fit content at the target sizes.
- Center everything, use four equal feature cards with an oversized banner, or
  decorate with badges.
