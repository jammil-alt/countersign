// O4 Skills and automations, O8 New skill, the skill and automation pages: the library shows
// automations with their step chain and clean-run rate and skills as cards; a skill is made in a
// Builder conversation (or by hand) and saved as a draft; its page runs tests, publishes, and
// asks why before tests stop being required; an automation's page publishes its draft.
import {
  evaluateSkillRules,
  resolveSkillParameters,
  SkillDefinition,
  skillKind,
} from "@countersign/core";
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

const LIBRARY = { skills: [ITEM, BUILTIN], tools: [], connectors: [] };

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
  // R8: the skills are the Library's Skills bank; automations are processes, in the Processes bank.
  it("shows automations with their chain and clean rate in the Processes bank", async () => {
    renderAt("/ops/library/processes", {
      "GET /api/ops/library/processes": () => ({ processes: [] }),
      "GET /api/ops/automations": () => ({ automations: [AUTOMATION] }),
      [`GET /api/ops/automations/${AUTO_ID}`]: () => ({
        automation: AUTOMATION,
        versions: AUTO_VERSIONS,
        usedBy: [],
      }),
    });
    const row = await screen.findByTestId("automation-row-polite-follow-up");
    expect(within(row).getByTestId("automation-health-polite-follow-up")).toHaveTextContent(
      "98% clean",
    );
    expect(await within(row).findByText("Person: Client signs")).toBeInTheDocument();
    expect(within(row).getByText("Draft in owner's voice")).toBeInTheDocument();
    expect(within(row).getByText("v2")).toBeInTheDocument();
    expect(screen.getByTestId("automations")).toHaveTextContent("Used inside other processes");
  });

  it("shows skills as cards, by category, from /ops/skills too", async () => {
    const { api, user } = renderAt("/ops/skills", {
      "GET /api/ops/skills": () => LIBRARY,
    });
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent("/ops/library/skills"),
    );
    const card = await screen.findByTestId("skills-card-custom:match-card-charge");
    expect(within(card).getByText("amount, receipts")).toBeInTheDocument();
    expect(within(card).getByText("Draft")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Match card charge" })).toHaveAttribute(
      "href",
      `/ops/skills/${SKILL_ID}`,
    );
    const builtin = screen.getByTestId("skills-card-docs.extract");
    // Client agents only, as the API counts them.
    expect(within(builtin).getByText("Used by 12 client agents")).toBeInTheDocument();
    // Named on hover.
    expect(within(builtin).getByTestId("skills-card-docs.extract-used-by")).toHaveAttribute(
      "title",
      "Bill clerk · Demo client\nMaterial costs · Harbor Millwork",
    );
    expect(within(builtin).queryByRole("link")).toBeNull();
    // In the Library the automations are the Processes bank's: none here, not even asked for.
    expect(screen.queryByTestId("automations")).toBeNull();
    expect(screen.queryByTestId("skills-tab-automations")).toBeNull();
    expect(api.calls).not.toContain("GET /api/ops/automations");

    // The Documents tab shows only that category.
    await user.click(screen.getByTestId("skills-tab-documents"));
    expect(screen.queryByTestId("skills-card-custom:match-card-charge")).toBeNull();
    expect(screen.getByTestId("skills-tab-documents")).toHaveTextContent("Documents · 1");
    expect(screen.getByTestId("skills-card-docs.extract")).toBeInTheDocument();
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
    // Skill model (2026-11-10): written by hand, it is an AI skill on its recommended model.
    expect(sent[0]?.definition).toMatchObject({
      id: "custom:summarize-records",
      mode: "task",
      model: { id: "claude-haiku-5-5" },
      tools: ["testkit.record.query"],
    });
  });
});

