import { Button } from "@astryxdesign/core/Button";
import { Link } from "@astryxdesign/core/Link";
import Image from "next/image";

const navigation = [
  { href: "/#how-it-works", label: "How it works" },
  { href: "/#safety", label: "Safety" },
  { href: "/install", label: "Install" },
  {
    href: "https://github.com/Demonbane18/relmio",
    label: "GitHub",
    external: true,
  },
];

export function SiteHeader() {
  return (
    <header className="site-header">
      <nav className="site-header-inner" aria-label="Primary navigation">
        <Link className="brand-link" href="/" color="primary" isStandalone>
          <Image
            src="/relmio-mark.svg"
            alt=""
            width={44}
            height={44}
            priority
          />
          <span>Relmio</span>
        </Link>

        <ul className="primary-links">
          {navigation.map((item) => (
            <li key={item.href}>
              <Link
                href={item.href}
                color="secondary"
                isExternalLink={item.external}
                isStandalone
              >
                {item.label}
              </Link>
            </li>
          ))}
        </ul>

        <Button
          className="header-action"
          href="/#chat"
          label="Try hosted chat"
          size="lg"
          variant="primary"
        />
      </nav>
    </header>
  );
}
