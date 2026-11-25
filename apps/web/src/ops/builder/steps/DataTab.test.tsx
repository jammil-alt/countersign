import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataTab } from "./DataTab";
import type { StepFormEnv } from "./form-kit";
import { ensureEnd, insertStep, newStep, ROOT } from "./model";
import { indexCatalog, NO_USES_CONTEXT } from "./options";
import type { DoStep, Workflow } from "./types";

const uses = {
  ...NO_USES_CONTEXT,
  actions: indexCatalog([
    {
      type: "connector" as const,
      id: "qbo",
      name: "QuickBooks",
      actions: [
        {
          id: "qbo.bill.create",
          label: "Create bill",
          description: "",
          kind: "change" as const,
          input: [],
          output: [{ name: "billId", type: "text" as const, required: true }],
        },
      ],
    },
  ]),
};
const a = {
  ...(newStep("do", () => "a") as DoStep),
  name: "Make bill",
  doneBy: "rules" as const,
  uses: { type: "action" as const, action: "qbo.bill.create" },
};
const b = {
  ...(newStep("do", () => "b") as DoStep),
  name: "Tell",
  input: { id: "{{steps.a.output.billId}}" },
};
const wf = ensureEnd(
  insertStep(
    insertStep(
      { schemaVersion: 5, triggers: [], outputs: [], steps: [] } as unknown as Workflow,
      { container: ROOT, index: 0 },
      a,
    ),
    { container: ROOT, index: 1 },
    b,
  ),
);
const env: StepFormEnv = {
  workflow: wf,
  uses,
  trigger: [],
  people: { members: [], people: [] },
  suggest: vi.fn(),
  models: [],
};

describe("the Data tab", () => {
  it("shows sample data in three parts, and says it checks nothing", () => {
    render(<DataTab step={b} env={env} />);
    expect(screen.getByText("For understanding only: nothing here is checked.")).toBeTruthy();
    expect(within(screen.getByTestId("data-in")).getByText(/"id": "Sample text"/)).toBeTruthy();
    expect(
      within(screen.getByTestId("data-in")).getByText("Sample data from the fields' types"),
    ).toBeTruthy();
    expect(screen.getByText("Nothing changed on the way in.")).toBeTruthy();
  });

  it("prefers the last test run", () => {
    render(<DataTab step={a} env={env} lastRun={{ output: { billId: "B-9" } }} />);
    const out = screen.getByTestId("data-out");
    expect(within(out).getByText(/B-9/)).toBeTruthy();
    expect(within(out).getByText("From the last test run")).toBeTruthy();
    expect(screen.getByText("Changes the client's tool: QuickBooks › Create bill.")).toBeTruthy();
  });
});
