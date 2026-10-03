import Image from "next/image";
import Link from "next/link";
import { Icon, type IconName } from "./Icon";
import styles from "./SiteFooter.module.css";

const productLinks = [
  { href: "/install", label: "Install" },
  { href: "/docs", label: "Docs" },
  { href: "/changelog", label: "Changelog" },
  { href: "https://www.npmjs.com/package/relmio", label: "npm", external: true },
  { href: "https://github.com/Demonbane18/relmio", label: "GitHub", external: true },
] as const;

export const creatorLinks: ReadonlyArray<{ href: string; network: string; handle: string; icon: IconName }> = [
  { href: "https://github.com/Demonbane18", network: "GitHub", handle: "Demonbane18", icon: "github" },
  { href: "https://x.com/fusheenn", network: "X", handle: "@fusheenn", icon: "brand-x" },
  {
    href: "https://www.linkedin.com/in/john-paul-fusin-35846714a/",
    network: "LinkedIn",
    handle: "in/john-paul-fusin-35846714a",
    icon: "linkedin",
  },
  { href: "https://www.youtube.com/@harness.engineer", network: "YouTube", handle: "@harness.engineer", icon: "youtube" },
  { href: "https://www.facebook.com/fusin.automation/", network: "Facebook", handle: "fusin.automation", icon: "facebook" },
  { href: "https://ko-fi.com/paldogies", network: "Ko-fi", handle: "Support Relmio", icon: "coffee" },
];

function NewTabNote() {
  return <span className="rm-visually-hidden"> (opens in a new tab)</span>;
}

/** The shared site footer on every web page: product links, the creator's
    profiles and the copyright line. The ridge and mascot are decoration. */
export function SiteFooter() {
  const year = new Date().getFullYear();

  return (
    <footer className={styles.footer}>
      <div className={styles.ridge} aria-hidden="true">
        <svg className={styles.hills} viewBox="0 0 1200 80" preserveAspectRatio="none">
          <path className={styles.hillBack} d="M0 50 C 180 18 330 22 520 44 C 720 66 930 10 1200 34 V 80 H 0 Z" />
          <path className={styles.hillFront} d="M0 66 C 240 44 420 58 620 64 C 840 72 1020 46 1200 58 V 80 H 0 Z" />
        </svg>
        {/* The doorway and mascot from the home scene, standing on the ridge. */}
        <svg className={styles.mascot} viewBox="-6 -6 236 232">
          <path
            className={styles.doorway}
            d="M0 220V102C0 39 42 0 112 0s112 39 112 102v118h-46V108c0-40-22-63-66-63s-66 23-66 63v112z"
          />
          <g transform="translate(64 94)">
            <path className={styles.mascotBody} d="M0 126V47C0 17 18 0 48 0s48 17 48 47v79z" />
            <g className={styles.eyes}>
              <circle cx="30" cy="47" r="10" />
              <circle cx="66" cy="47" r="10" />
            </g>
          </g>
        </svg>
      </div>

      <div className={`rm-container ${styles.inner}`}>
        <div className={styles.grid}>
          <div className={styles.about}>
            <Link className="rm-brand" href="/" aria-label="Relmio home">
              <Image
                className="rm-brand__logo"
                src="/relmio-icon-96.png"
                alt=""
                width={32}
                height={32}
                unoptimized
              />
              <span>Relmio</span>
            </Link>
            <p className={styles.tagline}>
              Guided setup for n8n and local tools that keeps every credential where it belongs.
            </p>
          </div>

          <nav className={styles.column} aria-labelledby="footer-product-title">
            <h2 className={styles.columnTitle} id="footer-product-title">
              Product
            </h2>
            <ul className={styles.linkList}>
              {productLinks.map((link) => (
                <li key={link.href}>
                  {"external" in link ? (
                    <a className={styles.link} href={link.href} target="_blank" rel="noopener noreferrer">
                      {link.label}
                      <Icon name="arrow-up-right" size="xs" />
                      <NewTabNote />
                    </a>
                  ) : (
                    <Link className={styles.link} href={link.href}>
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>

          <nav className={styles.column} aria-labelledby="footer-creator-title">
            <h2 className={styles.columnTitle} id="footer-creator-title">
              Made by John Paul Fusin
            </h2>
            <ul className={styles.socialList}>
              {creatorLinks.map((link) => (
                <li key={link.href}>
                  <a className={styles.social} href={link.href} target="_blank" rel="noopener noreferrer">
                    <span className={styles.socialIcon}>
                      <Icon name={link.icon} size="sm" />
                    </span>
                    <span className={styles.socialText}>
                      <span className={styles.socialNetwork}>{link.network}</span>
                      <span className={styles.socialHandle}>{link.handle}</span>
                    </span>
                    <NewTabNote />
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        </div>

        <p className={styles.copyright}>
          © {year} John Paul Fusin. Relmio is released under the{" "}
          <a
            className="rm-link rm-link--quiet"
            href="https://github.com/Demonbane18/relmio/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
          >
            Apache-2.0 license
            <Icon name="external" size="xs" className={styles.externalIcon} />
            <NewTabNote />
          </a>
          .
        </p>
      </div>

      <p className={styles.wordmark} aria-hidden="true">
        Relmio
      </p>
    </footer>
  );
}
