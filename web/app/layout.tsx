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

const title = "Relmio | Connect local AI tools safely";
const description =
  "Connect n8n, OpenAI API tools, and supported Codex clients while keeping each sign-in, key, and connection separate.";

const directionContract = `<!--
THESIS
Every option shows where it starts, which sign-in or key it uses, how it connects, and where it ends.

OWN-WORLD
Relmio is a calm setup guide for local AI tools, not a generic AI landing page.

STORY
The interface keeps n8n with ChatGPT sign-in, the OpenAI API, n8n Code Sandbox, Codex Chat Adapter, and Codex App Server distinct and truthful.

FIRST VIEWPORT
An editorial introduction and an interactive connection map explain the options before the supporting detail.

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
