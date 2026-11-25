// The Close pack's configuration (docs/plan.md §1.230, §1.232): what the operator sets when switching
// it on for a client, kept in `tenant.settings.packs.close` and read with core's `packConfigOf`.

import type { PackConfigField } from "@countersign/core";

export const CLOSE_CONFIG_DEFAULTS = {
  accruals: true,
  accrualAccount: "Accrued Liabilities",
  accrualMonths: 3,
} as const;

export const CLOSE_CONFIG_FIELDS: PackConfigField[] = [
  {
    key: "accruals",
    label: "Propose accruals from billing patterns",
    help: "A vendor billed to the same expense account every month before, and not yet this month, gets an accrual to sign.",
    type: "boolean",
    default: CLOSE_CONFIG_DEFAULTS.accruals,
  },
  {
    key: "accrual_account",
    label: "Accrual account in the accounting system",
    help: "The liability account accruals are credited to, by its name or number.",
    type: "text",
    default: CLOSE_CONFIG_DEFAULTS.accrualAccount,
  },
  {
    key: "accrual_months",
    label: "Months of bills a pattern needs",
    type: "number",
    default: CLOSE_CONFIG_DEFAULTS.accrualMonths,
    min: 2,
    max: 12,
  },
];
