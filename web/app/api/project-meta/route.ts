const fallbackVersion = "0.4.0";
const cacheHeader = "public, s-maxage=900, stale-while-revalidate=3600";

async function fetchMetadata(url: string, headers?: HeadersInit) {
  try {
    const response = await fetch(url, {
      headers,
      next: { revalidate: 900 },
    });
    return response.ok ? ((await response.json()) as unknown) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function GET() {
  const [repositoryMetadata, packageMetadata] = await Promise.all([
    fetchMetadata("https://api.github.com/repos/Demonbane18/relmio", {
      Accept: "application/vnd.github+json",
      "User-Agent": "relmio-web",
    }),
    fetchMetadata("https://registry.npmjs.org/relmio/latest"),
  ]);

  let stars: number | null = null;
  let version = fallbackVersion;

  if (isRecord(repositoryMetadata)) {
    const repositoryStars = repositoryMetadata.stargazers_count;
    if (
      typeof repositoryStars === "number" &&
      Number.isInteger(repositoryStars) &&
      repositoryStars >= 0
    ) {
      stars = repositoryStars;
    }
  }

  if (isRecord(packageMetadata)) {
    const packageVersion = packageMetadata.version;
    if (
      typeof packageVersion === "string" &&
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(packageVersion)
    ) {
      version = packageVersion;
    }
  }

  return Response.json(
    { stars, version },
    {
      headers: {
        "Cache-Control": cacheHeader,
      },
    },
  );
}
