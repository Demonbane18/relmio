import { pageMetadata } from "../page-metadata";
import { DocumentationPage } from "./DocumentPage";

export const metadata = pageMetadata(
  "Relmio documentation",
  "Canonical Relmio setup, security, and troubleshooting guides.",
  "/docs",
);

export default function DocsIndexPage() {
  return <DocumentationPage />;
}
