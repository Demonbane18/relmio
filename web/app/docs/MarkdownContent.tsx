import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { CopyableCodeBlock } from "./CopyableCodeBlock";
import { releaseId, slugify } from "./markdownText";
import { nodeText } from "./nodeText";

// Raw HTML inside the Markdown is not rendered. Do not add an HTML plugin.

function headingId(children: ReactNode) {
  return slugify(nodeText(children)) || undefined;
}

const sharedComponents: Components = {
  pre: ({ children }) => <CopyableCodeBlock>{children}</CopyableCodeBlock>,
  table: ({ children }) => (
    <div className="rm-table-wrap">
      <table className="rm-table">{children}</table>
    </div>
  ),
};

const guideComponents: Components = {
  ...sharedComponents,
  h1: ({ children }) => (
    <h1 className="rm-h1" id={headingId(children)}>
      {children}
    </h1>
  ),
  h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>,
  h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3>,
};

const changelogComponents: Components = {
  ...sharedComponents,
  // The page supplies its own title.
  h1: () => null,
  h2: ({ children }) => <h2 id={releaseId(nodeText(children))}>{children}</h2>,
};

/** A repository guide. Headings get the ids the outline links to. */
export function GuideMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={guideComponents}>
      {content}
    </ReactMarkdown>
  );
}

/** CHANGELOG.md. Release headings get the ids the release list links to. */
export function ChangelogMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={changelogComponents}>
      {content}
    </ReactMarkdown>
  );
}
