// Filter, group and total a list: the past-due reminders of the third QA run (2026-11-17), and the
// edges (decimals, dates, missing values, a minimum total).
import { describe, expect, it } from "vitest";
import { GROUP_LIST_SKILL_DEF, groupList, groupListTool } from "./group-list";

const invoices = [
  {
    id: "1001",
    customer: { id: "c1", email: "ap@harbor.example" },
    dueDate: "2026-10-20",
    balance: "120.10",
  },
  {
    id: "1002",
    customer: { id: "c1", email: "ap@harbor.example" },
    dueDate: "2026-10-01",
    balance: "0.20",
  },
  { id: "1003", customer: { id: "c2", email: "" }, dueDate: "2026-10-05", balance: "300.00" },
  {
    id: "1004",
    customer: { id: "c3", email: "pay@pine.example" },
    dueDate: "2026-11-10",
    balance: "999.00",
  },
  {
    id: "1005",
    customer: { id: "c4", email: "acct@oak.example" },
    dueDate: "2026-10-15",
    balance: "40.00",
  },
  {
    id: "1006",
    customer: { id: "c1", email: "ap@harbor.example" },
    dueDate: "2026-10-25",
    balance: "0.00",
  },
];

describe("groupList", () => {
  it("keeps invoices 15 or more days past due with a balance, by customer email, totaled, $50 and up", () => {
    const out = groupList({
      items: invoices,
      keep: [
        { field: "dueDate", op: "daysAgoAtLeast", value: 15 },
        { field: "balance", op: "moreThan", value: 0 },
      ],
      groupBy: "customer.email",
      totals: [{ field: "balance", as: "owed" }],
      minTotal: { total: "owed", atLeast: 50 },
      asOf: "2026-11-16",
    });
    // 1004 isn't 15 days past due; 1006 owes nothing.
    expect(out.keptCount).toBe(4);
    expect(out.droppedCount).toBe(2);
    // Decimals, not floats: 120.10 + 0.20 is 120.30 exactly.
    expect(out.groups).toEqual([
      {
        key: "ap@harbor.example",
        count: 2,
        totals: { owed: "120.3" },
        items: [invoices[0], invoices[1]],
      },
    ]);
    // c2 has no email: listed apart, not lost. c4 owes $40, under the minimum.
    expect(out.noKey.map((i) => i.id)).toEqual(["1003"]);
    expect(out.belowMinimum).toBe(1);
    expect(out.groupCount).toBe(1);
  });

  it("keeps everything in one group with no rules and no group field", () => {
    const out = groupList({ items: invoices, totals: [{ field: "balance", as: "total" }] });
    expect(out.groups).toHaveLength(1);
    expect(out.groups[0]?.totals.total).toBe("1459.3");
    expect(out.groups[0]?.count).toBe(6);
  });

  it("compares, sets and dates strictly: a value it can't read is not kept", () => {
    const items = [{ amount: "abc" }, { amount: 10 }, { amount: { amount: "12.5" } }, {}];
    expect(
      groupList({ items, keep: [{ field: "amount", op: "atLeast", value: "10" }] }).keptCount,
    ).toBe(2);
    expect(groupList({ items, keep: [{ field: "amount", op: "isNotSet" }] }).keptCount).toBe(1);
    expect(
      groupList({
        items: [{ due: "not a date" }, { due: "2026-01-01T09:00:00Z" }],
        keep: [{ field: "due", op: "daysAgoAtLeast", value: 30 }],
        asOf: "2026-02-01",
      }).keptCount,
    ).toBe(1);
  });

  it("refuses rules it doesn't know, and is a pure tool with the skill's schemas", async () => {
    expect(() =>
      groupList({ items: [], keep: [{ field: "x", op: "sortOf" as never, value: 1 } as never] }),
    ).toThrow();
    expect(groupListTool.pure).toBe(true);
    expect(groupListTool.spec.sideEffect).toBe("none");
    expect(GROUP_LIST_SKILL_DEF.handler).toBe(groupListTool.spec.id);
    const props = (GROUP_LIST_SKILL_DEF.input as { properties: Record<string, unknown> })
      .properties;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["items", "keep", "groupBy", "totals"]),
    );
  });
});
