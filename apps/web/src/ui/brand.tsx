// The Mezonas name and logo files (packages/design-system/assets/Logos). The product is Mezonas;
// `countersign` stays the code name of the repo and packages.

import logo from "@countersign/design-system/assets/Logos/mezonas-logo.svg";
import logoPaper from "@countersign/design-system/assets/Logos/mezonas-logo-paper.svg";
import { cx } from "./cx";

export const PRODUCT_NAME = "Mezonas";

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
