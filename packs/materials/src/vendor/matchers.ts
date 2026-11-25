// The Purchasing area's match profiles, as the platform's Match engine runs them (step model §7),
// and the 13 matching and price actions they and Register lines replace (§10d, release R7).

import type { ProfileMatcher } from "@countersign/core";
import { MASTER_ITEMS_MATCHER } from "../catalog/profile";
import { type MatchContext, VENDOR_ITEMS_MATCHER, VENDORS_MATCHER } from "./profiles";

/** Vendors, Vendor items and Master items, for apps/api to hand the executor's Match port. */
export const MATERIALS_MATCHERS: readonly ProfileMatcher<MatchContext>[] = [
  VENDORS_MATCHER,
  VENDOR_ITEMS_MATCHER,
  MASTER_ITEMS_MATCHER,
];

/**
 * §10d: the actions a match profile or Register lines does for new steps (tool id → what does it
 * now). Their code stays for stored v4 steps until v4 is deleted (wave 4); the Uses picker leaves
 * them out (the manifest's `retiredTools`).
 */
// DECISION: kept registered, not deleted now: seeded v4 agents and templates still call them, and
// deleting v4 is wave 4's. "Becomes a profile" is true already: the profiles reuse their lookups.
export const MATERIALS_RETIRED_TOOLS: Readonly<Record<string, string>> = {
  "materials.vendor.match": "Match step, Vendors profile",
  "materials.vendor_items.lookup": "Match step, Vendor items profile (exact match on SKU)",
  "materials.master_items.candidates": "Match step, Master items profile",
  "materials.catalog.match-text": "Match step, Master items profile",
  "materials.request.match-lines": "Match step, Master items profile",
  "materials.matches.check": "The Match step's never-the-same rules",
  "materials.embeddings.write": "Register lines makes new master items searchable itself",
  "materials.prices.record": "Register lines records each line's price",
  "materials.vendor_items.similar": "Dropped: vendor items are a SKU match or nothing",
  "materials.lines.lookup": "Dropped",
  "materials.match_line": "Dropped",
  "materials.match_lines": "Dropped",
  "materials.matches.record": "Register lines",
};
