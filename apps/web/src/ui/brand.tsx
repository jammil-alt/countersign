// The Mezonas name and logo files (packages/design-system/assets/Logos). The product is Mezonas;
// `countersign` stays the code name of the repo and packages.

import logo from "@countersign/design-system/assets/Logos/mezonas-logo.svg";
import logoPaper from "@countersign/design-system/assets/Logos/mezonas-logo-paper.svg";
import mark from "@countersign/design-system/assets/Logos/mezonas-mark.svg";
import markPaper from "@countersign/design-system/assets/Logos/mezonas-mark-paper.svg";
import { cx } from "./cx";

export const PRODUCT_NAME = "Mezonas";

/**
 * The mark alone (square), for tight places: the top bar at phone width. Hidden from screen
 * readers: it stands in for the lockup, and what it sits in names Mezonas.
 */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span aria-hidden className={cx("inline-flex", className)}>
      <img src={mark} alt="" width={size} height={size} className="theme-light-only" />
      <img src={markPaper} alt="" width={size} height={size} className="theme-dark-only" />
    </span>
  );
}

/**
 * The horizontal lockup at `height` px (the brand's minimum is 96px wide, about 13px tall): the slate
 * file on light grounds, the paper file on dark ones, switched with the theme.
 */
export function Logo({ height = 22, className }: { height?: number; className?: string }) {
  // The files are 872 × 121.
  const width = Math.round((height * 872) / 121);
  return (
    <span
      role="img"
      aria-label={PRODUCT_NAME}
      className={cx("inline-flex", className)}
      data-testid="brand-logo"
    >
      <img src={logo} alt="" width={width} height={height} className="theme-light-only" />
      <img src={logoPaper} alt="" width={width} height={height} className="theme-dark-only" />
    </span>
  );
}
