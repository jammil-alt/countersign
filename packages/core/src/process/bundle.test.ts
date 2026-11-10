import { describe, expect, it } from "vitest";
import { type AgentBundleInput, AnyAgentBundle } from "../schemas/agent";
import type { ToolSpec } from "../schemas/tool";
import type { TypingContext } from "../template/typer";
import { validateBundle } from "../workflow/validate";
import { validateAnyBundle } from "./bundle";
import { processPathsAt } from "./paths";

const UPDATE: ToolSpec = {
  id: "testkit.record.update",
  description: "Update a record",
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  output: { type: "object", properties: { total: { type: "number" } } },
  sideEffect: "external",
  verb: "update",
  source: "testkit",
  connector: "testkit",
};
const QUERY: ToolSpec = {
  id: "testkit.record.query",
  description: "Read records",
  input: { type: "object" },
  output: { type: "object", properties: { rows: { type: "array", items: { type: "object" } } } },
  sideEffect: "none",
  verb: "read",
  source: "testkit",
  connector: "testkit",
};
const CTX: TypingContext = { tools: { [UPDATE.id]: UPDATE, [QUERY.id]: QUERY } };

const definition = {
  schemaVersion: 2 as const,
  identity: { name: "Clerk", role: "Records", mission: "Keep records right" },
  kind: "functional" as const,
  model: { id: "m" },
  instructions: "Work carefully.",
  skills: [],
  extraTools: [UPDATE.id, QUERY.id],
  permissions: { mode: "act" as const },
};

const v3: AgentBundleInput = {
  schemaVersion: 1,
  definition,
  workflows: [
    {
      slug: "old",
      name: "Old",
      workflow: {
        schemaVersion: 3,
        trigger: { id: "t1", on: { type: "manual", input: {} } },
        steps: [{ id: "w1", kind: "wait", name: "Wait", for: "1 day" }],
      },
    },
  ],
};

const process = {
  schemaVersion: 4,
  triggers: [{ id: "t2", on: { type: "manual", input: {} } }],
  steps: [
    { id: "q", kind: "read", name: "Read", tool: QUERY.id },
    {
      id: "u",
      kind: "write",
      name: "Update",
      tool: UPDATE.id,
      input: { id: "1" },
      checks: {
        confer: { with: [{ ai: { focus: "Do the lines add up?" } }] },
        approval: { approvers: [{ who: "client_admin", deadline: { after: "1 day" } }] },
      },
    },
  ],
};

describe("validateAnyBundle", () => {
  it("validates an all-v3 bundle exactly as validateBundle does", () => {
    expect(validateAnyBundle(v3, CTX)).toEqual({ ...validateBundle(v3, CTX), warnings: [] });
  });

  it("validates v3 workflows and v4 processes side by side, naming the workflow", () => {
    const mixed = {
      ...v3,
      workflows: [...(v3.workflows ?? []), { slug: "new", name: "New", workflow: process }],
    };
    const ok = validateAnyBundle(mixed, CTX);
    expect(ok.errors).toEqual([]);
    expect(ok.valid).toBe(true);
    expect(AnyAgentBundle.safeParse(ok.value).success).toBe(true);

    const bad = {
      ...mixed,
      workflows: [
        ...(v3.workflows ?? []),
        {
          slug: "new",
          name: "New",
          workflow: {
            ...process,
            // The v3 workflow's id again, and an update with no id.
            triggers: [{ id: "t1", on: { type: "manual", input: {} } }],
            steps: [{ ...process.steps[1], input: {} }],
          },
        },
      ],
    };
    const r = validateAnyBundle(bad, CTX);
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workflow: "new", stepId: "t1", code: "duplicate_id" }),
        expect.objectContaining({ workflow: "new", stepId: "u", field: "input.id" }),
      ]),
    );
  });

  it("reports a process's schema errors on its step and field", () => {
    const r = validateAnyBundle(
      {
        ...v3,
        workflows: [
          {
            slug: "new",
            name: "New",
            workflow: {
              ...process,
              steps: [
                { id: "p", kind: "person", name: "Ask", mode: "ask", assignee: "lead", title: "?" },
              ],
            },
          },
        ],
      },
      CTX,
    );
    expect(r.errors).toEqual([
      expect.objectContaining({ workflow: "new", stepId: "p", code: "deadline_missing" }),
    ]);
  });
});

describe("processPathsAt", () => {
  it("offers the upstream outputs, and in checks the step's own output and the verdicts", () => {
    const paths = (o?: Parameters<typeof processPathsAt>[3]) =>
      processPathsAt(process as never, "u", CTX, o).map((p) => p.path);
    expect(paths()).toContain("steps.q.output.rows");
    expect(paths()).not.toContain("steps.u.output.total");
    expect(paths({ own: true, confer: 1 })).toEqual(
      expect.arrayContaining(["steps.u.output.total", "confer.0.verdict"]),
    );
    expect(processPathsAt(process as never, "missing", CTX)).toEqual([]);
  });
});
