<!-- ASTRYX:START -->
Astryx v0.2.0 · 90+ components
CLI: run commands as `npx astryx <cmd>`.

SETUP (once, in the app entry) — required for styled Astryx components:
  import "@astryxdesign/core/reset.css";
  import "@astryxdesign/core/astryx.css";
<!-- ASTRYX:END -->

## Project UI guidance

- Use existing Astryx components and project tokens for matching UI work.
  For a local fix, inspect the affected component and preserve surrounding
  conventions; do not scaffold a page or rewrite unrelated markup.
- For an unfamiliar component or changed API usage, consult
  `npx astryx component <Name>` or `npx astryx search "<thing>"`.
- For a new page or substantial layout, use `npx astryx build "<idea>"` and
  `npx astryx template <name>` as references. Choose the shell and regions
  before filling the layout; consult `npx astryx docs layout` if needed.
- Prefer component props, then token-based style/className. Add semantic HTML
  or scoped styling when accessibility or behavior requires it. Do not replace
  unrelated div/span markup, CSS, or values merely to satisfy a cosmetic rule.
- Use rows for dense data, StatusDot/Token for status, and Badge for counts or
  enumerated states. Keep brand/accent changes in `npx astryx theme` rather
  than overriding `--color-*` in `:root`. Consult `npx astryx docs tokens` for
  unfamiliar tokens; do not assume a StyleX/Tailwind compiler is configured.
- For an authorized Astryx core upgrade, follow `npx astryx upgrade --apply`.
  Preserve these project-specific rules when generated instructions refresh.
- Verify changed browser behavior in Opera GX at relevant widths, including
  keyboard navigation and accessible names. Continue fixes within the requested
  scope; follow root authorization boundaries for SSH/OAuth/provider/deployment
  actions and any explicit guided-mode or user-review pause.
