// The AP pack's configuration (Plan entry §1.233): what the operator sets when switching it on for
// a client, kept in `tenant.settings.packs.ap` and read with core's `packConfigOf`. Never a secret.

import { type PackConfigField, packConfigOf } from "@countersign/core";
import { AP_PACK_ID } from "./ids";

export const PAY_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday"] as const;
export type PayDay = (typeof PAY_DAYS)[number];

export interface ApConfig {
  /** The weekday the approve-to-pay list is for. */
  payDay: PayDay;
  /** Bills due within this many days after the pay day go on its list too. */
  dueWithinDays: number;
  /** How far a billed unit price may sit above the order's before it is flagged (percent). */
  priceTolerancePct: number;
  /** How many days apart two bills of one amount from one vendor may be and look duplicated. */
  duplicateWindowDays: number;
  /** A bill with no purchase order blocks its approval until a person says why. */
  requirePo: boolean;
  /** A bill against an order nobody has marked received blocks its approval the same way. */
  requireReceipt: boolean;
}

// DECISION: Friday payments, bills due within a week of it, 2% on price, 60 days for a duplicate,
// and neither an order nor a receipt required by default: many small clients buy without POs, so
// a missing one is a warning on the list, not a block, until the operator says otherwise.
export const AP_CONFIG_DEFAULTS: ApConfig = {
  payDay: "friday",
  dueWithinDays: 7,
  priceTolerancePct: 2,
  duplicateWindowDays: 60,
  requirePo: false,
  requireReceipt: false,
};

export const AP_CONFIG_FIELDS: PackConfigField[] = [
  {
    key: "pay_day",
    label: "Pay day",
    help: "The weekday each approve-to-pay list is for. We never pay: the list ends approved.",
    type: "choice",
    options: PAY_DAYS.map((d) => ({ value: d, label: d[0]?.toUpperCase() + d.slice(1) })),
    default: AP_CONFIG_DEFAULTS.payDay,
  },
  {
    key: "due_within_days",
    label: "Also list bills due within this many days after the pay day",
    type: "number",
    default: AP_CONFIG_DEFAULTS.dueWithinDays,
    min: 0,
    max: 60,
  },
  {
    key: "price_tolerance_pct",
    label: "Flag a price above its purchase order by more than (%)",
    type: "number",
    default: AP_CONFIG_DEFAULTS.priceTolerancePct,
    min: 0,
    max: 50,
  },
  {
    key: "duplicate_window_days",
    label: "Days apart two bills of the same amount look duplicated",
    type: "number",
    default: AP_CONFIG_DEFAULTS.duplicateWindowDays,
    min: 1,
    max: 366,
  },
  {
    key: "require_po",
    label: "Hold bills with no purchase order",
    type: "boolean",
    default: AP_CONFIG_DEFAULTS.requirePo,
  },
  {
    key: "require_receipt",
    label: "Hold bills whose goods nobody has marked received",
    type: "boolean",
    default: AP_CONFIG_DEFAULTS.requireReceipt,
  },
];

/** A client's AP configuration from its settings, each value checked, defaults for the rest. */
export function apConfigOf(
  settings: Readonly<Record<string, unknown>> | null | undefined,
): ApConfig {
  const v = packConfigOf(AP_CONFIG_FIELDS, settings, AP_PACK_ID);
  const payDay = PAY_DAYS.find((d) => d === v.pay_day) ?? AP_CONFIG_DEFAULTS.payDay;
  return {
    payDay,
    dueWithinDays: Number(v.due_within_days),
    priceTolerancePct: Number(v.price_tolerance_pct),
    duplicateWindowDays: Number(v.duplicate_window_days),
    requirePo: v.require_po === true,
    requireReceipt: v.require_receipt === true,
  };
}
