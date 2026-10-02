import { classNames } from "./classNames";

/* Brand marks for the footer's social links, copied unchanged from
   simple-icons@13.21.0 (CC0-1.0; https://unpkg.com/simple-icons@13.21.0/icons/).
   Lucide has no brand icons, so these render as inline SVG in the current text color. */
const brandPaths = {
  "brand-x":
    "M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z",
  linkedin:
    "M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z",
  youtube:
    "M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z",
  facebook:
    "M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z",
} as const;

type BrandIconName = keyof typeof brandPaths;

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
  | "github"
  | BrandIconName;

type IconSize = "xs" | "sm" | "lg";

type IconProps = {
  name: IconName;
  size?: IconSize;
  className?: string;
};

// Same sizes as the kit's .rm-icon modifiers.
const brandSizes: Record<IconSize | "md", string> = {
  xs: "0.875rem",
  sm: "1rem",
  md: "1.125rem",
  lg: "1.375rem",
};

function isBrandIcon(name: IconName): name is BrandIconName {
  return Object.hasOwn(brandPaths, name);
}

/** A decorative kit icon. Give the surrounding control its accessible name. */
export function Icon({ name, size, className }: IconProps) {
  if (isBrandIcon(name)) {
    const dimension = brandSizes[size ?? "md"];
    return (
      <svg
        className={className}
        width={dimension}
        height={dimension}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
      >
        <path d={brandPaths[name]} />
      </svg>
    );
  }

  return (
    <span
      className={classNames("rm-icon", `rm-icon--${name}`, size && `rm-icon--${size}`, className)}
      aria-hidden="true"
    />
  );
}
