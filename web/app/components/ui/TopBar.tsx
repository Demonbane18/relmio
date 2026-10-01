import Image from "next/image";
import Link from "next/link";
import { Icon } from "./Icon";
import { PrimaryNav } from "./PrimaryNav";
import { RepositoryChip } from "./RepositoryChip";
import { SupportLink } from "./SupportLink";
import { ThemeSwitch } from "./ThemeSwitch";
import { TopBarMenu } from "./TopBarMenu";

/** The shared Relmio top bar. The local wizard renders the same markup in
    src/ui/*.html; see DESIGN.md, Navigation. */
export function TopBar() {
  return (
    <header className="rm-topbar">
      <div className="rm-topbar__inner">
        <Link className="rm-brand" href="/" aria-label="Relmio home">
          <Image
            className="rm-brand__logo"
            src="/relmio-icon-96.png"
            alt=""
            width={32}
            height={32}
            priority
            unoptimized
          />
          <span>Relmio</span>
        </Link>
        <PrimaryNav variant="bar" />
        <div className="rm-topbar__actions">
          <ThemeSwitch />
          <RepositoryChip className="rm-topbar__wide" />
          <SupportLink className="rm-topbar__wide" />
          <TopBarMenu>
            <PrimaryNav variant="menu" />
            <ul className="rm-menu__list rm-menu__section">
              <li>
                <a
                  className="rm-menu__link"
                  href="https://github.com/Demonbane18/relmio"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="github" size="sm" />
                  GitHub
                  <span className="rm-visually-hidden"> (opens in a new tab)</span>
                </a>
              </li>
              <li>
                <a
                  className="rm-menu__link"
                  href="https://ko-fi.com/paldogies"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="coffee" size="sm" />
                  Support on Ko-fi
                  <span className="rm-visually-hidden"> (opens in a new tab)</span>
                </a>
              </li>
            </ul>
          </TopBarMenu>
        </div>
      </div>
    </header>
  );
}
