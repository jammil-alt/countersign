// The leftovers Loop's test set (docs/step-model-plan.md §8): hand-written replays, so CI runs them
// with no model. Each says what the reconciliation holds (the fixture the read answers), the turns
// the model takes, and what it should hand back. A Loop from a pack ships with these beside it.

import { LoopTests } from "@countersign/core";

const RECON = "33333333-3333-4333-8333-333333333333";
const A1 = "11111111-1111-4111-8111-111111111111";
const B1 = "22222222-2222-4222-8222-222222222222";
const B2 = "22222222-2222-4222-8222-222222222223";
const A2 = "11111111-1111-4111-8111-111111111112";

const open = (unmatched: object[]) => ({
  tool: "bookkeeping.reconcile.open",
  input: { reconciliationId: RECON },
  output: {
    reconciliationId: RECON,
    summary: "Checking, October",
    aLabel: "Bank",
    bLabel: "Books",
    difference: "0.00",
    residual: "0.00",
    outcome: "open",
    status: "open",
    unmatched,
  },
});

export const LEFTOVERS_LOOP_TESTS: LoopTests = LoopTests.parse({
  "bookkeeping.investigate-leftovers": [
    {
      name: "One deposit is two on the other side",
      input: { reconciliationId: RECON },
      fixtures: [
        open([
          { id: A1, side: "a", date: "2026-10-30", effect: "300.00", description: "DEPOSIT" },
          { id: B1, side: "b", date: "2026-10-30", effect: "180.00", description: "Check 1041" },
          { id: B2, side: "b", date: "2026-11-01", effect: "120.00", description: "Check 1042" },
        ]),
      ],
      replay: [
        {
          said: "Read the reconciliation first.",
          call: {
            tool: "bookkeeping.reconcile.open",
            input: { reconciliationId: RECON },
          },
        },
        {
          said: "180.00 and 120.00 add up to the 300.00 deposit.",
          call: {
            tool: "finish",
            input: {
              proposals: [
                {
                  aItemIds: [A1],
                  bItemIds: [B1, B2],
                  reason: "One deposit of 300.00 is two checks, 180.00 and 120.00, on the books.",
                  confidence: 0.9,
                },
              ],
              unexplained: "Nothing else is left.",
              sources: [RECON, A1, B1, B2],
            },
          },
        },
      ],
      expected: {
        proposals: [{ aItemIds: [A1], bItemIds: [B1, B2], confidence: 0.9 }],
        unexplained: "Nothing else is left.",
      },
    },
    {
      name: "Items that are only similar are left for a person",
      input: { reconciliationId: RECON },
      fixtures: [
        open([
          { id: A2, side: "a", date: "2026-10-12", effect: "75.00", description: "FUEL" },
          { id: B1, side: "b", date: "2026-10-12", effect: "74.00", description: "Fuel" },
        ]),
      ],
      replay: [
        {
          call: { tool: "bookkeeping.reconcile.open", input: { reconciliationId: RECON } },
        },
        {
          said: "75.00 and 74.00 are close but not the same money.",
          call: {
            tool: "finish",
            input: {
              proposals: [],
              unexplained: "Two items, 75.00 and 74.00, are close but don't add up to the same.",
              sources: [RECON, A2, B1],
            },
          },
        },
      ],
      expected: { proposals: [] },
    },
  ],
});
