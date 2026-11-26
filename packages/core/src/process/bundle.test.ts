import { describe, expect, it } from "vitest";
import { AgentBundle, type AgentBundleInput } from "../schemas/agent";
import type { ToolSpec } from "../schemas/tool";
import type { TypingContext } from "../template/typer";
import { validateBundle } from "./bundle";
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

/** A v5 workflow with one trigger, the steps and nothing to deliver: complete enough to publish. */
const workflow = (trigger: string, steps: unknown[], end = "end") => ({
  schemaVersion: 5 as const,
  triggers: [{ id: trigger, on: { type: "manual", input: {} } }],
  outputs: [{ id: `${end}-o`, name: "Nothing to deliver", kind: "nothing" }],
  steps: [...steps, { id: end, kind: "end", name: "Done", outputs: [`${end}-o`] }],
});

const base: AgentBundleInput = {
  schemaVersion: 1,
  definition,
  workflows: [
    {
      slug: "old",
      name: "Old",
      workflow: workflow(
        "t1",
        [{ id: "w1", kind: "wait", name: "Wait", for: "1 day" }],
        "e1",
      ) as never,
    },
  ],
};

const read = {
  id: "q",
  kind: "do",
  doneBy: "rules",
  name: "Read",
  uses: { type: "action", action: QUERY.id },
};
const update = {
  id: "u",
  kind: "do",
  doneBy: "rules",
  name: "Update",
  uses: { type: "action", action: UPDATE.id },
  input: { id: "1" },
  checks: {
    confer: { with: [{ ai: { focus: "Do the lines add up?" } }] },
    approval: { approvers: [{ who: "client_admin", deadline: { after: "1 day" } }] },
  },
};

/** A v4 process, as the field picker reads an engine process. */
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

describe("validateBundle", () => {
  it("validates two workflows side by side, naming the workflow", () => {
    const two = {
      ...base,
      workflows: [
        ...(base.workflows ?? []),
        { slug: "new", name: "New", workflow: workflow("t2", [read, update]) },
      ],
    };
    const ok = validateBundle(two, CTX);
    expect(ok.errors).toEqual([]);
    expect(ok.valid).toBe(true);
    expect(AgentBundle.safeParse(ok.value).success).toBe(true);

    const bad = {
      ...two,
      workflows: [
        ...(base.workflows ?? []),
        {
          slug: "new",
          name: "New",
          // The first workflow's trigger id again, and an update with no id.
          workflow: workflow("t1", [read, { ...update, input: {} }]),
        },
      ],
    };
    const r = validateBundle(bad, CTX);
    expect(r.valid).toBe(false);
    expect(r.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ workflow: "new", stepId: "t1", code: "duplicate_id" }),
        expect.objectContaining({ workflow: "new", stepId: "u", stepCode: "input_missing" }),
      ]),
    );
  });

  it("reports a workflow's schema errors on its step and field", () => {
    const r = validateBundle(
      {
        ...base,
        workflows: [
          {
            slug: "new",
            name: "New",
            workflow: workflow("t2", [
              {
                id: "p",
                kind: "do",
                doneBy: "person",
                name: "Ask",
                person: { mode: "ask", who: "lead", question: "?" },
              },
            ]),
          },
        ],
      },
      CTX,
    );
    expect(r.errors).toEqual([
      expect.objectContaining({
        workflow: "new",
        code: "schema",
        field: "steps.0.person.deadline",
      }),
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

// Models: xAI and Gemini. A model with no price is counted at $0, so it could never reach a cost
// limit: the agent's own model and its owner's are checked against the priced list too.
describe("the agent's own models", () => {
  const MODELS = ["claude-opus-5-5", "openai:gpt-5.5", "xai:grok-4.7", "google:gemini-3.1-pro"];
  const withModels = (model: string, oversight?: string): AgentBundleInput => ({
    ...base,
    definition: {
      ...definition,
      model: { id: model },
      ...(oversight
        ? { oversight: { review: "failures" as const, model: { id: oversight } } }
        : {}),
    },
  });
  const unknown = (b: AgentBundleInput) =>
    [validateBundle(b, { ...CTX, models: MODELS }), validateBundle(b, { ...CTX, models: MODELS })]
      .flatMap((r): { code: string; field: string }[] => r.errors)
      .filter((e) => e.code === "unknown_model")
      .map((e) => e.field);

  it("refuses an unpriced xai: or google: id, for the agent and its owner", () => {
    expect(unknown(withModels("xai:grok-9"))).toEqual([
      "definition.model.id",
      "definition.model.id",
    ]);
    expect(unknown(withModels("google:gemini-9-ultra"))).toEqual([
      "definition.model.id",
      "definition.model.id",
    ]);
    expect(unknown(withModels("xai:grok-4.7", "google:gemini-0"))).toEqual([
      "definition.oversight.model.id",
      "definition.oversight.model.id",
    ]);
    const [error] = validateBundle(withModels("xai:grok-9"), { ...CTX, models: MODELS }).errors;
    expect(error?.message).toBe(
      'no priced model "xai:grok-9": its cost could not be counted against the limits',
    );
  });

  it("takes priced ids, and leaves Anthropic ids and an unlisted context as they were", () => {
    expect(unknown(withModels("xai:grok-4.7", "google:gemini-3.1-pro"))).toEqual([]);
    expect(unknown(withModels("m"))).toEqual([]);
    expect(validateBundle(withModels("xai:grok-9"), CTX).errors).toEqual([]);
  });
});
