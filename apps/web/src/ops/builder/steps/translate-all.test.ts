// Stream G's follow-up: the builder works out every Do step's incoming side when it loads a
// workflow, so a step never opened in the panel is translated too.

import { describe, expect, it } from "vitest";
import { translateAll } from "./data";
import { indexCatalog, NO_USES_CONTEXT } from "./options";
import type { DoStep, Field, Workflow } from "./types";

const read = {
  kind: "do",
  id: "s_read",
  name: "Read the invoice",
  doneBy: "ai",
  input: {},
  output: [{ name: "supplier", type: "text", required: true }],
} as DoStep;

const takes: Field[] = [{ name: "vendorName", type: "text", required: true }];
const uses = {
  ...NO_USES_CONTEXT,
  actions: indexCatalog([
    {
      type: "connector",
      id: "qbo",
      name: "QuickBooks",
      actions: [
        {
          id: "qbo.vendor.create",
          label: "Create vendor",
          description: "",
          kind: "change",
          input: takes,
          output: [],
        },
      ],
    },
  ]),
};
const make = {
  kind: "do",
  id: "s_make",
  name: "Make the vendor",
  doneBy: "rules",
  input: {},
  uses: { type: "action", action: "qbo.vendor.create" },
} as DoStep;
const wf = (list: DoStep[]) =>
  ({ schemaVersion: 5, triggers: [], outputs: [], steps: list }) as unknown as Workflow;

describe("translateAll", () => {
  it("works out the incoming side of a step never opened", () => {
    const next = translateAll(wf([read, make]), uses);
    const step = next.steps[1] as DoStep;
    expect(step.translation?.fields.map((f) => f.name)).toEqual(["vendorName"]);
    expect(Object.keys(step.input)).toContain("_s_read");
  });

  it("gives the same workflow back when nothing needed working out", () => {
    const once = translateAll(wf([read, make]), uses);
    expect(translateAll(once, uses)).toBe(once);
    const plain = wf([read]);
    expect(translateAll(plain, uses)).toBe(plain);
  });
});
