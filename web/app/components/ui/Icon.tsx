import { classNames } from "./classNames";

export type IconName =
  | "monitor"
  | "sun"
  | "moon"
  | "menu"
  | "x"
  | "check"
  | "check-circle"
  | "alert"
  | "info"
  | "external"
  | "coffee"
  | "copy"
  | "chevron-down"
  | "chevron-right"
  | "arrow-right"
  | "arrow-left"
  | "arrow-up-right"
  | "terminal"
  | "server"
  | "laptop"
  | "shield"
  | "lock"
  | "book"
  | "home"
  | "plug"
  | "key"
  | "activity"
  | "refresh"
  | "network"
  | "cloud"
  | "bot"
  | "message"
  | "search"
  | "box"
  | "star"
  | "download"
  | "help"
  | "list-checks"
  | "log-out"
  | "settings"
  | "github";

type IconProps = {
  name: IconName;
  size?: "xs" | "sm" | "lg";
  className?: string;
};

/** A decorative kit icon. Give the surrounding control its accessible name. */
export function Icon({ name, size, className }: IconProps) {
  return (
    <span
      className={classNames("rm-icon", `rm-icon--${name}`, size && `rm-icon--${size}`, className)}
      aria-hidden="true"
    />
  );
}
