import type { Metadata } from "next";
import { headers } from "next/headers";
import { pageMetadata } from "./page-metadata";
import { preload } from "react-dom";
import "./relmio-ui.css";
import { SiteFooter } from "./components/ui/SiteFooter";
import { TopBar } from "./components/ui/TopBar";
import { Providers } from "./providers";
import { requestOrigin } from "./request-origin";

const title = "Relmio | Connect local AI tools safely";
const description =
  "Bring your AI sign-ins to your tools. Guided setup for n8n and local connections, with every credential kept where it belongs.";

// Applies a saved Light or Dark choice before first paint; System needs no attribute.
const themeBootstrap =
  'try{var m=localStorage.getItem("relmio-color-mode");if(m==="light"||m==="dark")document.documentElement.dataset.theme=m}catch(e){}';

export async function generateMetadata(): Promise<Metadata> {
  return {
    metadataBase: await requestOrigin(),
    ...pageMetadata(title, description, "/"),
    applicationName: "Relmio",
    keywords: ["ai", "n8n", "oauth", "local tools", "model relay"],
    icons: {
      icon: [
        { url: "/relmio-icon-rounded.svg", type: "image/svg+xml" },
        { url: "/relmio-icon-96.png", type: "image/png", sizes: "96x96" },
      ],
      apple: "/relmio-icon.png",
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // proxy.ts sets the per-request nonce that the Content Security Policy allows.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  preload("/fonts/geist-latin.woff2", { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  preload("/fonts/bricolage-grotesque-latin.woff2", { as: "font", type: "font/woff2", crossOrigin: "anonymous" });

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Browsers hide nonce values from the DOM, so hydration cannot compare them. */}
        <script nonce={nonce} suppressHydrationWarning dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
        <Providers>
          {/* The hosted site scrolls as a normal page; the one-screen fit shell
              (rm-app--fit) belongs to the local wizard only. */}
          <div className="rm-app">
            <a className="rm-skip-link" href="#main-content">
              Skip to content
            </a>
            <TopBar />
            {children}
            <SiteFooter />
          </div>
        </Providers>
      </body>
    </html>
  );
}
