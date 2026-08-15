import type { Metadata } from "next";
import { DocumentationPage } from "./DocumentPage";

export const metadata: Metadata = {
  title: "Relmio documentation",
  description: "Canonical Relmio setup, security, and troubleshooting guides.",
};

export default function DocsIndexPage() {
  return <DocumentationPage />;
}
