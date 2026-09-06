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
  "Bring your AI sign-ins to your tools. Guided setup for n8n and local connections, with every credential kept where it belongs.";

const directionContract = `<!--
THESIS
Relmio opens a door between the AI people use and the tools where they make things.

OWN-WORLD
The public site is a playful illustrated world built around Relmio's original doorway mascot. Operational surfaces remain clear, calm setup guides.

STORY
The interface keeps n8n with ChatGPT sign-in, the unreleased Grok Build OAuth candidate, n8n Code Sandbox, Codex Chat Adapter, and Codex App Server distinct and truthful.

FIRST VIEWPORT
A short invitation, one install action, and a broad animated vector scene introduce the product. The detailed connection guide follows the story.

FORM
Doorway Playground direction, governed by DESIGN.md and Hallmark; upright Bricolage Grotesque, Geist body, warm cream, pine ink, and the existing teal logo. Coordinated scene motion has a pause control, an offscreen pause, and immediate reduced-motion support. Original logo artwork and proportions remain fixed.

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
    keywords: ["ai", "n8n", "oauth", "local tools", "model relay"],
    icons: {
      icon: "/relmio-icon-rounded.svg",
      shortcut: "/relmio-icon-rounded.svg",
    },
    openGraph: {
      title,
      description,
      type: "website",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "Relmio: Bring your AI sign-ins to your tools." }],
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
