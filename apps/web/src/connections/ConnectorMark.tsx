// The connector's square mark wherever a connector is listed: the provider's logo or its colour
// (brands.ts), a Mezonas icon for our own connectors, else the name's initials ("PO") on the
// design's hairline tile.
import type { PlainKey } from "../i18n/catalog";
import { EN, type I18n } from "../i18n/i18n";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { agentInitials } from "../ui/primitives";
import { connectorBrand } from "./brands";

export function ConnectorMark({
  name,
  connector,
  size = "md",
}: {
  name: string;
  /** The connector's id (`qbo`, `gmail`); without one, or for an unknown id, the initials. */
  connector?: string | undefined;
  size?: "sm" | "md";
}) {
  const brand = connectorBrand(connector);
  const tile = cx(
    "inline-flex shrink-0 items-center justify-center rounded-sm",
    size === "sm" ? "size-9 text-xs" : "size-10 text-sm",
  );
  const neutral = "border border-line bg-surface-subtle text-ink";
  const glyph = size === "sm" ? 18 : 20;

  if (brand?.kind === "image") {
    return (
      <span
        aria-hidden
        data-mark="logo"
        className={cx(tile, "border border-line")}
        // The same white ground as the one-colour logos, in both themes.
        style={{ backgroundColor: "#fff" }}
      >
        <img src={brand.src} alt="" width={glyph} height={glyph} className="object-contain" />
      </span>
    );
  }
  if (brand?.kind === "logo") {
    return (
      <span
        aria-hidden
        data-mark="logo"
        className={cx(tile, "border border-line")}
        // A solid white ground in both themes, so the logo's cut-outs read as the provider draws them.
        style={{ backgroundColor: "#fff" }}
      >
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill={brand.fill} aria-hidden>
          <path d={brand.path} />
        </svg>
      </span>
    );
  }
  if (brand?.kind === "monogram") {
    return (
      <span
        aria-hidden
        data-mark="monogram"
        className={cx(tile, "font-semibold", !brand.fill && "border border-line bg-ink text-paper")}
        // White on the provider's colour, as the providers draw their own app tiles.
        style={brand.fill ? { backgroundColor: brand.fill, color: "#fff" } : undefined}
      >
        {brand.letters}
      </span>
    );
  }
  if (brand?.kind === "icon") {
    return (
      <span aria-hidden data-mark="icon" className={cx(tile, neutral, "text-ink-muted")}>
        <Icon name={brand.icon} size={20} />
      </span>
    );
  }
  return (
    <span aria-hidden data-mark="initials" className={cx(tile, neutral, "font-medium")}>
      {agentInitials(name)}
    </span>
  );
}

const ACCESS_WORDS: Record<string, PlainKey> = {
  runs: "access.runs",
  asks_first: "access.asks_first",
  steps_may_skip_approval: "access.steps_may_skip_approval",
  not_allowed: "access.not_allowed",
};

/** A tool's access on a connection, in plain words (from the API's `access`). */
export function accessLabel(access: string, { t }: Pick<I18n, "t"> = EN): string {
  const key = ACCESS_WORDS[access];
  return key ? t(key) : access;
}

const STATUS_WORDS: Record<string, PlainKey> = {
  connected: "connection.status.connected",
  pending: "connection.status.pending",
  disconnected: "connection.status.disconnected",
  error: "connection.status.error",
};

export function connectionStatusLabel(status: string, { t }: Pick<I18n, "t"> = EN): string {
  const key = STATUS_WORDS[status];
  return key ? t(key) : status;
}
