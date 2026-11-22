// Provisional icons for the agent's SOP (docs/sop-plan.md §3): an agent, AI and rules. The design
// system's set has none of them yet; these are drawn on its grid (24px, 1.5px stroke, square caps,
// miter joins, outline only, currentColor) until the designer delivers `mz-agent`, `mz-ai` and
// `mz-rules` (docs/open.md SOP-I), when they are replaced by the sprite's.

import { cx } from "../ui/cx";

const PATHS = {
  agent: (
    <>
      <rect x="4.5" y="8" width="15" height="11.5" />
      <path d="M12 4.5v3.5 M9 12.5v2 M15 12.5v2 M2 12v3 M22 12v3" />
    </>
  ),
  ai: (
    <path d="M11 3.5l1.9 5.6 5.6 1.9-5.6 1.9L11 18.5l-1.9-5.6L3.5 11l5.6-1.9z M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" />
  ),
  rules: <path d="M4 6h11 M4 11h11 M4 16h6 M14 17l2.5 2.5L21 15" />,
} as const;

export type SopIconName = keyof typeof PATHS;

export function SopIcon({
  name,
  size = 14,
  className,
}: {
  name: SopIconName;
  size?: 14 | 16;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
      className={cx("shrink-0", className)}
      data-icon={`sop-${name}`}
    >
      {PATHS[name]}
    </svg>
  );
}
