import { Children, isValidElement, type ReactNode } from "react";

/** Plain text of rendered React children, such as a Markdown heading or code block. */
export function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return Children.toArray(node).map(nodeText).join("");
}
