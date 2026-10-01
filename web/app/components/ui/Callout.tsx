import type { ReactNode } from "react";
import { classNames } from "./classNames";
import { Icon, type IconName } from "./Icon";

type Tone = "info" | "success" | "warning" | "danger" | "neutral";

const toneIcons: Record<Tone, IconName> = {
  info: "info",
  success: "check-circle",
  warning: "alert",
  danger: "alert",
  neutral: "info",
};

type CalloutProps = {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  role?: "alert" | "status";
  className?: string;
};

/** A short message inside a view. */
export function Callout({ tone = "info", title, children, role, className }: CalloutProps) {
  return (
    <div className={classNames("rm-callout", tone !== "info" && `rm-callout--${tone}`, className)} role={role}>
      <Icon name={toneIcons[tone]} className="rm-callout__icon" />
      <div className="rm-callout__content">
        {title ? <strong className="rm-callout__title">{title}</strong> : null}
        {children ? <div className="rm-callout__body">{children}</div> : null}
      </div>
    </div>
  );
}

