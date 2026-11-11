// The vendor catalog's skills in the Library (docs/plan.md §1.88): Match vendor and Match by SKU
// (vendor) are Deterministic built-in code (no Clone) with the agent's parameters; Semantic match
// (vendor) and the Master item manager are the Library's own AI skills (shared operator skills the
// pack installed), so they open in the skill editor with Edit, with their instructions, model, the
// vendor catalog read they retrieve with and their nested output, and save a new version in the
// same shape.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const COPY_ID = "00000000-0000-4000-8000-00000000c0c1";
const COPY_V1 = "00000000-0000-4000-8000-00000000c0d1";
const MANAGER_ID = "00000000-0000-4000-8000-00000000c0c2";

const listItem = (over: Record<string, unknown>) => ({
  description: "",
  category: "Materials",
  source: "builtin",
  clientId: null,
  clientName: null,
  status: "active",
  liveVersion: null,
  latestVersion: null,
  latestStatus: null,
  inputs: ["lines"],
  outputs: ["answers"],
  tools: [],
  connectors: [],
  usedBy: 0,
  ...over,
});

const SKILLS = [
  listItem({
    id: "materials.match-vendor",
    ref: "materials.match-vendor",
    name: "Match vendor",
    description: "Finds the client's vendor for a document. The same every time; no model.",
    mode: "tool",
    kind: "deterministic",
    kindLabel: "Deterministic",
    tools: ["materials.vendor.match"],
    parameters: [
      {
        name: "match_on",
        label: "Match the vendor on",
        type: "text",
        default: "document, tax id, email domain, name",
      },
      {
        name: "min_name_similarity",
        label: "Take a vendor whose name is at least this close (1 = the same name only)",
        type: "number",
        default: 1,
      },
    ],
  }),
  listItem({
    id: "materials.match-sku-vendor",
    ref: "materials.match-sku-vendor",
    name: "Match by SKU (vendor)",
    description: "Looks each invoice line up in this vendor's catalog.",
    mode: "tool",
    kind: "deterministic",
    kindLabel: "Deterministic",
    tools: ["materials.vendor_items.lookup"],
    parameters: [
      {
        name: "vendor_shortlist_size",
        label: "Shortlist of the vendor's own items",
        type: "number",
        default: 5,
      },
      {
        name: "master_shortlist_size",
        label: "Shortlist of master items",
        type: "number",
        default: 5,
      },
    ],
  }),
  // The Library's own: shared operator skills the Materials pack installed, v1 live.
  listItem({
    id: COPY_ID,
    ref: "custom:semantic-match-vendor",
    name: "Semantic match (vendor)",
    description: "Decides whether each open line is one of the vendor's own items.",
    mode: "task",
    method: "ai",
    source: "shared",
    liveVersion: 1,
    latestVersion: 1,
    latestStatus: "live",
    kind: "ai",
    kindLabel: "AI",
    reads: ["materials.vendor_items.list"],
    recommendedModel: { id: "claude-haiku-5-5" },
  }),
  listItem({
    id: MANAGER_ID,
    ref: "custom:master-item-manager",
    name: "Master item manager",
    description: "Links a line new to its vendor to a master item, or creates one.",
    mode: "task",
    method: "ai",
    source: "shared",
    liveVersion: 1,
    latestVersion: 1,
    latestStatus: "live",
    kind: "ai",
    kindLabel: "AI",
    reads: ["materials.catalog.search"],
    recommendedModel: { id: "claude-haiku-5-5" },
  }),
];

const TOOLS = [
  {
    id: "materials.vendor_items.list",
    description: "One vendor's catalog: every item, last price, pack size",
    input: { type: "object", properties: { vendorId: { type: "string" } } },
    output: { type: "object", properties: { items: { type: "array" } } },
    sideEffect: "none",
    verb: "read",
    source: "materials",
  },
  {
    id: "materials.vendor_items.register",
    description: "Writes the vendor items, aliases, links or new master items and prices",
    input: { type: "object", properties: {} },
    output: { type: "object", properties: {} },
    sideEffect: "internal",
    verb: "create",
    source: "materials",
  },
];

