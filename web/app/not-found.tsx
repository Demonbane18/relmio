import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Page not found | Relmio",
  alternates: { canonical: null },
  openGraph: { url: null },
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main id="main-content" className="rm-app__main" tabIndex={-1}>
      <div className="rm-container">
        <section className="rm-panel">
          <div className="rm-panel__header">
            <div className="rm-panel__heading">
              <p className="rm-eyebrow">404</p>
              <h1 className="rm-h1">Page not found</h1>
              <p className="rm-muted">That address does not lead to a page here.</p>
            </div>
          </div>
          <div className="rm-panel__body rm-cluster">
            <Link className="rm-link" href="/">Home</Link>
            <Link className="rm-link" href="/install">Install</Link>
            <Link className="rm-link" href="/docs">Docs</Link>
          </div>
        </section>
      </div>
    </main>
  );
}
