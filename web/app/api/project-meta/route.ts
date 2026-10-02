import { preparedReleaseVersion } from "../../project-version";

const fallbackVersion = preparedReleaseVersion;
// The version must follow a new stable release within minutes, so the response
// and the npm read are short-lived. Stars keep a longer cache: unauthenticated
// GitHub API calls are rate-limited per server address.
const cacheHeader = "public, s-maxage=60, stale-while-revalidate=60";

async function fetchMetadata(url: string, revalidate: number, headers?: HeadersInit) {
  try {
    const response = await fetch(url, {
      headers,
      next: { revalidate },
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
    fetchMetadata("https://api.github.com/repos/Demonbane18/relmio", 900, {
      Accept: "application/vnd.github+json",
      "User-Agent": "relmio-web",
    }),
    fetchMetadata("https://registry.npmjs.org/relmio/latest", 60),
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
    // npm `latest` is the stable channel; ignore anything that is not a plain release.
    if (typeof packageVersion === "string" && /^\d+\.\d+\.\d+$/u.test(packageVersion)) {
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
