// O4 Skills and automations, O8 New skill, the skill and automation pages: the library shows
// skills as cards or a list, and automations in their own tab with their step chain and
// clean-run rate; a skill is made in a Builder conversation (or by hand) and saved as a draft;
// its page runs tests, publishes, and asks why before tests stop being required; an automation's
// page publishes its draft.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const SKILL_ID = "00000000-0000-4000-8000-00000000a101";
const AUTO_ID = "00000000-0000-4000-8000-00000000a201";
const SESSION_ID = "00000000-0000-4000-8000-00000000a301";
const CASE_ID = "00000000-0000-4000-8000-00000000a401";
const RUN_ID = "00000000-0000-4000-8000-00000000a501";
const RUN = {
  id: RUN_ID,
  clientId: null,
  targetKind: "skill",
  targetId: "00000000-0000-4000-8000-00000000a101",
  versionId: "00000000-0000-4000-8000-00000000b001",
  version: 1,
  status: "done",
  total: 8,
  passed: 7,
  failed: 1,
  metrics: null,
  costUsd: "0.10",
  startedBy: null,
  createdAt: "2026-11-05T00:00:00.000Z",
  finishedAt: "2026-11-05T00:01:00.000Z",
};

const DEFINITION = {
  schemaVersion: 1,
  id: "custom:match-card-charge",
  name: "Match card charge",
  description: "Pairs a card charge with its receipt.",
  category: "data",
  mode: "agent",
  instructions: "Rules first, model second.",
  tools: [],
  input: {
    type: "object",
    properties: {
      amount: { type: "number" },
      receipts: { type: "array", items: { type: "string" } },
    },
  },
  output: {
    type: "object",
    properties: { result: { type: "string", enum: ["match", "none", "ask"] } },
  },
  settings: [
    {
      key: "tip_tolerance",
      label: "Tip tolerance",
      type: "number",
      default: 0.2,
      clientSpecific: false,
    },
  ],
  requiresConnectors: [],
  requiresPacks: [],
  producesAlerts: false,
};

const ITEM = {
  id: SKILL_ID,
  ref: "custom:match-card-charge",
  name: "Match card charge",
  description: "Pairs a card charge with its receipt.",
  category: "data",
  mode: "agent",
  source: "shared",
  clientId: null,
  clientName: null,
  status: "active",
  liveVersion: null,
  latestVersion: 1,
  latestStatus: "draft",
  inputs: ["amount", "receipts"],
  outputs: ["result"],
  tools: [],
  connectors: [],
  usedBy: 0,
};

const BUILTIN = {
  ...ITEM,
  id: "docs.extract",
  ref: "docs.extract",
  name: "Extract invoice",
  description: "Reads a vendor invoice into header, lines and totals.",
  category: "documents",
  source: "builtin",
  liveVersion: 5,
  latestVersion: 5,
  latestStatus: "live",
  inputs: ["document"],
  outputs: ["invoice"],
  usedBy: 12,
  usedByNames: ["Bill clerk · Demo client", "Material costs · Harbor Millwork"],
};

/** A connector read: a tool-mode built-in, code, so it has no Clone. */
const CODE = {
  ...BUILTIN,
  id: "testkit.record.query",
  ref: "testkit.record.query",
  name: "Look up records",
  category: "testkit",
  mode: "tool",
  usedBy: 0,
  usedByNames: [],
};

const LIBRARY = { skills: [ITEM, BUILTIN, CODE], tools: [], connectors: [] };

const VERSION = {
  id: "00000000-0000-4000-8000-00000000b001",
  version: 1,
  status: "draft",
  definition: DEFINITION,
  changeNote: "Created",
  authorId: null,
  parentVersionId: null,
  createdAt: "2026-11-04T00:00:00.000Z",
};

