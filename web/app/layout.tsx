import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";
import { Providers } from "./providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const title = "Relmio | Your ChatGPT plan, safely relayed";
const description =
  "Set up a separate private OpenAI-compatible sidecar for an existing self-hosted n8n deployment, or try the request-bound hosted chat.";

function isLoopbackHost(host: string) {
  return (
    host === "localhost" ||
    host.startsWith("localhost:") ||
    host === "127.0.0.1" ||
    host.startsWith("127.0.0.1:") ||
    host === "[::1]" ||
    host.startsWith("[::1]:")
  );
}

const directionContract = `<!--
THESIS: Relmio makes an invisible relay legible as a verified route, refusing the generic SaaS hero and card grid.
OWN-WORLD: Warm paper surfaces, midnight ink, relay teal, graphite seams, and precise signal spines form a recognizable Patchbay Ledger.
STORY: Understand the route, verify its boundaries, choose hosted or local, and keep control at every trust gate.
FIRST VIEWPORT: A 5/7 split pairs a concise promise and primary local action with the dominant private-route panel; the safety ledger follows immediately.
FORM: Signal Spine, first of three approved compositions, from candidate 5 and seed c4426c7c.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`;

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (isLoopbackHost(host) ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const imageUrl = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title,
    description,
    applicationName: "Relmio",
    keywords: ["ai", "chatgpt", "codex", "openai"],
    icons: {
      icon: "/relmio-mark.svg",
      shortcut: "/relmio-mark.svg",
    },
    openGraph: {
      title,
      description:
        "A visible, reviewable path from local setup to a private n8n sidecar.",
      type: "website",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "Relmio" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description:
        "A visible, reviewable path from local setup to a private n8n sidecar.",
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <template
          data-design-contract="c4426c7c"
          dangerouslySetInnerHTML={{ __html: directionContract }}
        />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
