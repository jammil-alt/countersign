// Reshape data (owner, 2026-11-11) in the builder, on a fake API: a write whose inputs earlier
// steps can't fill offers "Add a Reshape step before this", which places one with its mapping
// proposed by name and type and the write wired to it; "Propose a mapping" asks the server (by
// name, then the Builder AI), each field shows the value it would give and can be edited, and
// the save holds the mapping as data. A mapping the validator flags offers "Propose an updated
// mapping".
import {
  AnyAgentBundle,
  type AnyAgentBundleInput,
  type BuilderCatalog,
  processes,
  type SkillDefinition,
} from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useParams } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { AgentSummary, VersionDetail } from "../../api/routes";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import WorkflowBuilder from "./WorkflowBuilder";

const AGENT_ID = "00000000-0000-4000-8000-00000000b301";
const V1 = "00000000-0000-4000-8000-0000000f0301";
const BASE = "/ops/templates/bill-clerk";

const io = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
});

const READ: SkillDefinition = {
  schemaVersion: 1,
  id: "docs.read-document",
  name: "Read document",
  description: "Reads an invoice.",
  category: "documents",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  tools: [],
  input: io({ documentId: { type: "string" } }),
  output: io({
    header: io({
      vendorName: { type: "string" },
      invoiceNumber: { type: "string" },
      invoiceDate: { type: "string" },
      currency: { type: "string" },
      poNumber: { type: "string" },
    }),
    lines: {
      type: "array",
      items: io({ description: { type: "string" }, extPrice: { type: "string" } }),
    },
    total: { type: "string" },
  }),
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
} as SkillDefinition;

const RESHAPE: SkillDefinition = {
  schemaVersion: 1,
  id: processes.RESHAPE_SKILL,
  name: "Reshape data",
  description: "Turns what earlier steps found into what the next step takes.",
  category: "data",
  mode: "tool",
  handler: processes.RESHAPE_TOOL,
  tools: [processes.RESHAPE_TOOL],
  input: { type: "object", additionalProperties: true },
  output: { type: "object", additionalProperties: true },
  settings: [],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

const CATALOG: BuilderCatalog = {
  skills: [
    { ref: READ.id, source: "builtin", version: null, definition: READ, kind: "ai", palette: true },
    {
      ref: RESHAPE.id,
      source: "builtin",
      version: null,
      definition: RESHAPE,
      kind: "deterministic",
      palette: true,
    },
  ],
  tools: [
    {
      id: processes.RESHAPE_TOOL,
      description: "Reshapes data",
      input: io({}),
      output: io({}),
      sideEffect: "none",
      verb: "read",
      source: "platform",
    },
  ],
  connectors: [],
  stepTools: [],
  automations: [],
};

const TRIGGER = { id: "t1", on: { type: "manual", input: io({ documentId: { type: "string" } }) } };
const READ_STEP = {
  id: "read",
  kind: "skill",
  name: "Read document",
  skill: READ.id,
  input: { documentId: "{{trigger.documentId}}" },
};
const BILL_STEP = {
  id: "bill",
  kind: "write",
  name: "Create bill",
  action: "create_bill",
  input: {},
  checks: { approval: { required: "required" } },
};

function bundleWith(steps: unknown[]): AnyAgentBundleInput {
  return {
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name: "Bill clerk", role: "Bills", mission: "Enter bills" },
      kind: "functional",
      model: { id: "claude-opus-5-5" },
      instructions: "Enter bills.",
      skills: [
        { skill: READ.id, settings: {} },
        ...(steps.some((s) => (s as { skill?: string }).skill === RESHAPE.id)
          ? [{ skill: RESHAPE.id, settings: {} }]
          : []),
      ],
      extraTools: [],
      permissions: { mode: "suggest_only" },
    },
    workflows: [
      {
        slug: "main",
        name: "Main",
        workflow: { schemaVersion: 4, triggers: [TRIGGER], steps },
      },
    ],
  } as AnyAgentBundleInput;
}

const AGENT: AgentSummary = {
  id: AGENT_ID,
  tenantId: null,
  kind: "template",
  slug: "bill-clerk",
  name: "Bill clerk",
  role: "Bills",
  templateId: null,
  linked: false,
  liveVersionId: null,
  status: "active",
  runStatus: "active",
  serviceName: null,
  serviceDescription: null,
  bindings: {},
  approver: null,
  testCopy: false,
  createdAt: "2026-11-11T00:00:00.000Z",
};

function version(bundle: AnyAgentBundleInput): VersionDetail {
  return {
    id: V1,
    version: 1,
    status: "draft",
    bundleHash: "h1",
    changeNote: null,
    releaseNote: null,
    authorId: null,
    parentVersionId: null,
    basedOnTemplateVersionId: null,
    createdAt: "2026-11-11T00:00:00.000Z",
    publishedAt: null,
    bundle: AnyAgentBundle.parse(bundle),
  } as unknown as VersionDetail;
}

