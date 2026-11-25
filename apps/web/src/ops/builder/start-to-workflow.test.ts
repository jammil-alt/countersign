// "Add steps" on a start (owner, 2026-11-24): the main workflow's start moves to a workflow of its
// own, keeping its id, that hands each run into the main workflow at its first step that takes an
// input, with that step's input; the main workflow keeps a start (by hand when it had only one).
import { type ProcessAgentBundle, processes } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { startToWorkflow } from "./model";

const read = (id: string, name: string, input: Record<string, unknown> = {}) =>
  ({ id, kind: "read", name, tool: "documents.get", input }) as processes.Step;

function bundle(triggers: processes.Process["triggers"]): ProcessAgentBundle {
  return {
    workflows: [
      {
        slug: "match-invoice",
        name: "Match an invoice's lines",
        enabled: true,
        workflow: {
          schemaVersion: 4,
          triggers,
          steps: [
            {
              id: "note",
              kind: "notify",
              name: "Tell",
              notify: { to: ["client_admin"], channel: "inbox", message: "" },
            } as processes.Step,
            read("get", "Get the document", { id: "{{trigger.document.id}}" }),
          ],
        },
      },
    ],
  } as unknown as ProcessAgentBundle;
}

const DOC = { id: "t-doc", on: { type: "event" as const, event: "document.extracted" } };
const DAILY = { id: "t-daily", on: { type: "schedule" as const, cron: "0 7 * * *" } };

const ids = () => {
  let n = 0;
  return () => `id-${++n}`;
};

describe("startToWorkflow", () => {
  it("moves a start to a workflow that hands into the main one, keeping the other starts", () => {
    const made = startToWorkflow(
      bundle([DOC, DAILY]),
      "match-invoice",
      "t-doc",
      "When a document has been read",
      ids(),
    );
    expect(made?.slug).toBe("when-a-document-has-been-read");
    const [main, moved] = made?.bundle.workflows ?? [];
    expect(main?.workflow.triggers).toEqual([DAILY]);
    expect(moved?.name).toBe("When a document has been read");
    expect(moved?.enabled).toBe(true);
    // The start keeps its id; its one step hands in at the first step that takes an input.
    expect(moved?.workflow.triggers).toEqual([DOC]);
    expect(moved?.workflow.steps).toEqual([
      {
        id: "id-1",
        kind: "handoff",
        name: "Hand off to Match an invoice's lines at 2 · Get the document",
        to: { agent: processes.SELF_AGENT, workflow: "match-invoice", step: "get" },
        input: { id: "{{trigger.document.id}}" },
      },
    ]);
  });

  it("leaves the main workflow started by hand when its only start moves", () => {
    const made = startToWorkflow(bundle([DOC]), "match-invoice", "t-doc", "Docs", ids());
    const main = made?.bundle.workflows[0];
    expect(main?.workflow.triggers).toEqual([
      { id: "id-2", on: { type: "manual", input: { type: "object", properties: {} } } },
    ]);
    expect(made?.bundle.workflows[1]?.workflow.triggers).toEqual([DOC]);
  });

  it("finds a free slug, and does nothing for a start it doesn't have", () => {
    const first = startToWorkflow(bundle([DOC, DAILY]), "match-invoice", "t-doc", "Docs", ids());
    const again = startToWorkflow(
      first?.bundle as ProcessAgentBundle,
      "match-invoice",
      "t-daily",
      "Docs",
      ids(),
    );
    expect(again?.slug).toBe("docs-2");
    expect(startToWorkflow(bundle([DOC]), "match-invoice", "nope", "Docs")).toBeNull();
    expect(startToWorkflow(bundle([DOC]), "other", "t-doc", "Docs")).toBeNull();
  });
});
