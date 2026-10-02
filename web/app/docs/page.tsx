import { pageMetadata } from "../page-metadata";
import { DocumentationPage } from "./DocumentPage";

export const metadata = pageMetadata(
  "Relmio documentation",
  "Relmio guides for local endpoints, n8n on a VPS, SuperGrok, local models and AI Assistant tools, plus security, troubleshooting and a command reference.",
  "/docs",
);

export default function DocsIndexPage() {
  return <DocumentationPage />;
}
