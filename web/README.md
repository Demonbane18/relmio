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
npm test
npm run lint
npm audit --omit=dev --audit-level=high
```

`npm test` performs a production build and verifies the rendered landing page,
the turned-off chat route, security headers, and starter-template cleanup.

## Chat route

`/api/chat` answers every method with `410 Gone` and `Cache-Control: no-store`.
It does not read the request, use credentials, call OpenAI, or log anything.
The home page's `#chat` section explains the change and can delete the old
hosted sign-in (IndexedDB database `openai-oauth`) from the visitor's browser.

## Deployment

This application is built with Vinext for ChatGPT Sites hosting. The local
`.openai/hosting.json` file contains the opaque Sites project identifier and is
intentionally ignored by Git.
