// v0.17 (ARCHITECTURE §10.15, docs/plan.md §1.96): the business areas an owner oversees, and the
// area a client agent's process belongs to. The database keeps the same list (`OWNER_AREAS` in
// packages/db's schema); a db test holds them equal.

import { z } from "zod";

export const OWNER_AREAS = [
  "purchasing",
  "sales",
  "receivables",
  "bookkeeping",
  "marketing",
  "general",
] as const;
export const OwnerArea = z.enum(OWNER_AREAS);
export type OwnerArea = z.infer<typeof OwnerArea>;

/** Where no area is set or found. */
export const DEFAULT_OWNER_AREA: OwnerArea = "general";

/**
 * The pack each area's data lives in, for reading a template's `requiresPacks`. Only packs that are
 * an area's are named; `general` has none.
 */
// DECISION (O2): materials is Purchasing's pack (ARCHITECTURE §12.0); bookkeeping and marketing are
// their own. Sales and Receivables have no pack yet, so a template reaches them only by `area`.
const AREA_OF_PACK: Readonly<Record<string, OwnerArea>> = {
  materials: "purchasing",
  bookkeeping: "bookkeeping",
  marketing: "marketing",
};

/**
 * The area a client agent's process belongs to: the operator's choice on the agent row, else the
 * template's declared area, else its one area pack, else `general` (docs/plan.md §1.96).
 */
export function processArea(input: {
  /** `agent.area`, set by the operator. */
  set?: string | null | undefined;
  /** The template's (or the agent's own) `definition.area`. */
  declared?: string | null | undefined;
  requiresPacks?: readonly string[] | undefined;
}): OwnerArea {
  const set = OwnerArea.safeParse(input.set);
  if (set.success) return set.data;
  const declared = OwnerArea.safeParse(input.declared);
  if (declared.success) return declared.data;
  const areas = [
    ...new Set((input.requiresPacks ?? []).map((p) => AREA_OF_PACK[p]).filter((a) => !!a)),
  ];
  return areas.length === 1 && areas[0] ? areas[0] : DEFAULT_OWNER_AREA;
}
