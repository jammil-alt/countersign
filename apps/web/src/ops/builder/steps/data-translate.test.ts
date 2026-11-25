// Stream G (§5, §6): the Data tab's "Changed" says what the incoming side translated, and shows the
// input after the translation ran (the same code the run uses).

import { steps } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { afterTranslation, changed, incomingSources } from "./data";
import { NO_USES_CONTEXT } from "./options";
import type { DoStep, Workflow } from "./types";

const read = {
  kind: "do",
  id: "s_read",
  name: "Read the invoice",
  doneBy: "ai",
  input: {},
  output: [
    { name: "supplier", type: "text", required: true },
    { name: "total", type: "number", required: true },
  ],
} as DoStep;
const make = { kind: "do", id: "s_make", name: "Make", doneBy: "rules", input: {} } as DoStep;
const workflow = {
  schemaVersion: 5,
  triggers: [],
  outputs: [],
  steps: [read, make],
} as unknown as Workflow;

describe("the Data tab and translation", () => {
  const sources = incomingSources(workflow, "s_make", NO_USES_CONTEXT, [
    { name: "documentId", type: "record", record: "document", required: true },
  ]);
  const worked = steps.translateStep(
    make,
    [
      { name: "vendorName", type: "text", required: true },
      { name: "totalAmount", type: "money", required: true },
    ],
    sources,
  ).step;

  it("lists the trigger and the steps before as sources", () => {
    expect(sources.map((s) => s.ref)).toEqual(["trigger", "steps.s_read.output"]);
  });

  it("says each translated field and where it comes from", () => {
    expect(changed(worked, NO_USES_CONTEXT, sources).translated).toEqual([
      "vendorName ← Read the invoice › supplier",
      "totalAmount ← Read the invoice › total, as money",
    ]);
  });

  it("shows the input after the translation ran", () => {
    const incoming = { _s_read: { supplier: "Acme", total: 1250.5 } };
    expect(afterTranslation(worked, incoming, "2026-11-25")).toEqual({
      vendorName: "Acme",
      totalAmount: "1250.50",
    });
    expect(afterTranslation(read, incoming, "2026-11-25")).toBeUndefined();
  });
});
