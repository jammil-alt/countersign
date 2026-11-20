// INPUT lens: the built-in `data.list.group` tool (packages/agents/src/tools/group-list.ts), the
// deterministic skill a finance agent uses to total a list before acting on it ("customers owing
// at least $500"). Driven through the registered tool's `run`, as the runtime calls it.

import { GROUP_LIST_TOOL, groupListTool } from "@countersign/agents";
import { describe, expect, it } from "vitest";

const run = (input: unknown) =>
  // The tool's run parses its own input (`GroupListInput`) and works on it.
  groupListTool.run(input as never, {} as never) as Promise<{
    groups: { key: string; count: number; totals: Record<string, string> }[];
    keptCount: number;
  }>;

describe(`${GROUP_LIST_TOOL}: money in a list`, () => {
  it("INPUT-7: never totals two currencies into one figure", async () => {
    // Open invoices as QuickBooks' tools give them: money as { amount, currency }.
    const items = [
      { customer: "Lakeside", balance: { amount: "400.00", currency: "USD" } },
      { customer: "Lakeside", balance: { amount: "400.00", currency: "CAD" } },
    ];
    const out = await run({
      items,
      groupBy: "customer",
      totals: [{ field: "balance", as: "owed" }],
      minTotal: { total: "owed", atLeast: "500" },
    }).catch((e: unknown) => ({ refused: String(e) }));
    // Expected: refused, or kept apart per currency (neither 400 reaches 500). Today one group of
    // "800" passes the 500 minimum, and the agent chases US$400 + C$400 as 800.
    const owed = "groups" in out ? out.groups.map((g) => g.totals.owed) : out;
    expect(owed).not.toEqual(["800"]);
  });

  it("INPUT-8: an amount written with a thousands separator is not totalled as zero", async () => {
    // A sheet's or a CSV's amounts as text, as people write them.
    const items = [
      { vendor: "Rockler", amount: "1,250.00" },
      { vendor: "Rockler", amount: "75.00" },
    ];
    const out = await run({
      items,
      groupBy: "vendor",
      totals: [{ field: "amount", as: "spent" }],
    }).catch((e: unknown) => ({ refused: String(e) }));
    // Expected: 1325.00 (or a refusal naming the value it can't read). Today "1,250.00" counts as
    // 0 with no sign of it, and the total is 75.
    const spent = "groups" in out ? out.groups.map((g) => g.totals.spent) : out;
    expect(spent).toEqual(["1325"]);
  });
});
