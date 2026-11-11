// The vendor catalog's steps in the builder (docs/plan.md §1.88), on a fake API: the palette offers
// Match vendor and Match by SKU (vendor) as Deterministic skills, Semantic match (vendor) and the
// Master item manager as AI skills, Check matches beside them, and keeps the split's Look up
// existing off (superseded); the Materials pack's tools sit under "Materials", the retrieval reads
// as reads and Register item as a Save to records step whose approval is off until the operator
// turns it on.
import {
  AnyAgentBundle,
  type AnyAgentBundleInput,
  type BuilderCatalog,
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
const CLIENT_ID = "00000000-0000-4000-8000-00000000a001";
const V1 = "00000000-0000-4000-8000-0000000f0301";
const BASE = `/ops/clients/${CLIENT_ID}/agents/purchasing`;

const io = (props: Record<string, unknown>) => ({ type: "object", properties: props });

function skill(
  id: string,
  name: string,
  mode: "tool" | "task",
  over: Partial<SkillDefinition> = {},
): SkillDefinition {
  return {
    schemaVersion: 1,
    id,
    name,
    description: `${name}.`,
    category: "Materials",
    mode,
    ...(mode === "task" ? { model: { id: "claude-haiku-5-5" }, instructions: "Decide." } : {}),
    tools: [],
    input: io({ lines: { type: "array", items: {} } }),
    output: io({ answers: { type: "array", items: {} } }),
    settings: [],
    requiresConnectors: [],
    requiresPacks: ["materials"],
    producesAlerts: false,
    ...over,
  } as SkillDefinition;
}

const entry = (def: SkillDefinition, kind: "ai" | "deterministic", palette = true) => ({
  ref: def.id,
  source: "builtin" as const,
  version: null,
  definition: def,
  kind,
  palette,
});

const tool = (id: string, sideEffect: "none" | "internal", description: string) => ({
  id,
  description,
  input: io({}),
  output: io({}),
  sideEffect,
  verb: sideEffect === "none" ? ("read" as const) : ("create" as const),
  source: "materials",
});

const CATALOG = {
  skills: [
    entry(
      skill("materials.match-vendor", "Match vendor", "tool", {
        handler: "materials.vendor.match",
        tools: ["materials.vendor.match"],
      }),
      "deterministic",
    ),
    entry(
      skill("materials.match-sku-vendor", "Match by SKU (vendor)", "tool", {
        handler: "materials.vendor_items.lookup",
        tools: ["materials.vendor_items.lookup"],
      }),
      "deterministic",
    ),
    entry(
      skill("materials.semantic-match-vendor", "Semantic match (vendor)", "task", {
        reads: ["materials.vendor_items.list"],
      }),
      "ai",
    ),
    entry(
      skill("materials.master-item-manager", "Master item manager", "task", {
        reads: ["materials.catalog.search"],
      }),
      "ai",
    ),
    entry(
      skill("materials.check-matches", "Check matches", "tool", {
        handler: "materials.matches.check",
        tools: ["materials.matches.check"],
      }),
      "deterministic",
    ),
    // Superseded by Match by SKU (vendor) for new steps; listed so stored steps type.
    entry(
      skill("materials.lookup-existing", "Look up existing", "tool", {
        handler: "materials.lines.lookup",
        tools: ["materials.lines.lookup"],
      }),
      "deterministic",
      false,
    ),
  ],
  tools: [
    tool("materials.vendor.match", "none", "The vendor a document is from"),
    tool("materials.vendor_items.lookup", "none", "This vendor's items by SKU or wording"),
    tool("materials.vendor_items.similar", "none", "The vendor's closest items to each open line"),
    tool("materials.master_items.candidates", "none", "Master items a new line could be"),
    tool("materials.vendor_items.list", "none", "One vendor's catalog"),
    tool("materials.vendor_items.register", "internal", "Writes vendor items, aliases and prices"),
  ],
  connectors: [],
  stepTools: [
    "materials.vendor_items.similar",
    "materials.master_items.candidates",
    "materials.vendor_items.register",
  ],
  automations: [],
} as unknown as BuilderCatalog;

const BUNDLE: AnyAgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Purchasing", role: "Purchasing", mission: "Know what we buy" },
    kind: "functional",
    model: { id: "claude-sonnet-5-5" },
    instructions: "Match vendor invoice lines.",
    skills: [],
    extraTools: [],
    permissions: { mode: "act" },
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 4,
        triggers: [
          { id: "t1", on: { type: "manual", input: io({ documentId: { type: "string" } }) } },
        ],
        steps: [
          {
            id: "tell",
            kind: "notify",
            name: "Tell",
            notify: { to: ["client_admin"], channel: "inbox", message: "Started" },
          },
        ],
      },
    },
  ],
};

const AGENT: AgentSummary = {
  id: AGENT_ID,
  tenantId: CLIENT_ID,
  kind: "client",
  slug: "purchasing",
  name: "Purchasing",
  role: "Purchasing",
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

function version(): VersionDetail {
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
    bundle: AnyAgentBundle.parse(BUNDLE),
  } as unknown as VersionDetail;
}

