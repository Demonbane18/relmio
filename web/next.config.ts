import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), browsing-topics=()" },
      ],
    }];
  },
  // The hosted chat lives on the home page again.
  async redirects() {
    return [{ source: "/chat", destination: "/#chat", permanent: true }];
  },
  turbopack: {
    root: process.cwd(),
  },
};

export default nextConfig;
