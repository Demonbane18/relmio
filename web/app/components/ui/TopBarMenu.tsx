"use client";

import { usePathname } from "next/navigation";
import { type ReactNode, useEffect, useRef } from "react";
import { Icon } from "./Icon";

/** Native <details> menu for narrow windows. Closes on Escape, outside clicks
    and navigation, like the wizard's topbar.js. */
export function TopBarMenu({ children }: { children: ReactNode }) {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const pathname = usePathname();

  useEffect(() => {
    if (menuRef.current) menuRef.current.open = false;
  }, [pathname]);

  useEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || !menu?.open) return;
      menu.open = false;
      menu.querySelector<HTMLElement>(":scope > summary")?.focus();
    }

    function closeOnOutsideClick(event: MouseEvent) {
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) {
        menu.open = false;
      }
    }

    menu.addEventListener("keydown", closeOnEscape);
    document.addEventListener("click", closeOnOutsideClick);
    return () => {
      menu.removeEventListener("keydown", closeOnEscape);
      document.removeEventListener("click", closeOnOutsideClick);
    };
  }, []);

  return (
    <details className="rm-menu" ref={menuRef}>
      <summary className="rm-icon-button" aria-label="Menu">
        <Icon name="menu" />
      </summary>
      <div className="rm-menu__panel">{children}</div>
    </details>
  );
}
