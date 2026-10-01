import { classNames } from "./classNames";
import { Icon } from "./Icon";

export function SupportLink({ className }: { className?: string }) {
  return (
    <a
      className={classNames("rm-icon-button", className)}
      href="https://ko-fi.com/paldogies"
      target="_blank"
      rel="noopener noreferrer"
      aria-label="Support Relmio on Ko-fi (opens in a new tab)"
      title="Support Relmio on Ko-fi"
    >
      <Icon name="coffee" />
    </a>
  );
}
