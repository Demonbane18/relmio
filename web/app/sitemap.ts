import type { MetadataRoute } from "next";
import { documentationPages } from "./docs/generated-content";
import { requestOrigin } from "./request-origin";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = await requestOrigin();
  return ["/", "/install", "/docs", "/changelog", ...documentationPages.map(({ slug }) => `/docs/${slug}`)]
    .map((path) => ({ url: new URL(path, origin).toString() }));
}
