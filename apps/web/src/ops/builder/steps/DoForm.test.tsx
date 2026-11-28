import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { DoForm } from "./DoForm";
import type { StepFormEnv } from "./form-kit";
import { indexCatalog, NO_USES_CONTEXT } from "./options";
import type { DoStep, Workflow } from "./types";

const read = {
  kind: "do",
  id: "s_read",
  name: "Read the invoice",
  doneBy: "ai",
  input: {},
  output: [{ name: "vendorName", type: "text", required: true }],
} as DoStep;

const uses = {
  ...NO_USES_CONTEXT,
  actions: indexCatalog([
    {
      type: "connector",
      id: "qbo",
      name: "QuickBooks",
      actions: [
        {
          id: "qbo.bill.create",
          label: "Create bill",
          description: "",
          kind: "change",
          input: [{ name: "vendorName", type: "text", required: true }],
          output: [{ name: "billId", type: "text", required: true }],
        },
      ],
    },
  ]),
};

function setup(step: DoStep) {
  const later = { ...step, id: "s_do" } as DoStep;
  const workflow = {
    schemaVersion: 5,
    triggers: [],
    outputs: [],
    steps: [read, later],
  } as unknown as Workflow;
  const env: StepFormEnv = {
    workflow,
    uses,
    trigger: [],
    people: { members: [], people: [] },
    suggest: async () => ({ step: later, summary: "", applied: false }),
    models: [],
  };
  const seen: DoStep[] = [];
  function Host() {
    const [s, setS] = useState(later);
    return (
      <DoForm
        step={s}
        env={env}
        issues={[]}
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

describe("the Do form", () => {
  it("clears a Uses the new Done by doesn't allow", async () => {
    const user = userEvent.setup();
    const seen = setup({
      kind: "do",
      id: "s_do",
      name: "Bill it",
      doneBy: "rules",
      input: {},
      uses: { type: "action", action: "qbo.bill.create" },
    } as DoStep);
    await user.click(screen.getByLabelText("AI"));
    expect(seen.at(-1)?.doneBy).toBe("ai");
    expect(seen.at(-1)?.uses).toBeUndefined();
    expect(screen.queryByLabelText("What it uses")).toBeTruthy(); // AI still offers skills
  });

  it("puts the approver on when a Change is chosen, and says so", async () => {
    const user = userEvent.setup();
    const seen = setup({
      kind: "do",
      id: "s_do",
      name: "Bill it",
      doneBy: "rules",
      input: {},
    } as DoStep);
    await user.click(screen.getByLabelText("What it uses"));
    await user.click(screen.getByText("QuickBooks › Create bill"));
    expect(seen.at(-1)?.uses).toEqual({ type: "action", action: "qbo.bill.create" });
    expect(seen.at(-1)?.checks?.approval?.required).toBe("required");
    expect(screen.getByText(/approval is on/)).toBeTruthy();
  });

  it("fits an Input of the same name and type by itself, the id stored underneath", () => {
    // Stream G (§6): what fits is read directly, without anyone picking it.
    const seen = setup({
      kind: "do",
      id: "s_do",
      name: "Bill it",
      doneBy: "rules",
      input: {},
      uses: { type: "action", action: "qbo.bill.create" },
    } as DoStep);
    expect(seen.at(-1)?.input.vendorName).toBe("{{steps.s_read.output.vendorName}}");
    const select = screen.getByLabelText("Input vendorName") as HTMLSelectElement;
    expect(select.selectedOptions[0]?.textContent).toBe("Read the invoice › vendorName");
    expect(screen.queryByText(/Doesn't fit/)).toBeNull();
  });

  it("shows only the instructions its Done by carries, and keeps More folded", () => {
    setup({ kind: "do", id: "s_do", name: "Ask", doneBy: "person", input: {} } as DoStep);
    expect(screen.getByTestId("instructions-person")).toBeTruthy();
    expect(screen.queryByTestId("instructions-ai")).toBeNull();
    expect(screen.queryByTestId("instructions-rules")).toBeNull();
    const more = screen.getByTestId("do-more") as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(within(more).getByText("More")).toBeTruthy();
  });

  it("writes an AI step's instructions and its own output fields in the step", async () => {
    const user = userEvent.setup();
    const seen = setup({
      kind: "do",
      id: "s_do",
      name: "Classify",
      doneBy: "ai",
      input: {},
    } as DoStep);
    await user.type(screen.getByLabelText("What the AI does"), "x");
    expect(seen.at(-1)?.ai?.text).toBe("x");
    await user.click(screen.getByRole("button", { name: "Add a field" }));
    expect(seen.at(-1)?.output).toEqual([{ name: "", type: "text", required: false }]);
  });
});
