// Stream G (docs/step-model-plan.md §6): the Input box works out the incoming side by itself:
// Fits, Translated (saved with the step, no confirming), Doesn't fit (Suggest's Resolve asked once).

import { render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { StepFormEnv } from "./form-kit";
import { Input } from "./Input";
import { indexCatalog, NO_USES_CONTEXT } from "./options";
import type { SuggestFn } from "./suggest";
import type { DoStep, Field, Workflow } from "./types";

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

const takes: Field[] = [
  { name: "vendorName", type: "text", required: true },
  { name: "totalAmount", type: "money", required: true },
  { name: "taxId", type: "text", required: true },
];

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

function setup(suggest: SuggestFn) {
  const step = {
    kind: "do",
    id: "s_make",
    name: "Make the vendor",
    doneBy: "rules",
    input: {},
    uses: { type: "action", action: "qbo.vendor.create" },
  } as DoStep;
  const env: StepFormEnv = {
    workflow: {
      schemaVersion: 5,
      triggers: [],
      outputs: [],
      steps: [read, step],
    } as unknown as Workflow,
    uses,
    trigger: [],
    people: { members: [], people: [] },
    suggest,
    models: [],
  };
  const seen: DoStep[] = [];
  function Host() {
    const [s, setS] = useState(step);
    return (
      <Input
        step={s}
        env={env}
        issues={[]}
        takes={takes}
        free={false}
        onChange={(n) => {
          seen.push(n);
          setS(n);
        }}
      />
    );
  }
  render(<Host />);
  return seen;
}

describe("the Input box's translation", () => {
  it("translates what it can by itself, saved with the step, and says where each comes from", () => {
    const suggest = vi.fn<SuggestFn>(async (r) => ({ step: r.step, summary: "", applied: false }));
    const seen = setup(suggest);
    const saved = seen.at(-1);
    expect(saved?.input).toEqual({ _s_read: "{{steps.s_read.output}}" });
    expect(saved?.translation?.fields.map((f) => [f.name, f.from])).toEqual([
      ["vendorName", { input: "_s_read.supplier" }],
      ["totalAmount", { formatMoney: { value: { input: "_s_read.total" } } }],
    ]);
    expect(screen.getByTestId("input-vendorName-source").textContent).toBe(
      "Translated: from Read the invoice › supplier (renamed)",
    );
    expect(screen.getByTestId("input-totalAmount-source").textContent).toBe(
      "Translated: from Read the invoice › total, as money",
    );
    expect(screen.getByText(/Doesn't fit: nothing gives "taxId"/)).toBeTruthy();
  });

  it("asks Suggest's Resolve once for what doesn't fit, and applies its answer", async () => {
    const suggest = vi.fn<SuggestFn>(async (r) => ({
      step: { ...r.step, input: { ...(r.step as DoStep).input, taxId: "00-0000000" } } as DoStep,
      summary: "Filled taxId",
      applied: true,
    }));
    const seen = setup(suggest);
    await vi.waitFor(() => expect(seen.at(-1)?.input.taxId).toBe("00-0000000"));
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest.mock.calls[0]?.[0]).toMatchObject({ field: "input", how: "resolve" });
    expect(screen.queryByText(/Doesn't fit/)).toBeNull();
  });
});
