// Each way a workflow starts with its own first steps (docs/plan.md §1.184): a decision first,
// a path per start, each taken by what only that start's run carries.
import type { TypingContext } from "@countersign/core";
import { describe, expect, it } from "vitest";
import type { Process } from "./model";
import { hasStartsDecision, otherwiseStart, STARTS_DECISION, splitStarts } from "./starts";

const ctx = {
  events: {
    "document.extracted": {
      payload: {
        type: "object",
        properties: { documentId: { type: "string" }, docType: { type: "string" } },
        required: ["documentId"],
      },
    },
  },
} as unknown as TypingContext;

const schedule = { id: "t-sched", on: { type: "schedule", cron: "0 6 * * *" } };
const receipt = { id: "t-doc", on: { type: "event", event: "document.extracted" } };
const byHand = { id: "t-hand", on: { type: "manual", input: { type: "object", properties: {} } } };
const step = { id: "pull", name: "Pull transactions", kind: "wait", for: "1 minute" };
const flow = (...triggers: unknown[]) =>
  ({ schemaVersion: 4, triggers, steps: [step] }) as unknown as Process;
const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe("a path for each way it starts", () => {
  it("adds a decision first, each path taken by what only its start carries", () => {
    const r = splitStarts(flow(schedule, receipt), ctx, ids());
    if (!r.ok) throw new Error(r.why);
    expect(r.stepId).toBe("id-1");
    expect(r.process.steps.map((s) => s.id)).toEqual(["id-1", "pull"]);
    const first = r.process.steps[0];
    if (first?.kind !== "if") throw new Error("not a decision");
    expect(first.name).toBe(STARTS_DECISION);
    expect(first.paths.map((p) => [p.name, p.when.rules, p.steps])).toEqual([
      ["On a schedule", [{ field: "{{trigger.scheduledAt}}", op: "exists" }], []],
      // A field the event always has, not one it may lack.
      [expect.any(String), [{ field: "{{trigger.documentId}}", op: "exists" }], []],
    ]);
    expect(first.otherwise?.steps).toEqual([]);
    // Once it is there, it isn't added again.
    expect(hasStartsDecision(r.process)).toBe(true);
    expect(splitStarts(r.process, ctx)).toMatchObject({ ok: false });
  });

  it("gives a start with no data of its own the Otherwise path", () => {
    const p = flow(schedule, byHand);
    const r = splitStarts(p, ctx, ids());
    if (!r.ok) throw new Error(r.why);
    const first = r.process.steps[0];
    if (first?.kind !== "if") throw new Error("not a decision");
    expect(first.paths.map((x) => x.name)).toEqual(["On a schedule"]);
    expect(otherwiseStart(p, ctx)).toBe("Started by hand");
  });

  it("says why when it can't: one start, or two no rule can tell apart", () => {
    expect(splitStarts(flow(schedule), ctx)).toEqual({
      ok: false,
      why: "It has one way to start. Add another first.",
    });
    const twin = splitStarts(flow(byHand, { ...byHand, id: "t-hand-2" }), ctx);
    expect(twin.ok).toBe(false);
    if (!twin.ok) expect(twin.why).toContain("2 of these starts carry the same data");
    expect(hasStartsDecision(flow(schedule, receipt))).toBe(false);
  });
});