const AUTOMATION = {
  id: AUTO_ID,
  slug: "polite-follow-up",
  name: "Polite follow-up",
  description: "Drafts, gets a signature, sends.",
  source: "shared",
  clientId: null,
  clientName: null,
  status: "active",
  liveVersion: 2,
  latestVersion: 3,
  latestStatus: "draft",
  inputs: ["person"],
  outputs: ["sent"],
  requires: { skills: ["reach.draft"], tools: [], connectors: [] },
  usedBy: 2,
  health: { uses: 50, clean: 49, cleanRunRate: 0.98 },
};

const AUTO_DEF = (version: number) => ({
  schemaVersion: 1,
  slug: "polite-follow-up",
  name: "Polite follow-up",
  description: "",
  input: { type: "object", properties: { person: { type: "string" } } },
  output: {},
  steps: [
    { id: "draft", kind: "skill", name: "Draft in owner's voice", skill: "reach.draft", input: {} },
    {
      id: "sign",
      kind: "person",
      name: "Client signs",
      mode: "approve",
      assignee: "client_admin",
      title: "Sign the message",
      payload: {},
      timeout: "2 days",
      channel: "inbox",
      onReject: "stop",
      onTimeout: "stop",
    },
  ],
  requires: { skills: ["reach.draft"], tools: [], connectors: [] },
  version,
});

const AUTO_VERSIONS = [
  {
    id: "00000000-0000-4000-8000-00000000c003",
    version: 3,
    status: "draft",
    definition: AUTO_DEF(3),
    changeNote: "Wait longer",
    authorId: null,
    parentVersionId: null,
    createdAt: "2026-11-05T00:00:00.000Z",
  },
  {
    id: "00000000-0000-4000-8000-00000000c002",
    version: 2,
    status: "live",
    definition: AUTO_DEF(2),
    changeNote: null,
    authorId: null,
    parentVersionId: null,
    createdAt: "2026-11-01T00:00:00.000Z",
  },
];

const BUILDER_SESSION = (bundle: unknown, status = "open") => ({
  id: SESSION_ID,
  kind: "skill",
  clientId: null,
  clientName: null,
  agentId: null,
  skillId: null,
  baseVersionId: null,
  status,
  bundle,
  errors: [],
  closest: [],
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
});

const TURN = (
  seq: number,
  role: "operator" | "builder",
  text: string,
  changes: unknown[] = [],
) => ({
  id: `00000000-0000-4000-8000-0000000d000${seq}`,
  seq,
  role,
  text,
  command: null,
  changes,
  questions: [],
  gaps: [],
  notes: [],
  errors: [],
  savedVersionId: null,
  costUsd: "0",
  undoneAt: null,
  createdAt: "2026-11-06T00:00:00.000Z",
});

const DRAFT = {
  definition: DEFINITION,
  cases: [
    {
      key: "k1",
      name: "Hafele America",
      input: { amount: 412.5 },
      expected: { result: "match" },
      matcher: { kind: "subset", tolerances: {} },
      required: true,
    },
  ],
};

