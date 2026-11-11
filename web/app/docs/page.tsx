import { pageMetadata } from "../page-metadata";
import { DocumentationPage } from "./DocumentPage";

export const metadata = pageMetadata(
  "Relmio documentation",
  "Relmio setup guides for local endpoints, n8n on a VPS, SuperGrok, local models, the AI Assistant and the experimental Claude adapter, plus troubleshooting.",
  "/docs",
);

export default function DocsIndexPage() {
  return <DocumentationPage />;
}
