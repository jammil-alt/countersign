// v0.18 (docs/plan.md §1.103): a step's data in the builder's words, the client's gaps, the agent's
// summary and what's left on a draft.
import {
  type AnyAgentBundleInput,
  ProcessAgentBundle,
  processes,
  type SkillDefinition,
  type ToolSpec,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  agentDataSummary,
  type ClientSetup,
  KEEPS_NOTHING,
  problemConnector,
  stepDataLines,
  stepDataWarnings,
  whatsLeft,
} from "./data-use";

const io = { type: "object" };
const spec = (t: Partial<ToolSpec> & Pick<ToolSpec, "id" | "sideEffect" | "source">) =>
  ({
    description: "",
    input: io,
    output: io,
    verb: t.sideEffect === "none" ? "read" : "create",
    ...t,
  }) as ToolSpec;

const TOOLS: Record<string, ToolSpec> = {
  "materials.vendor.match": spec({
    id: "materials.vendor.match",
    sideEffect: "none",
    source: "materials",
    area: "shared",
    entity: "vendor",
  }),
  "materials.catalog.create_item": spec({
    id: "materials.catalog.create_item",
    sideEffect: "internal",
    source: "materials",
    area: "purchasing",
    entity: "catalog_item",
  }),
  "qbo.bill.update_memo": spec({
    id: "qbo.bill.update_memo",
    sideEffect: "external",
    source: "qbo",
    connector: "qbo",
    entity: "bill",
    verb: "update",
  }),
  "qbo.bill.create": spec({
    id: "qbo.bill.create",
    sideEffect: "external",
    source: "qbo",
    connector: "qbo",
    entity: "bill",
  }),
  "billcom.bill.create": spec({
    id: "billcom.bill.create",
    sideEffect: "external",
    source: "billcom",
    connector: "billcom",
    entity: "bill",
  }),
  "web.search": spec({ id: "web.search", sideEffect: "none", source: "platform" }),
};

const intake = {
  schemaVersion: 1,
  id: "custom:intake",
  name: "Intake",
  description: "",
  category: "documents",
  mode: "task",
  instructions: "",
  tools: ["materials.vendor.match", "materials.catalog.create_item"],
  input: io,
  output: io,
  settings: [],
  requiresConnectors: [],
  requiresPacks: ["materials"],
  producesAlerts: false,
} as unknown as SkillDefinition;

const ctx = {
  tools: TOOLS,
  skills: { "custom:intake": intake },
  connectors: new Set(["qbo", "billcom"]),
};

const NAMES = {
  connector: (id: string) =>
    ({ qbo: "QuickBooks Online", billcom: "BILL" })[id] ?? id.toUpperCase(),
  pack: (id: string) => (id === "materials" ? "Materials" : id),
};

const use = (step: processes.Step) => processes.stepDataUse(step, ctx);
const read = (tool: string): processes.Step => ({
  id: "r",
  name: "Read",
  kind: "read",
  tool,
  input: {},
});
const skillStep: processes.Step = {
  id: "s",
  name: "Intake",
  kind: "skill",
  skill: "custom:intake",
  input: {},
};

describe("stepDataLines", () => {
  it("says a shared read's sources, an area's saves and a client tool's changes", () => {
    expect(stepDataLines(use(skillStep), NAMES)).toEqual([
      "Reads vendors (filled by QuickBooks, uploads or the directory)",
      "Saves items (Purchasing)",
    ]);
    const write: processes.Step = {
      id: "w",
      name: "Memo",
      kind: "write",
      tool: "qbo.bill.update_memo",
      input: {},
    };
    expect(stepDataLines(use(write), NAMES)).toEqual(["Changes bills in QuickBooks Online"]);
  });

  it("names every tool an action can change, once", () => {
    const action: processes.Step = {
      id: "a",
      name: "Create bill",
      kind: "write",
      action: "create_bill",
      input: {},
    };
    expect(stepDataLines(use(action), NAMES)).toEqual([
      "Changes bills in QuickBooks Online or BILL",
    ]);
  });

  it("says a step that only reads keeps nothing, and logic says nothing", () => {
    expect(stepDataLines(use(read("materials.vendor.match")), NAMES)).toEqual([
      "Reads vendors (filled by QuickBooks, uploads or the directory)",
      KEEPS_NOTHING,
    ]);
    expect(stepDataLines(use(read("web.search")), NAMES)).toEqual([KEEPS_NOTHING]);
    expect(
      stepDataLines(use({ id: "w", name: "Wait", kind: "wait", for: "1 day" }), NAMES),
    ).toEqual([]);
  });
});

