// P-7: the latest translation beside each original (docs/plan.md §1.69), as the back office
// (with its model and cost) or the portal (never either, invariant 11) shows it. Kept apart from
// the service so the message views can import it without its dependencies.

import { latestTranslations, opsTranslationView, translationView } from "@countersign/agents";
import type { OpsTranslationView, TranslationView } from "@countersign/core";
import type { Tx } from "@countersign/db";

export function translationsFor(
  tx: Tx,
  tenantId: string,
  ids: {
    rawRecordIds?: readonly string[];
    messageIds?: readonly string[];
    reachOutIds?: readonly string[];
  },
  surface: "ops",
): Promise<Map<string, OpsTranslationView>>;
export function translationsFor(
  tx: Tx,
  tenantId: string,
  ids: {
    rawRecordIds?: readonly string[];
    messageIds?: readonly string[];
    reachOutIds?: readonly string[];
  },
  surface: "ops" | "portal",
): Promise<Map<string, TranslationView | OpsTranslationView>>;
export async function translationsFor(
  tx: Tx,
  tenantId: string,
  ids: {
    rawRecordIds?: readonly string[];
    messageIds?: readonly string[];
    reachOutIds?: readonly string[];
  },
  surface: "ops" | "portal",
): Promise<Map<string, TranslationView | OpsTranslationView>> {
  const rows = await latestTranslations(tx, tenantId, ids);
  return new Map(
    [...rows].map(([k, row]) => [
      k,
      surface === "ops" ? opsTranslationView(row) : translationView(row),
    ]),
  );
}
