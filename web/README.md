# Relmio Web

The hosted Relmio product page and documentation. It presents the relay model,
explains its safety boundaries, and links to the local install. Hosted chat and
its ChatGPT sign-in remain off; a public hosted integration has a separate
registration and runtime contract.

The installed wizard uses the documented local OSS SIWC flow with dynamic
registration. That flow needs no commercial approval, partner client or client
secret. Identity, consent to use a ChatGPT plan and completed inference are
separate checks; account eligibility and provider limits still apply.

## Local development

Requires Node.js 24.x.

```bash
npm install
npm run dev
```

The local site runs at `http://localhost:3000`.

## Release checks

```bash
npm run lint
npm run typecheck
npm test
npm run build:vercel
npm audit --audit-level=high
```

`npm test` checks the generated UI kit and docs, builds the Vinext rollback
application, and tests its rendered pages and behavior. `npm run build:vercel`
builds the Next.js application that ships to Vercel. Rendered tests against
Vinext do not replace a smoke check of the Next.js production build.

## Home connections

The connection selector uses native CSS for the selected rail, packet and
detail. Effects use the kit's 180 ms and 280 ms durations, transform and
opacity only, with a static result for reduced motion. A route change replaces
the old detail immediately; it no longer waits for an exit animation.
The separate Doorway hero retains its documented looping-scene exception.

Claude is labelled Experimental. Its provider notice and hosted guide link
stay visible while other routes are selected. The Claude detail distinguishes
the VPS wizard from the macOS/Linux-only companion and command-line setup,
and keeps sign-in in the owner's terminal. Product facts come from
`../docs/claude-subscription.md`.

## Chat route

`/api/chat` answers every method with `410 Gone` and `Cache-Control: no-store`.
It does not read the request, use credentials, call OpenAI, or log anything.
The home page's `#chat` section explains the change and can delete the old
hosted sign-in (IndexedDB database `openai-oauth`) from the visitor's browser.

## Deployment

Vercel serves the production site at <https://relmio.jpfusin.tech>.
`vercel.json` selects Next.js, installs with `npm ci --ignore-scripts`, and runs
`npm run build:vercel` on Node.js 24. HTML keeps the per-request nonce Content
Security Policy from `proxy.ts`; pages are dynamically rendered.

Vinext and the Cloudflare Worker entry remain for the ChatGPT Sites rollback
build and its tests. The tracked `.openai/hosting.json` file supplies the Sites
project identifier and storage binding names to `vite.config.ts`.

## Generated documentation

Run `npm run docs:generate` after changing the repository guides or changelog.
It refreshes `app/docs/generated-content.ts` and `app/docs/generated-sections.json`;
`npm run docs:check` checks both. Guide entries in `scripts/generate-docs.mjs`
can set a short plain-text `summary` for index cards and metadata.

Docs search loads the section index from the site's own build on first focus.
It matches plain substrings in headings and section text, then links to the
matching headings below the guide results.
