import { describe, expect, it } from "vitest";
import { boxWords, displayProcess } from "./display";
import { ensureEnd, insertStep, newOutput, newStep, ROOT } from "./model";
import {
  chooseDoneBy,
  chooseUses,
  indexCatalog,
  NO_USES_CONTEXT,
  type UsesContext,
} from "./options";
import type { DoStep, Workflow } from "./types";

let n = 0;
const id = () => `d${++n}`;
const ctx: UsesContext = {
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
          input: [],
          output: [],
        },
      ],
    },
  ]),
};

describe("how the chart draws a step-model workflow", () => {
  it("draws a fork as a decision and an End as a stop, ids and nesting as they are", () => {
    const fork = newStep("fork", id);
    if (fork.kind !== "fork") throw new Error("fork");
    const inner = newStep("do", id);
    fork.paths[0]?.steps.push(inner);
    let w: Workflow = {
      schemaVersion: 5,
      triggers: [{ id: "t", on: { type: "manual" } } as never],
      outputs: [newOutput("Report", id)],
      steps: [],
    };
    w = ensureEnd(insertStep(w, { container: ROOT, index: 0 }, fork), id);
    const p = displayProcess(w, ctx);
    expect(p.steps.map((s) => s.kind)).toEqual(["if", "stop"]);
    const drawn = p.steps[0];
    expect(drawn?.kind === "if" && drawn.paths[0]?.steps[0]?.id).toBe(inner.id);
  });

  it("draws a Do as the work it does, and says what it uses in the box", () => {
    const a = chooseUses(
      chooseDoneBy(newStep("do", id) as DoStep, "rules"),
      { type: "action", action: "qbo.bill.create" },
      ctx,
    );
    const named = { ...a, name: "Enter the bill" };
    expect(displayProcess({ steps: [named] } as unknown as Workflow, ctx).steps[0]?.kind).toBe(
      "write",
    );
    expect(boxWords(named, ctx)).toMatchObject({
      title: "Enter the bill",
      kind: "Do · Rules",
      detail: "QuickBooks › Create bill",
      connector: { id: "qbo", name: "QuickBooks" },
    });
    expect(boxWords(newStep("end", id), ctx).detail).toBe("Not filled in yet");
  });
});
