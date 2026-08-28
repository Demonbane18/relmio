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

const title = "Relmio | Your ChatGPT plan, relayed";
const description =
  "Connect a supported ChatGPT sign-in to a secure hosted chat and OpenAI-compatible workflows, beginning with self-hosted n8n.";

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
      description:
        "A private path from ChatGPT sign-in to the AI tools you already use.",
      type: "website",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "Relmio" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description:
        "A private path from ChatGPT sign-in to the AI tools you already use.",
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
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