// Skill model (2026-11-10): the owner's aging example, built from the screen as a deterministic
// skill: a buckets parameter (0–15 Current, 16–30 Due, 31+ Past due) and one rule row that puts
// the days from the due date to today into the agent's buckets. Core's evaluator runs what it saved.
describe("a deterministic skill, by hand", () => {
  it("builds the aging skill: a buckets parameter and a row that buckets days overdue", async () => {
    const sent: { definition: Record<string, unknown> }[] = [];
    const { user } = renderAt("/ops/skills/new?by=hand", {
      "GET /api/ops/skills": () => ({ ...LIBRARY, tools: [], connectors: [] }),
      "GET /api/ops/models": () => ({ models: [] }),
      "POST /api/ops/skills": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { skill: ITEM, version: VERSION };
      },
    });
    await user.click(await screen.findByTestId("skill-kind-deterministic"));
    // A deterministic skill has no instructions and no tools: its rows are the work.
    expect(screen.queryByTestId("skill-instructions-input")).toBeNull();
    expect(screen.queryByTestId("skill-tools")).toBeNull();
    await user.type(screen.getByTestId("skill-name-input"), "Age receivables");
    await user.type(screen.getByTestId("skill-description-input"), "Buckets an open invoice");
    // In: the due date. Out: the bucket and the days overdue.
    await user.click(screen.getByTestId("skill-input-add"));
    await user.type(screen.getByTestId("skill-input-0-key"), "dueDate");
    await user.clear(screen.getByTestId("skill-output-0-key"));
    await user.type(screen.getByTestId("skill-output-0-key"), "bucket");
    await user.click(screen.getByTestId("skill-output-add"));
    await user.type(screen.getByTestId("skill-output-1-key"), "daysOverdue");
    await user.selectOptions(screen.getByTestId("skill-output-1-type"), "integer");
    // The parameter: the agent's aging buckets, with a default.
    await user.click(screen.getByTestId("skill-parameter-add"));
    await user.type(screen.getByTestId("skill-parameter-0-name"), "aging");
    await user.type(screen.getByTestId("skill-parameter-0-label"), "Aging buckets");
    await user.selectOptions(screen.getByTestId("skill-parameter-0-type"), "buckets");
    const buckets: [string, string, string][] = [
      ["0", "15", "Current"],
      ["16", "30", "Due"],
      ["31", "", "Past due"],
    ];
    for (const [i, [from, to, label]] of buckets.entries()) {
      await user.click(screen.getByTestId("skill-parameter-0-default-add"));
      const fromInput = screen.getByTestId(`skill-parameter-0-default-${i}-from`);
      await user.clear(fromInput);
      await user.type(fromInput, from);
      if (to) await user.type(screen.getByTestId(`skill-parameter-0-default-${i}-to`), to);
      await user.type(screen.getByTestId(`skill-parameter-0-default-${i}-label`), label);
    }
    // One row, always: bucket = the aging bucket of the days from the due date to today.
    await user.click(screen.getByTestId("skill-rule-add"));
    await user.selectOptions(screen.getByTestId("skill-rule-0-output-0-how"), "bucket");
    expect(screen.getByTestId("skill-rule-0-output-0-bucket-value-kind")).toHaveValue("days");
    expect(screen.getByTestId("skill-rule-0-output-0-bucket-by")).toHaveValue("aging");
    // daysOverdue = the same days.
    await user.click(screen.getByTestId("skill-rule-0-output-add"));
    await user.selectOptions(screen.getByTestId("skill-rule-0-output-1-how"), "copy");
    await user.selectOptions(screen.getByTestId("skill-rule-0-output-1-copy-kind"), "days");
    expect(screen.queryByTestId("skill-problems")).toBeNull();
    await user.click(screen.getByTestId("skill-create"));
    await waitFor(() => expect(sent).toHaveLength(1));

    const def = SkillDefinition.parse(sent[0]?.definition);
    expect(def).toMatchObject({ id: "custom:age-receivables", mode: "tool", tools: [] });
    expect(skillKind(def)).toBe("deterministic");
    expect(def.instructions).toBeUndefined();
    expect(def.parameters).toEqual([
      {
        name: "aging",
        label: "Aging buckets",
        type: "buckets",
        default: [
          { from: 0, to: 15, label: "Current" },
          { from: 16, to: 30, label: "Due" },
          { from: 31, label: "Past due" },
        ],
      },
    ]);
    const age = (dueDate: string) =>
      evaluateSkillRules(def.rules ?? [], {
        input: { dueDate },
        parameters: resolveSkillParameters(def),
        today: "2026-11-10",
      })?.output;
    expect(age("2026-11-01")).toEqual({ bucket: "Current", daysOverdue: 9 });
    expect(age("2026-10-20")).toEqual({ bucket: "Due", daysOverdue: 21 });
    expect(age("2026-09-01")).toEqual({ bucket: "Past due", daysOverdue: 70 });
    // An agent's own buckets change the answer, with no new skill.
    const agentBuckets = [
      { from: 0, to: 30, label: "Fine" },
      { from: 31, label: "Late" },
    ];
    expect(
      evaluateSkillRules(def.rules ?? [], {
        input: { dueDate: "2026-10-20" },
        parameters: resolveSkillParameters(def, { agent: { aging: agentBuckets } }),
        today: "2026-11-10",
      })?.output,
    ).toEqual({ bucket: "Fine", daysOverdue: 21 });
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