const field = (
  name: string,
  from: unknown,
  schema: unknown = { type: "string" },
  required = true,
) => ({
  name,
  schema,
  ...(required ? {} : { required: false }),
  ...(from ? { from } : {}),
});

/** The server's proposal: by name, then the Builder AI's memo; vendorId left for the operator. */
function proposal(stepId: string) {
  return {
    stepId,
    next: { stepId: "bill", name: "Create bill" },
    sources: [
      { key: "trigger", label: "Trigger", template: "{{trigger}}" },
      { key: "readDocument", label: "Read document", template: "{{steps.read.output}}" },
    ],
    input: { readDocument: "{{steps.read.output}}" },
    mapping: {
      fields: [
        field("vendorId", null, { type: "string" }, false),
        field("vendorName", { input: "readDocument.header.vendorName" }, { type: "string" }, false),
        field("invoiceNumber", { input: "readDocument.header.invoiceNumber" }),
        field("date", { input: "readDocument.header.invoiceDate" }),
        field("total", { input: "readDocument.total" }),
        field("currency", { input: "readDocument.header.currency" }),
        field(
          "lines",
          {
            mapList: {
              list: { input: "readDocument.lines" },
              fields: { description: { item: "description" }, amount: { item: "extPrice" } },
            },
          },
          processes.actionInputSchema("create_bill").properties
            ? (processes.actionInputSchema("create_bill").properties as Record<string, unknown>)
                .lines
            : {},
        ),
        field(
          "memo",
          { join: { values: [{ value: "PO" }, { input: "readDocument.header.poNumber" }] } },
          { type: "string" },
          false,
        ),
      ],
    },
    how: { vendorName: "exact", invoiceNumber: "exact", date: "synonym", memo: "ai" },
    unmapped: ["vendorId"],
    ai: {
      asked: true,
      fields: ["memo"],
      dropped: [{ field: "vendorId", reason: "not an expression from the allowed set" }],
      why: {},
      costUsd: "0.0072",
    },
  };
}

function setup(steps: unknown[]) {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const BUNDLE = bundleWith(steps);
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => CATALOG,
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/ops/models": () => ({ models: [] }),
    [`POST /api/ops/agents/${AGENT_ID}/reshape/propose`]: ({ init }) => {
      const body = JSON.parse(String(init.body));
      sent.push({ path: "propose", body });
      return proposal(body.stepId);
    },
    [`POST /api/ops/agents/${AGENT_ID}/reshape/sample`]: ({ init }) => {
      const body = JSON.parse(String(init.body));
      sent.push({ path: "sample", body });
      const step = processes.findStep(body.process, body.stepId)?.step;
      const fields = step?.kind === "skill" ? (step.reshape?.fields ?? []) : [];
      return {
        source: "schema",
        run: null,
        input: {},
        fields: fields.map((f: { name: string; from?: unknown }) => ({
          name: f.name,
          value: f.name === "vendorName" ? "Cascade Lumber" : f.from ? `Sample ${f.name}` : null,
          problem: null,
        })),
      };
    },
    [`POST /api/ops/agents/${AGENT_ID}/versions`]: ({ init }) => {
      sent.push({ path: "save", body: JSON.parse(String(init.body)) });
      return { version: { ...version(BUNDLE), bundle: undefined }, errors: [] };
    },
  });
  const bundle = AnyAgentBundle.parse(BUNDLE);
  function Page() {
    const { workflow = "" } = useParams();
    return (
      <WorkflowBuilder
        agent={AGENT}
        from={version(BUNDLE)}
        bundle={bundle}
        workflow={workflow}
        base={BASE}
        tabs={<nav aria-label="Sections" />}
        connections={[]}
        members={[]}
        onChanged={() => {}}
      />
    );
  }
  render(
    <ApiProvider client={api.client}>
      <MemoryRouter initialEntries={[`${BASE}/workflows/main`]}>
        <Routes>
          <Route path={`${BASE}/workflows/:workflow`} element={<Page />} />
        </Routes>
      </MemoryRouter>
    </ApiProvider>,
  );
  return { sent, user: userEvent.setup() };
}

function saved(sent: { path: string; body: Record<string, unknown> }[]) {
  const body = sent.filter((s) => s.path === "save").at(-1)?.body;
  const bundle = AnyAgentBundle.parse(body?.bundle);
  const w = bundle.workflows[0]?.workflow;
  if (w?.schemaVersion !== 4) throw new Error("not a process");
  return { bundle, process: w };
}

