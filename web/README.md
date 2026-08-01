# Relmio Web

The hosted Relmio product page, installation guide, and request-bound chat
demo deployed on Vercel. The interface uses the Signal Spine composition: a
visible private route, four verifiable boundaries, and five deliberate setup
gates instead of a generic feature-card landing page.

The React surface uses `@astryxdesign/core`, the neutral Astryx theme, and the
generated Relmio theme in `app/relmio.*`. The npm wizard remains vanilla
HTML/CSS/JavaScript so it launches quickly, works offline after startup, and
does not ship the React runtime.

## Local development

Requires Node.js 22.13 or newer.

```bash
npm ci --ignore-scripts
npm run dev
```

The local site runs at `http://localhost:3000`.

## Release checks

```bash
npm test
npm run lint
npm run typecheck
npm run build:vercel
npm audit --omit=dev --audit-level=high
```

`npm test` performs the Vinext production build and verifies the rendered
landing and install pages, Astryx setup, request-bound chat integration,
security headers, and starter-template cleanup. `npm run build:vercel` runs the
Next.js production build used by Vercel.

Run `npx astryx doctor` after changing Astryx dependencies or the generated
theme. The custom theme source is `app/relmio-theme.ts`; commit its generated
CSS, JavaScript, and type declarations with the source.

## Chat request path

1. `SignInWithChatGPT` connects the visitor in their browser.
2. `openaiAuthHeaders()` attaches request-bound credentials to `/api/chat`.
3. The server route reads those credentials directly from the incoming request.
4. The AI SDK streams the completion back to the browser.

The route does not log credentials or create an OpenAI Platform API key. It
rejects empty prompts, caps prompt and response sizes, disables response caching,
and returns generic authentication errors.

## Deployment

Vercel uses the Next.js build. Vinext remains the fast local/test build so the
same routes are verified in both environments. Deploy only after lint,
typecheck, both production builds, rendered-page tests, and browser QA pass.