const ANSWER = {
  type: "object",
  properties: {
    lineNo: { type: "integer" },
    decision: { type: "string", enum: ["matched", "new_item", "unsure"] },
    catalogItemId: { type: ["string", "null"] },
    vendorItemId: { type: ["string", "null"] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["lineNo", "decision", "confidence"],
};

const INSTRUCTIONS =
  "You decide, for each open line of one vendor's invoice, whether it is one of the items that vendor already sells this shop.";

const COPY_DEFINITION = {
  schemaVersion: 1,
  id: "custom:semantic-match-vendor",
  name: "Semantic match (vendor)",
  description: "Decides whether each open line is one of the vendor's own items.",
  category: "Materials",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: INSTRUCTIONS,
  tools: [],
  reads: ["materials.vendor_items.list"],
  input: {
    type: "object",
    properties: {
      lines: {
        type: "array",
        items: { type: "object", properties: { lineNo: { type: "integer" } } },
      },
    },
    required: ["lines"],
  },
  output: {
    type: "object",
    properties: { answers: { type: "array", items: ANSWER } },
    required: ["answers"],
  },
  settings: [],
  summary: "Answered {{answers.length}} open lines",
  requiresConnectors: [],
  requiresPacks: ["materials"],
  producesAlerts: false,
};

const COPY = SKILLS.find((s) => s.id === COPY_ID) as ReturnType<typeof listItem>;

const COPY_VERSION = {
  id: COPY_V1,
  version: 1,
  status: "live",
  definition: COPY_DEFINITION,
  changeNote: "Installed with the Materials pack 0.3.0",
  authorId: null,
  parentVersionId: null,
  createdAt: "2026-11-11T00:00:00.000Z",
};

function Probe() {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

function renderAt(path: string, routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION, ...routes });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <Probe />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, user: userEvent.setup() };
}

