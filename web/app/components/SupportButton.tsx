import { Coffee } from "lucide-react";

export function SupportButton() {
  return (
    <a
      className="support-button"
      href="https://ko-fi.com/paldogies"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Support Relmio on Ko-fi (opens in a new tab)"
      title="Support Relmio on Ko-fi"
    >
      <Coffee size="1.1rem" strokeWidth={1.8} aria-hidden="true" />
    </a>
  );
}
