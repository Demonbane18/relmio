import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "./relmio.css";
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

const title = "Relmio | AI routes with visible boundaries";
const description =
  "Route model API requests, build an n8n code sandbox companion, or connect supported Codex clients without collapsing their credential boundaries.";

const directionContract = `<!--
THESIS
Every request has a visible source, credential boundary, route, and destination.

OWN-WORLD
Relmio is a calm signal desk for self-hosted AI infrastructure, not a generic AI landing page.

STORY
The interface makes Model Relay, n8n Code Sandbox Builder, Codex Chat Adapter, and Codex App Server distinct, selectable, and truthful.

FIRST VIEWPORT
An asymmetric editorial introduction and an interactive relay topology explain the product before supporting detail.

FORM
Signal Plotter direction; concept seed 95cdc256; muted teal, graphite, warm canvas, semantic amber; motion expresses route and state.

FINISH
unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, and DESIGN.md
-->`;

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const metadataBase = new URL(`${protocol}://${host}`);
  const imageUrl = new URL("/og.png", metadataBase).toString();

  return {
    metadataBase,
    title,
    description,
    applicationName: "Relmio",
    keywords: ["ai", "chatgpt", "codex", "openai"],
    icons: {
      icon: "/relmio-icon-rounded.svg",
      shortcut: "/relmio-icon-rounded.svg",
    },
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "Relmio" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
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
        <script
          id="impeccable-direction-contract"
          type="text/plain"
        >
          {directionContract}
        </script>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