describe("the vendor catalog's skills in the Library", () => {
  it("labels each by its kind; the deterministic ones are code, the AI ones the Library's to edit", async () => {
    window.localStorage.removeItem("mezonas.skills.view");
    const { user } = renderAt("/ops/library/skills", {
      "GET /api/ops/skills": () => ({ skills: SKILLS, tools: TOOLS, connectors: [] }),
    });
    for (const [ref, kind] of [
      ["materials.match-vendor", "Deterministic"],
      ["materials.match-sku-vendor", "Deterministic"],
      ["custom:semantic-match-vendor", "AI"],
      ["custom:master-item-manager", "AI"],
    ] as const) {
      expect(await screen.findByTestId(`skills-card-${ref}-kind`)).toHaveTextContent(kind);
    }
    // The AI filter shows only the two AI skills.
    await user.click(screen.getByTestId("skills-kind-ai"));
    expect(screen.queryByTestId("skills-card-materials.match-vendor")).toBeNull();
    expect(screen.getByTestId("skills-card-custom:master-item-manager")).toBeInTheDocument();
    await user.click(screen.getByTestId("skills-kind-all"));

    await user.click(screen.getByTestId("skills-card-materials.match-vendor-open"));
    let sheet = screen.getByTestId("skill-sheet");
    expect(within(sheet).getByText(/Runs code, no model/)).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Clone" })).toBeNull();
    await user.click(screen.getByTestId("skill-sheet-close"));

    await user.click(screen.getByTestId("skills-card-custom:master-item-manager-open"));
    sheet = screen.getByTestId("skill-sheet");
    expect(within(sheet).getByTestId("skills-card-custom:master-item-manager-edit")).toBeVisible();
  });

  it("opens the Library's Semantic match (vendor) with Edit and saves a new version in the same shape", async () => {
    window.localStorage.removeItem("mezonas.skills.view");
    const saved: unknown[] = [];
    const { user } = renderAt("/ops/library/skills", {
      "GET /api/ops/skills": () => ({ skills: SKILLS, tools: TOOLS, connectors: [] }),
      [`GET /api/ops/skills/${COPY_ID}`]: () => ({
        skill: COPY,
        versions: [COPY_VERSION],
        usedBy: [],
      }),
      "GET /api/ops/tests": () => ({ cases: [], runs: [], requireTests: false }),
      "GET /api/ops/templates": () => ({ templates: [] }),
      "GET /api/ops/models": () => ({
        models: [
          { id: "claude-haiku-5-5", label: "Haiku", inputPerMtok: "1", outputPerMtok: "5" },
          { id: "claude-sonnet-5-5", label: "Sonnet", inputPerMtok: "3", outputPerMtok: "15" },
        ],
      }),
      [`POST /api/ops/skills/${COPY_ID}/versions`]: ({ init }) => {
        saved.push(JSON.parse(String(init.body)));
        return { version: { ...COPY_VERSION, id: COPY_V1.replace(/d1$/, "d2"), version: 2 } };
      },
    });
    await user.click(await screen.findByTestId("skills-card-custom:semantic-match-vendor-open"));
    await user.click(screen.getByTestId("skills-card-custom:semantic-match-vendor-edit"));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(`/ops/skills/${COPY_ID}`),
    );
    // The editor: AI, its instructions and model, and the vendor catalog it reads, ticked.
    expect(await screen.findByTestId("skill-page-kind")).toHaveTextContent("AI");
    expect(screen.getByTestId("skill-tools-line")).toHaveTextContent(
      "One vendor's catalog: every item, last price, pack size",
    );
    expect(screen.getByTestId("skill-instructions-input")).toHaveValue(INSTRUCTIONS);
    expect(screen.getByTestId("skill-model-select")).toHaveValue("claude-haiku-5-5");
    const read = screen.getByTestId("skill-tool-materials.vendor_items.list");
    expect(read).toBeChecked();
    // A tool that writes is never offered to an AI skill.
    expect(screen.queryByTestId("skill-tool-materials.vendor_items.register")).toBeNull();

    // The operator edits the instructions and saves a draft: the reads and the nested answer stay.
    const box = screen.getByTestId("skill-instructions-input");
    await user.type(box, " A grade differs: never matched.");
    await user.click(screen.getByTestId("skill-save"));
    await waitFor(() => expect(saved).toHaveLength(1));
    const body = saved[0] as { definition: Record<string, unknown>; parentVersionId: string };
    expect(body.parentVersionId).toBe(COPY_V1);
    expect(body.definition).toMatchObject({
      id: "custom:semantic-match-vendor",
      mode: "task",
      model: { id: "claude-haiku-5-5" },
      instructions: `${INSTRUCTIONS} A grade differs: never matched.`,
      reads: ["materials.vendor_items.list"],
      tools: [],
      requiresPacks: ["materials"],
    });
    expect(body.definition.output).toEqual(COPY_DEFINITION.output);
    expect(body.definition.input).toEqual(COPY_DEFINITION.input);
  });

  it("drops a read the operator unticks", async () => {
    const saved: unknown[] = [];
    const { user } = renderAt(`/ops/skills/${COPY_ID}`, {
      "GET /api/ops/skills": () => ({ skills: SKILLS, tools: TOOLS, connectors: [] }),
      [`GET /api/ops/skills/${COPY_ID}`]: () => ({
        skill: COPY,
        versions: [COPY_VERSION],
        usedBy: [],
      }),
      "GET /api/ops/tests": () => ({ cases: [], runs: [], requireTests: false }),
      "GET /api/ops/templates": () => ({ templates: [] }),
      "GET /api/ops/models": () => ({ models: [] }),
      [`POST /api/ops/skills/${COPY_ID}/versions`]: ({ init }) => {
        saved.push(JSON.parse(String(init.body)));
        return { version: { ...COPY_VERSION, version: 2 } };
      },
    });
    const read = await screen.findByTestId("skill-tool-materials.vendor_items.list");
    await user.click(read);
    expect(read).not.toBeChecked();
    await user.click(screen.getByTestId("skill-save"));
    await waitFor(() => expect(saved).toHaveLength(1));
    const def = (saved[0] as { definition: Record<string, unknown> }).definition;
    expect(def.reads).toBeUndefined();
    expect(def.tools).toEqual([]);
  });
});
