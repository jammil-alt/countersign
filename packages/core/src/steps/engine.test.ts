import { describe, expect, it } from "vitest";
import type { ActionKind } from "./catalog";
import { DoEngineError, doEngine } from "./engine";
import { DoStep } from "./schema";

const kinds: Record<string, ActionKind> = {
  "qbo.vendor.query": "get",
  "qbo.bill.create": "change",
  "materials.vendor_items.register": "save",
  "email.send": "send",
};
const kindOf = (a: string) => kinds[a];
const step = (over: Record<string, unknown>) =>
  DoStep.parse({ id: "s", kind: "do", name: "Do it", ...over });

describe("doEngine", () => {
  it("picks the engine from done by and uses, one for each of today's kinds of work", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ doneBy: "rules", uses: { type: "action", action: "qbo.vendor.query" } }, "read"],
      [{ doneBy: "rules", uses: { type: "action", action: "qbo.bill.create" } }, "write"],
      [{ doneBy: "rules", uses: { type: "action", action: "email.send" } }, "write"],
      [
        { doneBy: "rules", uses: { type: "action", action: "materials.vendor_items.register" } },
        "write",
      ],
      [{ doneBy: "rules" }, "rules"],
      [{ doneBy: "rules", uses: { type: "skill", skill: "data.group-list" } }, "rules"],
      [{ doneBy: "ai" }, "ai"],
      [{ doneBy: "ai", uses: { type: "skill", skill: "docs.read-document" } }, "ai"],
      [
        { doneBy: "rules", uses: { type: "match", match: { to: "vendors", type: "hybrid" } } },
        "match",
      ],
      [{ doneBy: "person" }, "person"],
      [{ doneBy: "person", uses: { type: "collect" } }, "collect"],
      [{ doneBy: "contact" }, "contact"],
      [{ uses: { type: "automation", automation: "follow-up@2" } }, "automation"],
      [{ uses: { type: "missing", need: "A tool" } }, "missing"],
    ];
    for (const [over, engine] of cases) {
      expect(doEngine(step(over), kindOf).engine, JSON.stringify(over)).toBe(engine);
    }
  });

  it("treats an action it doesn't know as a change, so approval stays on", () => {
    expect(
      doEngine(step({ doneBy: "rules", uses: { type: "action", action: "x.y.z" } }), kindOf),
    ).toEqual({ engine: "write", action: "x.y.z", kind: "change" });
  });

  it("refuses a combination the validator refuses", () => {
    expect(() =>
      doEngine(step({ doneBy: "ai", uses: { type: "action", action: "qbo.bill.create" } }), kindOf),
    ).toThrow(DoEngineError);
  });
});
