// The Mezonas icon set (packages/design-system/assets/Icons): the sprite is put in the page once
// (<IconSprite />, in App) and each <Icon> uses one of its symbols, so icons take the text colour
// (`currentColor`): ink-muted at rest, ink on hover, slate when active, on-slate on slate fills.
import sprite from "@countersign/design-system/assets/Icons/mezonas-icons-sprite.svg?raw";
import { cx } from "./cx";

export type IconName =
  | "table"
  | "desk"
  | "sign"
  | "worksheet"
  | "receipt"
  | "weekly-table"
  | "lead"
  | "team"
  | "invoice"
  | "payment"
  | "bank"
  | "price-change"
  | "vendor"
  | "customer"
  | "email"
  | "phone"
  | "message"
  | "calendar"
  | "report"
  | "document"
  | "search"
  | "filter"
  | "settings"
  | "notifications"
  | "check"
  | "alert"
  | "info"
  | "close"
  | "add"
  | "more"
  | "arrow"
  | "upload"
  | "chevron-down"
  | "chevron-right"
  | "copy"
  | "sidebar";

/** The sprite's symbols, once per page. */
export function IconSprite() {
  return (
    <div
      hidden
      aria-hidden
      // biome-ignore lint/security/noDangerouslySetInnerHtml: the design system's own static sprite.
      dangerouslySetInnerHTML={{ __html: sprite }}
    />
  );
}

/**
 * A 16, 20 or 24px icon (brand book). Decorative by default: an icon always sits beside a label or
 * inside a titled button; pass `label` only when it stands alone.
 */
export function Icon({
  name,
  size = 16,
  className,
  label,
}: {
  name: IconName;
  size?: 14 | 16 | 20 | 24;
  className?: string;
  label?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cx("shrink-0", className)}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-icon={name}
    >
      <use href={`#mz-${name}`} />
    </svg>
  );
}
