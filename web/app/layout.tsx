import type { Metadata } from "next";
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
      icon: "/relmio-icon-rounded.svg",
      shortcut: "/relmio-icon-rounded.svg",
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  preload("/fonts/geist-latin.woff2", { as: "font", type: "font/woff2", crossOrigin: "anonymous" });
  preload("/fonts/bricolage-grotesque-latin.woff2", { as: "font", type: "font/woff2", crossOrigin: "anonymous" });

  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrap }} />
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
