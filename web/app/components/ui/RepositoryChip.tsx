"use client";

import { useEffect, useState } from "react";
import { preparedReleaseVersion } from "../../project-version";
import { classNames } from "./classNames";
import { Icon } from "./Icon";

type ProjectMeta = {
  stars: number | null;
  version: string;
};

const fallbackMeta: ProjectMeta = { stars: null, version: preparedReleaseVersion };

function formatStars(stars: number) {
  return new Intl.NumberFormat("en", {
    notation: stars >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(stars);
}

/** GitHub link with live stars and the published version, as in the wizard. */
export function RepositoryChip({ className }: { className?: string }) {
  const [meta, setMeta] = useState(fallbackMeta);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/project-meta", { credentials: "same-origin", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const next = (await response.json()) as Partial<ProjectMeta>;
        setMeta({
          stars: typeof next.stars === "number" && next.stars >= 0 ? next.stars : null,
          version: typeof next.version === "string" ? next.version : fallbackMeta.version,
        });
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const starsLabel =
    meta.stars === null ? "GitHub star count is unavailable." : `${meta.stars} GitHub stars.`;

  return (
    <a
      className={classNames("rm-chip", className)}
      href="https://github.com/Demonbane18/relmio"
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`Open Relmio version ${meta.version} on GitHub. ${starsLabel} Opens in a new tab.`}
    >
      <Icon name="github" size="sm" />
      GitHub
      <span className="rm-chip__meta">
        <Icon name="star" size="xs" />
        {meta.stars === null ? "?" : formatStars(meta.stars)}
      </span>
      <span className="rm-chip__meta">v{meta.version}</span>
    </a>
  );
}
