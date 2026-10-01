import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "./components/ui/Icon";
import styles from "./not-found.module.css";

export const metadata: Metadata = {
  title: "Page not found | Relmio",
  alternates: { canonical: null },
  openGraph: { url: null },
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <main id="main-content" className="rm-app__main" tabIndex={-1}>
      <div className={`rm-container ${styles.page}`}>
        {/* The home scene's doorway, empty: the mascot is elsewhere. */}
        <svg className={styles.art} viewBox="-12 -12 248 260" aria-hidden="true">
          <ellipse className={styles.shadow} cx="112" cy="226" rx="128" ry="12" />
          <path
            className={styles.doorway}
            d="M0 220V102C0 39 42 0 112 0s112 39 112 102v118h-46V108c0-40-22-63-66-63s-66 23-66 63v112z"
          />
        </svg>
        <div className={styles.copy}>
          <p className="rm-eyebrow">404</p>
          <h1 className={styles.title}>Page not found</h1>
          <p className="rm-lede">That address does not lead to a page here.</p>
          <div className={styles.actions}>
            <Link className="rm-button rm-button--primary" href="/">
              <Icon name="home" size="sm" />
              Home
            </Link>
            <Link className="rm-button" href="/install">
              Install
            </Link>
            <Link className="rm-button" href="/docs">
              Docs
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
