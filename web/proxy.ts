import { NextResponse, type NextRequest } from "next/server";

/** Sends a per-request nonce Content Security Policy. Next.js reads the nonce
    from the request's policy header and adds it to its own scripts; the root
    layout reads `x-nonce` for the theme bootstrap. Network calls stay on the
    site or at OpenAI; Firefox's extension check uses one loopback frame. */
export function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  // React's development build needs eval for its debugging stacks.
  const devEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self' https://auth.openai.com",
    "frame-src http://localhost:1455/openai-oauth/installed",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("content-security-policy", policy);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("content-security-policy", policy);
  return response;
}

export const config = {
  // API responses and build assets need no document policy.
  matcher: ["/((?!api/|_next/static|_next/image|favicon.ico).*)"],
};
