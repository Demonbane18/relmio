"use client";

import { useMemo } from "react";
import type { ReleaseSeries } from "../docs/markdownText";
import { useActiveSection } from "../docs/useActiveSection";
import styles from "../docs/docs.module.css";

type ReleaseNavigationProps = {
  groups: readonly ReleaseSeries[];
  /** Highlight the release in view. Only the visible sidebar copy tracks. */
  track: boolean;
};

/** Every release, one row per minor series, linking to its heading. */
export function ReleaseNavigation({ groups, track }: ReleaseNavigationProps) {
  const ids = useMemo(
    () => groups.flatMap((group) => group.releases.map((release) => release.id)),
    [groups],
  );
  const activeId = useActiveSection(ids, track);

  return (
    <nav className={styles.releaseNav} aria-label="Releases">
      <ul className={styles.releaseGroups}>
        {groups.map((group) => (
          <li key={group.series} className={styles.releaseGroup}>
            <span className={styles.releaseSeries} aria-hidden="true">
              {group.series}
            </span>
            <ul className={styles.releaseChips}>
              {group.releases.map((release) => (
                <li key={release.id}>
                  <a
                    className={styles.releaseChip}
                    href={`#${release.id}`}
                    title={release.date ? `${release.version}, ${release.date}` : release.version}
                    aria-current={release.id === activeId ? "true" : undefined}
                  >
                    <span className="rm-visually-hidden">Version {release.version}</span>
                    <span aria-hidden="true">{release.short}</span>
                  </a>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </nav>
  );
}
