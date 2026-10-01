import { useEffect, useState } from "react";

// A heading counts as current once its top is this close to the top of the
// scrolling area. Anchor jumps land 24px below it (scroll-margin-top).
const settleOffset = 48;

/** The id of the heading the reader is in, for highlighting a table of
    contents. Works whether the reading pane or the page scrolls. */
export function useActiveSection(ids: readonly string[], enabled: boolean) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const idKey = ids.join(" ");

  useEffect(() => {
    if (!enabled || idKey === "") return;
    let frame = 0;

    const update = () => {
      frame = 0;
      const headings = idKey
        .split(" ")
        .map((id) => document.getElementById(id))
        .filter((heading): heading is HTMLElement => heading !== null);
      if (headings.length === 0) return;

      const pane = headings[0].closest<HTMLElement>("[data-reading-pane]");
      const paneScrolls = pane !== null && /auto|scroll/u.test(getComputedStyle(pane).overflowY);
      const scroller = paneScrolls ? pane : document.documentElement;
      const top = paneScrolls
        ? pane.getBoundingClientRect().top
        : (document.querySelector(".rm-topbar")?.getBoundingClientRect().bottom ?? 0);

      let current: string | null = null;
      for (const heading of headings) {
        if (heading.getBoundingClientRect().top - top > settleOffset) break;
        current = heading.id;
      }
      const atEnd =
        scroller.scrollTop > 0 &&
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
      setActiveId(atEnd ? headings[headings.length - 1].id : current);
    };

    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    };

    schedule();
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("hashchange", schedule);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
      window.removeEventListener("hashchange", schedule);
    };
  }, [idKey, enabled]);

  return activeId;
}
