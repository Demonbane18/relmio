import type { SVGProps } from "react";

const iconProps = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  strokeWidth: 1.75,
} as const;

export function WorkstationIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...iconProps} viewBox="0 0 24 24">
      <rect x="4" y="4.5" width="16" height="11" rx="1.5" />
      <path d="M8.5 19.5h7M10 15.5l-.75 4M14 15.5l.75 4" />
    </svg>
  );
}

export function HostIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...iconProps} viewBox="0 0 24 24">
      <rect x="4" y="3.5" width="16" height="7" rx="1.5" />
      <rect x="4" y="13.5" width="16" height="7" rx="1.5" />
      <path d="M7.5 7h.01M7.5 17h.01M11 7h6M11 17h6" />
    </svg>
  );
}

export function NetworkIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...iconProps} viewBox="0 0 24 24">
      <circle cx="12" cy="5" r="2.5" />
      <circle cx="5.5" cy="18.5" r="2.5" />
      <circle cx="18.5" cy="18.5" r="2.5" />
      <path d="m10.8 7.2-4.1 9M13.2 7.2l4.1 9M8 18.5h8" />
    </svg>
  );
}

export function SidecarIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...iconProps} viewBox="0 0 24 24">
      <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z" />
      <path d="m4.4 7.7 7.6 4.2 7.6-4.2M12 12v9" />
    </svg>
  );
}

export function RequestIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...iconProps} viewBox="0 0 24 24">
      <path d="M4 8h12M13 5l3 3-3 3M20 16H8M11 13l-3 3 3 3" />
    </svg>
  );
}

export function ResponseIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} {...iconProps} viewBox="0 0 24 24">
      <path d="M5 4.5h14v11H9l-4 4v-15Z" />
      <path d="M8.5 8.5h7M8.5 11.5h4.5" />
    </svg>
  );
}
