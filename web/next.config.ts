import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The Content-Security-Policy header comes from proxy.ts with a per-request nonce.
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
      ],
    }, {
      // Every page preloads both fonts. Their file names carry no hash, so they
      // are cached for 30 days rather than marked immutable.
      source: "/fonts/:path*",
      headers: [{ key: "Cache-Control", value: "public, max-age=2592000, stale-while-revalidate=31536000" }],
    }];
  },
  // Browsers and crawlers still ask for /favicon.ico.
  async rewrites() {
    return [{ source: "/favicon.ico", destination: "/relmio-icon-96.png" }];
  },
  // The old chat address lands on the home page's notice that hosted chat is off.
  async redirects() {
    return [{ source: "/chat", destination: "/#chat", permanent: true }];
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
