"use client";

import { useEffect, useState } from "react";

type ProjectMeta = {
  stars: number | null;
  version: string;
};

const fallbackMeta: ProjectMeta = {
  stars: null,
  version: "0.6.0",
};

function formatStars(stars: number) {
  return new Intl.NumberFormat("en", {
    notation: stars >= 1_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(stars);
}

export function RepositoryButton() {
  const [meta, setMeta] = useState(fallbackMeta);

  useEffect(() => {
    const controller = new AbortController();

    void fetch("/api/project-meta", {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return;
        const nextMeta = (await response.json()) as Partial<ProjectMeta>;
        setMeta({
          stars:
            typeof nextMeta.stars === "number" && nextMeta.stars >= 0
              ? nextMeta.stars
              : null,
          version:
            typeof nextMeta.version === "string"
              ? nextMeta.version
              : fallbackMeta.version,
        });
      })
      .catch(() => {});

    return () => controller.abort();
  }, []);

  const stars = meta.stars === null ? "?" : formatStars(meta.stars);

  return (
    <a
      className="repository-button"
      href="https://github.com/Demonbane18/relmio"
      target="_blank"
      rel="noreferrer"
      aria-label={`Open Relmio version ${meta.version} on GitHub. ${
        meta.stars === null
          ? "GitHub star count is currently unavailable."
          : `${meta.stars} GitHub stars.`
      }`}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 .7a11.5 11.5 0 0 0-3.64 22.41c.58.11.79-.25.79-.56v-2.23c-3.22.7-3.9-1.37-3.9-1.37-.53-1.34-1.29-1.7-1.29-1.7-1.05-.72.08-.71.08-.71 1.16.08 1.77 1.19 1.77 1.19 1.04 1.77 2.72 1.26 3.38.96.1-.75.4-1.26.73-1.55-2.57-.29-5.28-1.29-5.28-5.69 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.16 1.18a10.9 10.9 0 0 1 5.76 0c2.19-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.42-2.71 5.4-5.29 5.69.42.36.79 1.06.79 2.14v3.17c0 .31.21.68.8.56A11.5 11.5 0 0 0 12 .7Z"
        />
      </svg>
      <strong>GitHub</strong>
      <span className="repository-stat">
        <span aria-hidden="true">★</span>
        {stars}
      </span>
      <span className="repository-version">v{meta.version}</span>
    </a>
  );
}