describe("Reshape data in the builder", () => {
  it("adds a Reshape step before a write it can't fill, proposes, edits a field and saves", async () => {
    const { sent, user } = setup([READ_STEP, BILL_STEP]);
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-step-bill-select"));
    // Create bill's inputs can't be filled from Read document's output as it is.
    await user.click(await screen.findByTestId("builder-offer-reshape-before"));
    const inspector = screen.getByTestId("builder-inspector");
    expect(inspector).toHaveTextContent("Reshape data");
    expect(inspector).toHaveTextContent("Deterministic");
    // The proposal by name and type is there at once, before any model is asked.
    expect(screen.getByTestId("builder-reshape-from-invoiceNumber")).toHaveTextContent(
      "readDocument.header.invoiceNumber",
    );
    expect(screen.getByTestId("builder-reshape-from-date")).toHaveTextContent(
      "readDocument.header.invoiceDate",
    );
    expect(screen.getByTestId("builder-reshape-from-memo")).toHaveTextContent("Not mapped");
    // Each field shows the value it would give.
    await waitFor(() =>
      expect(screen.getByTestId("builder-reshape-sample-vendorName")).toHaveTextContent(
        "Gives: Cascade Lumber",
      ),
    );

    // The server's proposal adds the Builder AI's memo, and says what it left.
    await user.click(screen.getByTestId("builder-reshape-propose"));
    await waitFor(() =>
      expect(screen.getByTestId("builder-reshape-from-memo")).toHaveTextContent(
        "suggested by the Builder AI",
      ),
    );
    expect(screen.getByTestId("builder-reshape-proposal")).toHaveTextContent(
      "the Builder AI filled 1",
    );
    expect(screen.getByTestId("builder-reshape-dropped")).toHaveTextContent("vendorId");
    const asked = sent.find((s) => s.path === "propose")?.body;
    expect(asked).toMatchObject({ stepId: expect.any(String) });
    expect(asked?.update).toBeUndefined();

    // The operator maps the vendor's id by hand, as a fixed value.
    await user.click(screen.getByTestId("builder-reshape-edit-vendorId"));
    const editor = screen.getByTestId("builder-reshape-editor-vendorId");
    await user.selectOptions(within(editor).getByTestId("builder-reshape-kind"), "value");
    await user.type(within(editor).getByTestId("builder-reshape-value"), "56");
    await user.click(within(editor).getByTestId("builder-reshape-save-field"));
    expect(screen.getByTestId("builder-reshape-from-vendorId")).toHaveTextContent("56");

    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(sent.some((s) => s.path === "save")).toBe(true));
    const { bundle, process } = saved(sent);
    const shape = process.steps[1];
    expect(shape).toMatchObject({
      kind: "skill",
      skill: processes.RESHAPE_SKILL,
      input: { readDocument: "{{steps.read.output}}" },
    });
    if (shape?.kind !== "skill") throw new Error("no Reshape step");
    const from = Object.fromEntries((shape.reshape?.fields ?? []).map((f) => [f.name, f.from]));
    expect(from).toMatchObject({
      vendorId: { value: 56 },
      memo: { join: { values: [{ value: "PO" }, { input: "readDocument.header.poNumber" }] } },
    });
    // Create bill reads the Reshape step's output, field by field.
    expect(processes.findStep(process, "bill")?.step).toMatchObject({
      input: {
        invoiceNumber: `{{steps.${shape.id}.output.invoiceNumber}}`,
        lines: `{{steps.${shape.id}.output.lines}}`,
      },
    });
    // The agent may use the skill: it joined its skills in the same edit.
    expect(bundle.definition.skills.map((s) => s.skill)).toContain(processes.RESHAPE_SKILL);
  });

  it("flags a mapping that no longer type-checks, and proposes an updated one", async () => {
    const stale = {
      id: "shape",
      kind: "skill",
      name: "Reshape data",
      skill: RESHAPE.id,
      input: { readDocument: "{{steps.read.output}}" },
      reshape: {
        fields: [
          field("invoiceNumber", { input: "readDocument.header.number" }),
          field("date", { input: "readDocument.header.invoiceDate" }),
        ],
      },
    };
    const bill = {
      ...BILL_STEP,
      input: {
        invoiceNumber: "{{steps.shape.output.invoiceNumber}}",
        date: "{{steps.shape.output.date}}",
      },
    };
    const { sent, user } = setup([READ_STEP, stale, bill]);
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-step-shape-select"));
    expect(await screen.findByTestId("builder-reshape-problem-invoiceNumber")).toHaveTextContent(
      'invoiceNumber reads input.readDocument.header.number: no field "number"',
    );
    await user.click(screen.getByTestId("builder-reshape-propose-update"));
    await waitFor(() => expect(sent.some((s) => s.path === "propose")).toBe(true));
    expect(sent.find((s) => s.path === "propose")?.body).toMatchObject({
      stepId: "shape",
      update: true,
    });
    await waitFor(() =>
      expect(screen.queryByTestId("builder-reshape-problem-invoiceNumber")).toBeNull(),
    );
    expect(screen.getByTestId("builder-reshape-from-invoiceNumber")).toHaveTextContent(
      "readDocument.header.invoiceNumber",
    );
  });
});
