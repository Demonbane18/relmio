import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DocumentationPage } from "../DocumentPage";
import { documentationBySlug, documentationPages } from "../generated-content";
import { guideSummary } from "../markdownText";
import { pageMetadata } from "../../page-metadata";

type Props = {
  params: Promise<{ slug: string }>;
};

export function generateStaticParams() {
  return documentationPages.map(({ slug }) => ({ slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = documentationBySlug.get(slug);
  return page
    ? pageMetadata(
        `${page.title} | Relmio documentation`,
        guideSummary(page.content),
        `/docs/${slug}`,
      )
    : {};
}

export default async function DocsPage({ params }: Props) {
  const { slug } = await params;
  const page = documentationBySlug.get(slug);
  if (!page) {
    notFound();
  }
  return <DocumentationPage page={page} />;
}
