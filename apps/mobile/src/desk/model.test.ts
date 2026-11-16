import { describe, expect, it } from "vitest";
import { pathForNotification } from "../notifications/links";
import { changeModel, formatMoney } from "./change";
import {
  ago,
  clock,
  isChange,
  needOf,
  quickAnswers,
  signedInput,
  snoozeTimes,
  undoLeft,
  whyLines,
} from "./model";

describe("the Desk on the phone", () => {
  it("knows what an item asks", () => {
    expect(needOf({ kind: "external_action", payload: {} })).toBe("sign");
    expect(needOf({ kind: "request", payload: {} })).toBe("answer");
    expect(needOf({ kind: "approval", payload: { accessRelease: { id: "r" } } })).toBe("code");
    expect(needOf({ kind: "change_request", payload: {} })).toBe("request");
    expect(isChange({ kind: "external_action" })).toBe(true);
    expect(isChange({ kind: "request" })).toBe(false);
  });

  it("reads quick answers in the person's language", () => {
    const payload = {
      choices: [
        { value: "coastal", label: { en: "Coastal Lumber", es: "Coastal Lumber (es)" } },
        { value: "hardwood" },
      ],
    };
    expect(quickAnswers(payload, "es")).toEqual([
      { value: "coastal", label: "Coastal Lumber (es)" },
      { value: "hardwood", label: "hardwood" },
    ]);
    expect(quickAnswers({ choices: [{ label: "no value" }] }, "en")).toBeNull();
    expect(quickAnswers({}, "en")).toBeNull();
  });

  it("says why a change needs the person, in core's words", () => {
    const lines = whyLines(
      { payload: { whyApproval: { reasons: ["step", "stage"], stage: "trial" } } },
      "en",
    );
    expect(lines[0]).toBe("This step needs your approval.");
    expect(lines[1]).toMatch(/trial/);
    expect(whyLines({ payload: {} }, "en")).toEqual([]);
  });

  it("offers later today, tomorrow at 8 and Monday at 8", () => {
    const now = new Date(2026, 10, 13, 15, 30); // a Friday
    const t = snoozeTimes(now);
    expect(t.later.getHours()).toBe(18);
    expect([t.tomorrow.getDate(), t.tomorrow.getHours()]).toEqual([14, 8]);
    expect([t.monday.getDay(), t.monday.getDate(), t.monday.getHours()]).toEqual([1, 16, 8]);
  });

  it("counts down the undo window", () => {
    const now = Date.parse("2026-11-13T15:00:00Z");
    expect(undoLeft({ deliverAfter: "2026-11-13T15:00:52Z" }, now)).toBe(52);
    expect(undoLeft({ deliverAfter: "2026-11-13T14:59:00Z" }, now)).toBe(0);
    expect(undoLeft({ deliverAfter: null }, now)).toBe(0);
    expect(clock(52)).toBe("0:52");
    expect(clock(125)).toBe("2:05");
    expect(ago(new Date(now - 12 * 60_000).toISOString(), now)).toBe("12 min ago");
  });

  it("signs the person's edit when there is one", () => {
    expect(signedInput({ input: { a: 1 }, edited: { input: { a: 2 } } })).toEqual({ a: 2 });
    expect(signedInput({ input: { a: 1 } })).toEqual({ a: 1 });
  });

  it("shows a purchase order's lines and total from its display", () => {
    const model = changeModel(
      {
        name: "QuickBooks purchase order",
        fields: [
          {
            label: "Lines",
            kind: "lines",
            after: "input.lines",
            columns: {
              description: "description",
              qty: "qty",
              unitPrice: "unitPrice",
              amount: "amount",
            },
          },
          { label: "Total", kind: "money", after: "input.total", currency: "USD" },
        ],
      },
      null,
      {
        lines: [
          { description: "Baltic birch", qty: "40", unitPrice: "78.50", amount: "3140.00" },
          { description: "Plywood", qty: "12", unitPrice: "92.00", amount: "1104.00" },
          { description: "Edge banding", qty: "6", unitPrice: "96.00", amount: "576.00" },
        ],
        total: "4820.00",
      },
    );
    expect(model.create).toBe(true);
    const lines = model.fields.find((f) => f.key === "lines");
    expect(lines?.after.type === "lines" && lines.after.total).toBe("4820");
    expect(formatMoney("4820.00", "USD")).toBe("$4,820.00");
  });

  it("opens the Desk from a notification unless it names somewhere else", () => {
    expect(pathForNotification({ kind: "items_waiting", path: "/inbox" })).toBe("/");
    expect(pathForNotification({ kind: "lead_message", path: "/" })).toBe("/messages");
    expect(pathForNotification({ kind: "credits", path: "/settings" })).toBe("/settings");
    expect(pathForNotification(null)).toBe("/");
  });
});
