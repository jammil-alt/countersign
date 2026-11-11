// A test run's payload (docs/plan.md §1.16; wave 3c): the sample and the recent events read the
// same trigger, the first event trigger, else the first trigger.
import type { Trigger } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { samplePayload, testTrigger, triggerEventType } from "./TestPayload";

const manual: Trigger = {
  id: "t0",
  on: { type: "manual", input: { type: "object", properties: { billId: { type: "string" } } } },
};
const event: Trigger = { id: "t1", on: { type: "event", event: "bill.created" } };
const events = [
  { type: "bill.created", sample: { billId: "B-1" } },
  { type: "document.received", sample: { documentId: "D-1" } },
];

describe("a test run's payload", () => {
  it("takes the sample from the event trigger whose recent events it offers", () => {
    // A process started by hand first and by an event second.
    const process = { triggers: [manual, event] };
    expect(triggerEventType(process)).toBe("bill.created");
    expect(samplePayload(process, events)).toEqual({ billId: "B-1" });
    expect(testTrigger(process)?.id).toBe("t1");
  });

  it("reads the first trigger when none is an event, and nothing with no trigger", () => {
    expect(triggerEventType({ triggers: [manual] })).toBeNull();
    expect(samplePayload({ triggers: [manual] }, events)).toEqual({ billId: "" });
    expect(testTrigger({ triggers: [] })).toBeUndefined();
    expect(samplePayload({ triggers: [] }, events)).toBeUndefined();
  });

  it("reads a v3 workflow's trigger and its more triggers alike", () => {
    const workflow = { trigger: manual, moreTriggers: [event] };
    expect(triggerEventType(workflow)).toBe("bill.created");
    expect(samplePayload(workflow, events)).toEqual({ billId: "B-1" });
  });
});
