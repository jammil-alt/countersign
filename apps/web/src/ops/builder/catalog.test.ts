// The server's checks in the browser (wave 3b): a template's bundle is validated as the server's
// publish validates it, with `clientAgent: false`, so a template's process step can't change an
// inner step's approval in the builder any more than on the server.
import { AnyAgentBundle, type AnyAgentBundleInput, type BuilderCatalog } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { validateMerged } from "../merge/MergeScreen";
import { typingContext, validateProcessesLikeServer } from "./catalog";

const CATALOG: BuilderCatalog = {
  skills: [],
  tools: [
    {
      id: "testkit.record.update",
      description: "Updates a record",
      input: { type: "object", properties: { id: { type: "string" } } },
      output: { type: "object" },
      sideEffect: "external",
      verb: "update",
      source: "testkit",
      connector: "testkit",
    },
  ],
  connectors: [{ id: "testkit", name: "Testkit", icon: null }],
  automations: [
    {
      ref: "correct@1",
      slug: "correct",
      version: 1,
      name: "Correct the record",
      description: "Corrects a record",
      source: "shared",
      status: "live",
      definition: {
        schemaVersion: 1,
        slug: "correct",
        name: "Correct the record",
        description: "Corrects a record",
        input: { type: "object", properties: {} },
        output: {},
        steps: [
          {
            id: "u",
            kind: "action",
            name: "Update",
            tool: "testkit.record.update",
            input: { id: "x" },
            approval: { required: "required", onReject: "stop" },
          },
        ],
        requires: { skills: [], tools: ["testkit.record.update"], connectors: ["testkit"] },
      },
      outputSchema: { type: "object", properties: {} },
    },
  ],
};
const ctx = typingContext({ catalog: CATALOG, events: [] });

function bundle(
  steps: Record<string, unknown>[],
  more: AnyAgentBundleInput["workflows"] = [],
): AnyAgentBundle {
  return AnyAgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Clerk", role: "Bills", mission: "Keep bills right" },
      kind: "functional",
      model: { id: "claude-opus-5-5" },
      instructions: "Work.",
      skills: [],
      extraTools: ["testkit.record.update"],
      permissions: { mode: "act" },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: {
          schemaVersion: 4,
          triggers: [{ id: "t1", on: { type: "manual", input: { type: "object" } } }],
          steps,
        },
      },
      ...more,
    ],
  });
}

const processStep = {
  id: "p",
  kind: "process",
  name: "Correct it",
  process: "correct@1",
  input: {},
  approvals: {
    u: { required: "required", mode: "in_turn", ifNoAnswer: "stop", onReject: "stop" },
  },
};

describe("validateProcessesLikeServer", () => {
  it("refuses a template's process step that changes an inner approval, as publish does", () => {
    const b = bundle([processStep]);
    const template = validateProcessesLikeServer(b, ctx, { clientAgent: false });
    expect(template.errors.map((e) => e.code)).toContain("approvals_not_client");
    const client = validateProcessesLikeServer(b, ctx, { clientAgent: true });
    expect(client.errors.map((e) => e.code)).not.toContain("approvals_not_client");
  });
});

describe("validateMerged", () => {
  it("checks the merged bundle whole, as the server does: ids across workflows, and as its target", () => {
    const second = {
      slug: "other",
      name: "Other",
      workflow: {
        schemaVersion: 4 as const,
        // The same trigger id as the first workflow's: refused across the bundle.
        triggers: [{ id: "t1", on: { type: "manual" as const, input: { type: "object" } } }],
        steps: [],
      },
    };
    const merged = bundle([], [second]);
    expect(validateMerged(merged, ctx, true).errors.map((e) => e.code)).toContain("duplicate_id");
    // A promotion lands on the template: its process step may not change inner approvals.
    const promoted = bundle([processStep]);
    expect(validateMerged(promoted, ctx, false).errors.map((e) => e.code)).toContain(
      "approvals_not_client",
    );
    expect(validateMerged(promoted, ctx, true).valid).toBe(true);
  });
});