describe("stepDataWarnings", () => {
  const client = (over: Partial<ClientSetup> = {}): ClientSetup => ({
    name: "Millwork",
    connected: new Set(),
    bound: new Set(),
    packs: new Map([["materials", false]]),
    ...over,
  });

  it("warns of a connection the client lacks, an unbound one, and a pack that's off", () => {
    const qboRead = use({ ...read("qbo.bill.update_memo"), kind: "write" } as processes.Step);
    expect(stepDataWarnings(qboRead, client(), NAMES)).toEqual([
      "QuickBooks Online isn't connected for Millwork",
    ]);
    expect(stepDataWarnings(qboRead, client({ connected: new Set(["qbo"]) }), NAMES)).toEqual([
      "This agent has no QuickBooks Online connection chosen",
    ]);
    expect(stepDataWarnings(use(skillStep), client(), NAMES)).toEqual([
      "The Materials pack is off for Millwork",
    ]);
  });

  it("warns of nothing for a template, or while the packs aren't known", () => {
    expect(stepDataWarnings(use(skillStep), null, NAMES)).toEqual([]);
    expect(stepDataWarnings(use(skillStep), client({ packs: null }), NAMES)).toEqual([]);
  });
});

const BUNDLE: AnyAgentBundleInput = {
  schemaVersion: 1,
  definition: {
    schemaVersion: 2,
    identity: { name: "Clerk", role: "Bills", mission: "Bills" },
    kind: "functional",
    model: { id: "test-model" },
    instructions: "",
    skills: [],
    permissions: { mode: "suggest_only" },
  },
  workflows: [
    {
      slug: "main",
      name: "Main",
      workflow: {
        schemaVersion: 4,
        triggers: [{ id: "t1", on: { type: "manual", input: io } }],
        steps: [
          {
            id: "m1",
            kind: "missing",
            name: "Read card charges",
            need: "There is no card feed connector.",
          },
          { id: "s1", kind: "skill", name: "Intake", skill: "custom:intake", input: {} },
          { id: "s2", kind: "skill", name: "Intake again", skill: "custom:intake", input: {} },
          {
            id: "w1",
            kind: "write",
            name: "Memo",
            tool: "qbo.bill.update_memo",
            input: {},
          },
        ],
      },
    },
  ],
};

describe("whatsLeft", () => {
  const bundle = ProcessAgentBundle.parse(BUNDLE);
  const client: ClientSetup = {
    name: "Millwork",
    connected: new Set(),
    bound: new Set(),
    packs: new Map([["materials", false]]),
  };

  it("lists missing steps, then what the client lacks once each, then a test run", () => {
    const items = whatsLeft({ bundle, ctx, client, names: NAMES, tested: false });
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ["missing", "Read card charges: There is no card feed connector."],
      ["pack", "Turn on the Materials pack for Millwork: 2 steps need it"],
      ["connection", "Connect QuickBooks Online for Millwork: 1 step needs it"],
      ["test", "Test-run it: it hasn't had a test run since its last change"],
    ]);
    // A click selects the first step that needs it.
    expect(items[1]).toMatchObject({ workflow: "main", stepId: "s1" });
  });

  it("empties as the draft is finished", () => {
    const done = ProcessAgentBundle.parse({
      ...BUNDLE,
      workflows: [
        {
          ...BUNDLE.workflows[0],
          workflow: {
            schemaVersion: 4,
            triggers: [{ id: "t1", on: { type: "manual", input: io } }],
            steps: [
              { id: "w1", kind: "write", name: "Memo", tool: "qbo.bill.update_memo", input: {} },
            ],
          },
        },
      ],
    });
    const ready: ClientSetup = { ...client, connected: new Set(["qbo"]), bound: new Set(["qbo"]) };
    expect(whatsLeft({ bundle: done, ctx, client: ready, names: NAMES, tested: true })).toEqual([]);
    // A template has no client: only its missing steps are left; a test run isn't known.
    expect(
      whatsLeft({ bundle, ctx, client: null, names: NAMES, tested: null }).map((i) => i.kind),
    ).toEqual(["missing"]);
  });
});

describe("agentDataSummary", () => {
  it("reads, saves and changes, each once, without the long words", () => {
    const bundle = ProcessAgentBundle.parse(BUNDLE);
    expect(agentDataSummary(bundle, ctx, NAMES)).toEqual({
      reads: ["vendors"],
      saves: ["items (Purchasing)"],
      changes: ["bills in QuickBooks Online"],
    });
  });
});

describe("problemConnector", () => {
  it("reads the connector a connection problem names", () => {
    expect(problemConnector('no qbo connection is bound for "qbo.bill.create"')).toBe("qbo");
    expect(problemConnector("something else")).toBeNull();
  });
});
