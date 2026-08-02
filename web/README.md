# Relmio Web

The hosted Relmio product page and authenticated chat demo. It presents the
relay model, explains its safety boundaries, and lets a visitor connect a
supported ChatGPT account before making a request.

## Local development

Requires Node.js 22.13 or newer.

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
request-bound chat integration, security headers, and starter-template cleanup.

## Chat request path

1. `SignInWithChatGPT` connects the visitor in their browser.
2. `openaiAuthHeaders()` attaches request-bound credentials to `/api/chat`.
3. The server route reads those credentials directly from the incoming request.
4. The AI SDK streams the completion back to the browser.

The route does not log credentials or create an OpenAI Platform API key. It
rejects empty prompts, caps prompt and response sizes, disables response caching,
and returns generic authentication errors.

## Deployment

This application is built with Vinext for ChatGPT Sites hosting. The local
`.openai/hosting.json` file contains the opaque Sites project identifier and is
intentionally ignored by Git.