function setup() {
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const api = fakeApi({
    [`GET /api/ops/agents/${AGENT_ID}/builder-catalog`]: () => CATALOG,
    "GET /api/ops/catalog/events": () => ({ events: [] }),
    "GET /api/ops/clients": () => ({ clients: [] }),
    "GET /api/ops/models": () => ({ models: [] }),
    "GET /api/ops/skills": () => ({ skills: [], tools: [], connectors: [] }),
    [`POST /api/ops/agents/${AGENT_ID}/versions`]: ({ init }) => {
      sent.push({ path: "save", body: JSON.parse(String(init.body)) });
      return { version: { ...version(), bundle: undefined }, errors: [] };
    },
  });
  const bundle = AnyAgentBundle.parse(BUNDLE);
  function Page() {
    const { workflow = "" } = useParams();
    return (
      <WorkflowBuilder
        agent={AGENT}
        from={version()}
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

function savedSteps(sent: { path: string; body: Record<string, unknown> }[]) {
  const body = sent.filter((s) => s.path === "save").at(-1)?.body;
  const w = AnyAgentBundle.parse(body?.bundle).workflows[0]?.workflow;
  if (w?.schemaVersion !== 4) throw new Error("not a process");
  return w.steps;
}

describe("the vendor catalog's steps in the builder", () => {
  it("offers the vendor-first skills with their kinds, and not the superseded Look up existing", async () => {
    const { user } = setup();
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-add-step"));
    const skills = screen.getByTestId("builder-palette-skills");
    for (const [ref, kind] of [
      ["materials.match-vendor", "Deterministic"],
      ["materials.match-sku-vendor", "Deterministic"],
      ["materials.semantic-match-vendor", "AI"],
      ["materials.master-item-manager", "AI"],
      ["materials.check-matches", "Deterministic"],
    ] as const) {
      expect(
        within(skills).getByTestId(`builder-palette-item-skill:${ref}-kind`),
      ).toHaveTextContent(kind);
    }
    expect(screen.queryByTestId("builder-palette-item-skill:materials.lookup-existing")).toBeNull();
    // The pack's step tools under its name: the retrieval reads, then Register item.
    const pack = screen.getByTestId("builder-palette-connector:materials");
    expect(pack).toHaveTextContent("Materials");
    expect(
      within(pack).getByTestId("builder-palette-item-read:materials.vendor_items.similar"),
    ).toHaveTextContent("Find the vendor's closest items");
    expect(
      within(pack).getByTestId("builder-palette-item-read:materials.master_items.candidates"),
    ).toHaveTextContent("Find master items it could be");
    const register = within(pack).getByTestId(
      "builder-palette-item-write:materials.vendor_items.register",
    );
    expect(register).toHaveTextContent("Register item");
    expect(register).toHaveTextContent("Save to records");
    expect(
      screen.getByTestId("builder-palette-item-write:materials.vendor_items.register-kind"),
    ).toHaveTextContent("Write");
  });

  it("adds Register item as Save to records, approval off, and lets the operator turn it on", async () => {
    const { sent, user } = setup();
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-add-step"));
    await user.click(
      screen.getByTestId("builder-palette-item-write:materials.vendor_items.register-add"),
    );
    const inspector = screen.getByTestId("builder-inspector");
    expect(inspector).toHaveTextContent("Register item");
    expect(inspector).toHaveTextContent("Save to records");
    expect(inspector).toHaveTextContent("Approval is off by default");
    // Saved as it is: a write on the tool, with no approval.
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(sent.some((s) => s.path === "save")).toBe(true));
    const first = savedSteps(sent).at(-1);
    expect(first).toMatchObject({ kind: "write", tool: "materials.vendor_items.register" });
    expect(first?.checks?.approval).toBeUndefined();
    // The operator turns the optional approval on, so a person confirms new master items.
    await user.click(screen.getByTestId("builder-approval-add"));
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(sent.filter((s) => s.path === "save")).toHaveLength(2));
    expect(savedSteps(sent).at(-1)?.checks?.approval?.required).toBe("required");
  });

  it("adds Semantic match (vendor) as an AI skill step", async () => {
    const { sent, user } = setup();
    await screen.findByTestId("builder-canvas");
    await user.click(screen.getByTestId("builder-add-step"));
    await user.click(
      screen.getByTestId("builder-palette-item-skill:materials.semantic-match-vendor-add"),
    );
    expect(screen.getByTestId("builder-inspector")).toHaveTextContent("AI");
    await user.click(screen.getByTestId("builder-save"));
    await waitFor(() => expect(sent.some((s) => s.path === "save")).toBe(true));
    expect(savedSteps(sent).at(-1)).toMatchObject({
      kind: "skill",
      skill: "materials.semantic-match-vendor",
    });
  });
});
