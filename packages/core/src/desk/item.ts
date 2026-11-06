import { z } from "zod";

// What the Desk adds to an inbox item in both surfaces' lists (ARCHITECTURE §11.1, docs/plan.md
// §1.39), spread into PortalInboxItem and OpsInboxItem.
export const DESK_ITEM_FIELDS = {
  /** Approved and inside its undo window until then: the run is told after it. */
  deliverAfter: z.string().nullable().optional(),
  /** Out of "Waiting on you" until then. */
  snoozedUntil: z.string().nullable().optional(),
  /** `<run id>:<step id>`: the items one step proposed together, signed as a batch. */
  batchKey: z.string().nullable().optional(),
};
