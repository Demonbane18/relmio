"use client";

import type { AnchorHTMLAttributes, MouseEvent } from "react";

type HashLinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  focusTarget?: boolean;
  targetId: string;
};

export function HashLink({
  focusTarget = false,
  targetId,
  onClick,
  ...props
}: HashLinkProps) {
  const href = `#${targetId}`;

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);

    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    ) {
      return;
    }

    const target = document.getElementById(targetId);
    if (!target) {
      return;
    }

    event.preventDefault();
    const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollIntoView({
      behavior: prefersReducedMotion ? "auto" : "smooth",
      block: "start",
    });
    if (focusTarget) {
      target.focus({ preventScroll: true });
    }

    if (window.location.hash === href) {
      window.history.replaceState(null, "", href);
    } else {
      window.history.pushState(null, "", href);
    }
  };

  return <a {...props} href={href} onClick={handleClick} />;
}
