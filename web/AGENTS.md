# Relmio web app

Follow `../DESIGN.md` and `../BRANDKIT.md` for every interface change. The web
app and the local wizard share one component kit:

- `app/relmio-ui.css` is a generated copy of `../src/ui/relmio-ui.css`. Edit the
  source, then run `npm run ui:sync`. `npm run ui:check` (part of `npm test`)
  fails when the copy is stale. The script also copies the fonts and logo files.
- Build pages from the kit classes (`rm-*`) and the React components in
  `app/components/ui/`: `TopBar`, `PrimaryNav`, `ThemeSwitch`, `RepositoryChip`,
  `SupportLink`, `Icon`, `CopyButton` and `Callout`. Do not add another
  component library or CSS framework.
- The root layout renders the shared top bar and the `rm-app rm-app--fit` shell.
  Pages render only their `<main id="main-content" className="rm-app__main">`.
- Page styles live in a CSS module next to the page and use `--rm-*` tokens
  only. No raw colors.
- Keep the one-screen rule from `DESIGN.md`: no page scrollbar at 1024 x 768
  and larger; docs and changelog scroll only inside their reading pane.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
