"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const primaryNavigation = [
  { href: "/", label: "Home" },
  { href: "/install", label: "Install" },
  { href: "/docs", label: "Docs" },
  { href: "/changelog", label: "Changelog" },
] as const;

function currentState(pathname: string, href: string) {
  if (pathname === href) return "page" as const;
  if (href !== "/" && pathname.startsWith(`${href}/`)) return "true" as const;
  return undefined;
}

/** Primary links for the wide bar (`bar`) or the compact menu (`menu`). */
export function PrimaryNav({ variant }: { variant: "bar" | "menu" }) {
  const pathname = usePathname() ?? "/";
  const linkClass = variant === "menu" ? "rm-menu__link" : "rm-nav__link";

  return (
    <nav className={variant === "bar" ? "rm-nav" : undefined} aria-label="Primary">
      <ul className={variant === "menu" ? "rm-menu__list" : "rm-nav__list"}>
        {primaryNavigation.map((item) => (
          <li key={item.href}>
            <Link className={linkClass} href={item.href} aria-current={currentState(pathname, item.href)}>
              {item.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
