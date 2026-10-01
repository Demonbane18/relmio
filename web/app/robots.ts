import type { MetadataRoute } from "next";
import { requestOrigin } from "./request-origin";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const origin = await requestOrigin();
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: new URL("/sitemap.xml", origin).toString(),
  };
}