function Probe() {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
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

describe("skills and automations library", () => {
  it("shows skills as cards or a list, and automations in their own tab", async () => {
    window.localStorage.removeItem("mezonas.skills.view");
    const { user } = renderAt("/ops/skills", {
      "GET /api/ops/skills": () => LIBRARY,
      "GET /api/ops/automations": () => ({ automations: [AUTOMATION] }),
      [`GET /api/ops/automations/${AUTO_ID}`]: () => ({
        automation: AUTOMATION,
        versions: AUTO_VERSIONS,
        usedBy: [],
      }),
    });
    // Skills is the first tab; automations wait in theirs.
    const tabs = await screen.findByTestId("skills-tabs");
    expect(await within(tabs).findByRole("link", { name: /^Skills\s*3$/ })).toHaveClass(
      "border-slate",
    );
    expect(screen.queryByTestId("automations")).toBeNull();

    // A compact card: category, name, what it does, and its numbers; the rest is in its sheet.
    const card = await screen.findByTestId("skills-card-custom:match-card-charge");
    expect(within(card).getByText("Draft")).toBeInTheDocument();
    expect(within(card).queryByText("amount, receipts")).toBeNull();
    const builtin = screen.getByTestId("skills-card-docs.extract");
    // Client agents only, as the API counts them, named on hover.
    const usedBy = within(builtin).getByTestId("skills-card-docs.extract-used-by");
    expect(usedBy).toHaveTextContent("Agents12");
    expect(usedBy).toHaveAttribute(
      "title",
      "Bill clerk · Demo client\nMaterial costs · Harbor Millwork",
    );
    expect(within(builtin).queryByRole("link")).toBeNull();

    // Opening a card shows the whole skill in a side sheet; Escape closes it.
    await user.click(within(card).getByTestId("skills-card-custom:match-card-charge-open"));
    const sheet = screen.getByRole("dialog", { name: "Match card charge" });
    expect(within(sheet).getByText("amount, receipts")).toBeInTheDocument();
    expect(within(sheet).getByText("No client agents yet.")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();

    // Documents in the filter shows only that category.
    const filter = screen.getByTestId("skills-filter");
    expect(within(filter).getByRole("option", { name: "Documents · 1" })).toBeInTheDocument();
    await user.selectOptions(filter, "documents");
    expect(screen.queryByTestId("skills-card-custom:match-card-charge")).toBeNull();
    await user.selectOptions(filter, "all");

    // The list: a row a skill, with the same numbers; the name opens the same sheet, and the
    // choice is remembered.
    await user.click(screen.getByTestId("skills-view-list"));
    expect(screen.getByTestId("skills-view-list")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByTestId("skills-card-docs.extract")).toBeNull();
    const row = screen.getByTestId("skills-row-docs.extract");
    expect(within(row).getByText("12")).toHaveAttribute(
      "title",
      "Bill clerk · Demo client\nMaterial costs · Harbor Millwork",
    );
    expect(window.localStorage.getItem("mezonas.skills.view")).toBe("list");
    await user.click(screen.getByTestId("skills-row-custom:match-card-charge-open"));
    expect(screen.getByRole("dialog", { name: "Match card charge" })).toBeInTheDocument();
    await user.keyboard("{Escape}");

    // Automations: their own tab, with the step chain and clean rate; no category or view switch.
    await user.click(within(tabs).getByRole("link", { name: /^Automations\s*1$/ }));
    const auto = await screen.findByTestId("automation-row-polite-follow-up");
    expect(within(auto).getByTestId("automation-health-polite-follow-up")).toHaveTextContent(
      "98% clean",
    );
    expect(await within(auto).findByText("Person: Client signs")).toBeInTheDocument();
    expect(within(auto).getByText("Draft in owner's voice")).toBeInTheDocument();
    expect(within(auto).getByText("v2")).toBeInTheDocument();
    expect(screen.queryByTestId("skills-row-docs.extract")).toBeNull();
    expect(screen.queryByTestId("skills-filter")).toBeNull();
    expect(screen.queryByTestId("skills-view")).toBeNull();
    window.localStorage.removeItem("mezonas.skills.view");
  });
});

describe("editing and cloning from the library", () => {
  it("edits an operator skill, clones a built-in into a draft, and offers no clone for code", async () => {
    const copyId = "00000000-0000-4000-8000-00000000c0b1";
    const { api, user } = renderAt("/ops/skills", {
      "GET /api/ops/skills": () => LIBRARY,
      "GET /api/ops/automations": () => ({ automations: [] }),
      "POST /api/ops/skills/docs.extract/clone": () => ({
        skill: { ...ITEM, id: copyId, ref: "custom:docs-extract-copy" },
        version: VERSION,
      }),
    });
    // An operator skill's sheet has Edit (its page) and Clone.
    await user.click(await screen.findByTestId("skills-card-custom:match-card-charge-open"));
    let sheet = screen.getByTestId("skill-sheet");
    expect(within(sheet).getByTestId("skills-card-custom:match-card-charge-edit")).toHaveAttribute(
      "href",
      `/ops/skills/${SKILL_ID}`,
    );
    expect(within(sheet).getByTestId("skills-card-custom:match-card-charge-clone")).toBeVisible();
    await user.click(screen.getByTestId("skill-sheet-close"));

    // A code skill's has neither, and says why.
    await user.click(screen.getByTestId("skills-card-testkit.record.query-open"));
    sheet = screen.getByTestId("skill-sheet");
    expect(within(sheet).getByText(/Runs code, no model/)).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Clone" })).toBeNull();
    expect(within(sheet).queryByRole("link", { name: "Edit" })).toBeNull();
    await user.click(screen.getByTestId("skill-sheet-close"));

    // A built-in's has Clone, which opens the new draft.
    await user.click(screen.getByTestId("skills-card-docs.extract-open"));
    sheet = screen.getByTestId("skill-sheet");
    expect(within(sheet).queryByRole("link", { name: "Edit" })).toBeNull();
    await user.click(within(sheet).getByTestId("skills-card-docs.extract-clone"));
    expect(api.calls).toContain("POST /api/ops/skills/docs.extract/clone");
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(`/ops/skills/${copyId}`),
    );
  });
});

describe("new skill, with the Builder", () => {
  it("starts a skill conversation with the first turn and opens it", async () => {
    const started: unknown[] = [];
    const turns: unknown[] = [];
    const { user } = renderAt("/ops/skills/new", {
      "POST /api/ops/builder/sessions": ({ init }) => {
        started.push(JSON.parse(String(init.body)));
        return { session: BUILDER_SESSION({ definition: null, cases: [] }), turns: [] };
      },
      [`POST /api/ops/builder/sessions/${SESSION_ID}/turns`]: ({ init }) => {
        turns.push(JSON.parse(String(init.body)));
        const t = TURN(2, "builder", "Here's a draft.");
        return { session: BUILDER_SESSION(DRAFT), turns: [t], turn: t };
      },
      [`GET /api/ops/builder/sessions/${SESSION_ID}`]: () => ({
        session: BUILDER_SESSION(DRAFT),
        turns: [
          TURN(1, "operator", "Match a charge to a receipt"),
          TURN(2, "builder", "Here's a draft.", [
            { id: "definition", label: "input, output, 1 setting", undone: false },
          ]),
        ],
      }),
    });
    await user.selectOptions(
      await screen.findByTestId("new-skill-scope"),
      "Only Demo client's agents",
    );
    await user.type(screen.getByTestId("builder-input"), "Match a charge to a receipt");
    await user.click(screen.getByTestId("builder-attach"));
    await user.click(screen.getByTestId("builder-examples"));
    await user.paste('[{"name":"Hafele","input":{"amount":412.5},"expected":{"result":"match"}}]');
    await user.click(screen.getByTestId("builder-send"));

    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/ops/skills/new?session=${SESSION_ID}`,
      ),
    );
    expect(started).toEqual([{ kind: "skill", clientId: OPERATOR_SESSION.tenants[1]?.id }]);
    expect(turns).toEqual([
      {
        text: "Match a charge to a receipt",
        examples: [{ name: "Hafele", input: { amount: 412.5 }, expected: { result: "match" } }],
      },
    ]);
    expect(await screen.findByText("Here's a draft.")).toBeInTheDocument();
    expect(screen.getByTestId("draft-takes-in")).toHaveTextContent("receipts[]");
    expect(screen.getByTestId("draft-gives-back")).toHaveTextContent("match | none | ask");
  });

  it("refuses examples that aren't JSON", async () => {
    const { api, user } = renderAt("/ops/skills/new", {});
    await user.type(await screen.findByTestId("builder-input"), "Match charges");
    await user.click(screen.getByTestId("builder-attach"));
    await user.click(screen.getByTestId("builder-examples"));
    await user.paste("not json");
    await user.click(screen.getByTestId("builder-send"));
    expect(await screen.findByText("The examples aren't valid JSON.")).toBeInTheDocument();
    expect(api.calls).not.toContain("POST /api/ops/builder/sessions");
  });

  it("undoes a change, shows the drafted tests and saves the draft", async () => {
    const undone: unknown[] = [];
    const { user } = renderAt(`/ops/skills/new?session=${SESSION_ID}&tab=tests`, {
      [`GET /api/ops/builder/sessions/${SESSION_ID}`]: () => ({
        session: BUILDER_SESSION(DRAFT),
        turns: [
          TURN(2, "builder", "Added a test.", [
            { id: "case:k1", label: "1 test from your examples", undone: false },
          ]),
        ],
      }),
      [`POST /api/ops/builder/sessions/${SESSION_ID}/undo`]: ({ init }) => {
        undone.push(JSON.parse(String(init.body)));
        const t = TURN(3, "builder", "Undone.");
        return { session: BUILDER_SESSION(DRAFT), turns: [t], turn: t };
      },
      [`POST /api/ops/builder/sessions/${SESSION_ID}/save`]: () => {
        const t = TURN(4, "builder", "Saved.");
        return {
          session: BUILDER_SESSION(DRAFT, "saved"),
          turns: [t],
          turn: t,
          agent: null,
          skill: { id: SKILL_ID, slug: "match-card-charge", ref: "custom:match-card-charge" },
          version: { id: VERSION.id, version: 1 },
          cases: [{ id: CASE_ID, name: "Hafele America", clientId: null }],
          errors: [],
        };
      },
    });
    expect(await screen.findByTestId("draft-tests")).toHaveTextContent("Hafele America");
    await user.click(screen.getByTestId("builder-undo-case:k1"));
    await waitFor(() =>
      expect(undone).toEqual([{ turnId: TURN(2, "builder", "").id, changeId: "case:k1" }]),
    );
    await user.click(screen.getByTestId("new-skill-save"));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(`/ops/skills/${SKILL_ID}?tab=tests`),
    );
  });

  it("still writes a skill by hand", async () => {
    const sent: { definition: Record<string, unknown> }[] = [];
    const { user } = renderAt("/ops/skills/new?by=hand", {
      "GET /api/ops/skills": () => ({
        ...LIBRARY,
        tools: [
          {
            id: "testkit.record.query",
            description: "Find records",
            input: {},
            output: {},
            sideEffect: "none",
            verb: "read",
            source: "testkit",
            connector: "testkit",
          },
        ],
        connectors: [{ id: "testkit", name: "Testkit" }],
      }),
      "POST /api/ops/skills": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { skill: ITEM, version: VERSION };
      },
    });
    await user.type(await screen.findByTestId("skill-name-input"), "Summarize records");
    await user.type(screen.getByTestId("skill-description-input"), "Writes a short summary");
    await user.type(screen.getByTestId("skill-instructions-input"), "Summarize.");
    await user.click(screen.getByTestId("skill-tool-testkit.record.query"));
    await user.click(screen.getByTestId("skill-create"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.definition).toMatchObject({
      id: "custom:summarize-records",
      mode: "agent",
      tools: ["testkit.record.query"],
    });
  });
});

describe("a skill's page", () => {
  const routes = (extra: Parameters<typeof fakeApi>[0] = {}) => ({
    "GET /api/ops/skills": () => LIBRARY,
    [`GET /api/ops/skills/${SKILL_ID}`]: () => ({ skill: ITEM, versions: [VERSION], usedBy: [] }),
    "GET /api/ops/tests": () => ({
      cases: [
        {
          id: CASE_ID,
          clientId: null,
          clientName: null,
          targetKind: "skill",
          targetId: SKILL_ID,
          name: "SQ *BLUE DOOR",
          input: {},
          fixtures: [],
          expected: { result: "match" },
          matcher: { kind: "subset", tolerances: {} },
          required: true,
          source: "builder",
          sourceRef: null,
          createdBy: null,
          createdAt: "2026-11-05T00:00:00.000Z",
          archivedAt: null,
        },
      ],
      runs: [RUN],
      requireTests: true,
    }),
    [`GET /api/ops/tests/runs/${RUN_ID}`]: () => ({
      suiteRun: RUN,
      results: [
        {
          id: "00000000-0000-4000-8000-00000000a601",
          testCaseId: CASE_ID,
          name: "SQ *BLUE DOOR",
          required: true,
          status: "fail",
          got: { result: "none" },
          diff: null,
          costUsd: "0.01",
          runId: null,
          createdAt: "2026-11-05T00:01:00.000Z",
        },
      ],
    }),
    "GET /api/ops/templates": () => ({ templates: [] }),
    ...extra,
  });

  it("publishes the draft from the header", async () => {
    const published: string[] = [];
    const { user } = renderAt(
      `/ops/skills/${SKILL_ID}`,
      routes({
        [`POST /api/ops/skills/${SKILL_ID}/versions/${VERSION.id}/publish`]: ({ url }) => {
          published.push(url.pathname);
          return { version: { ...VERSION, status: "live" } };
        },
      }),
    );
    expect(await screen.findByTestId("skill-takes-in")).toHaveTextContent("amount");
    expect(screen.getByTestId("skill-tools-line")).toHaveTextContent("Tools it may use: none");
    await user.click(screen.getByTestId("skill-publish-latest"));
    expect(await screen.findByTestId("skill-message")).toHaveTextContent("v1 is live.");
    expect(published).toHaveLength(1);
  });

  it("runs the tests, shows what each got, and asks why before they stop being required", async () => {
    const ran: unknown[] = [];
    const required: unknown[] = [];
    const { user } = renderAt(
      `/ops/skills/${SKILL_ID}?tab=tests`,
      routes({
        "POST /api/ops/tests/run": ({ init }) => {
          ran.push(JSON.parse(String(init.body)));
          return { suiteRun: RUN };
        },
        [`PUT /api/ops/skills/${SKILL_ID}/require-tests`]: ({ init }) => {
          required.push(JSON.parse(String(init.body)));
          return { skillId: SKILL_ID, requireTests: false };
        },
      }),
    );
    const row = await screen.findByTestId(`skill-test-${CASE_ID}`);
    expect(await within(row).findByText("Fails")).toBeInTheDocument();
    expect(within(row).getByText('{"result":"none"}')).toBeInTheDocument();
    expect(screen.getByTestId("skill-tests-summary")).toHaveTextContent("7 pass · 1 fail");

    await user.click(screen.getByTestId("skill-run-tests"));
    await waitFor(() =>
      expect(ran).toEqual([{ targetKind: "skill", targetId: SKILL_ID, versionId: VERSION.id }]),
    );
    expect(await screen.findByTestId("skill-message")).toHaveTextContent("7 of 8 pass");

    await user.click(screen.getByTestId("skill-require-tests-switch"));
    expect(screen.getByTestId("skill-require-tests-off")).toBeDisabled();
    await user.type(screen.getByTestId("skill-require-tests-reason"), "Fixtures are being redone");
    await user.click(screen.getByTestId("skill-require-tests-off"));
    await waitFor(() =>
      expect(required).toEqual([{ required: false, reason: "Fixtures are being redone" }]),
    );
  });
});

describe("an automation's page", () => {
  it("shows the live chain and publishes the draft", async () => {
    const published: string[] = [];
    const { user } = renderAt(`/ops/skills/automations/${AUTO_ID}`, {
      [`GET /api/ops/automations/${AUTO_ID}`]: () => ({
        automation: AUTOMATION,
        versions: AUTO_VERSIONS,
        usedBy: [],
      }),
      [`POST /api/ops/automations/${AUTO_ID}/versions/${AUTO_VERSIONS[0]?.id}/publish`]: ({
        url,
      }) => {
        published.push(url.pathname);
        return { version: { ...AUTO_VERSIONS[0], status: "live" } };
      },
    });
    expect(await screen.findByTestId("automation-steps")).toHaveTextContent(
      "Draft in owner's voice",
    );
    expect(screen.getByTestId("automation-health")).toHaveTextContent("98% clean · 50 uses");
    await user.click(screen.getByTestId("automation-publish-latest"));
    expect(await screen.findByTestId("automation-message")).toHaveTextContent("v3 is live.");
    expect(published).toHaveLength(1);
  });
});
