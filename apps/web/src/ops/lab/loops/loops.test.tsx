// The Loop designer (docs/step-model-plan.md §8): a Loop is written in the Agent lab and saved as
// a skill that only reads. Only the catalog's Gets can be picked; its test shows every turn; it is
// published only when its whole test set passes; a skill page of a Loop opens here.
import { SkillDefinition, type ToolSpec } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../../test/fixtures";
import { formFromLoop, loopDefinition, loopProblems, readGroups, validateLoop } from "./loop-form";

const SKILL_ID = "00000000-0000-4000-8000-00000000f101";
const VERSION_ID = "00000000-0000-4000-8000-00000000f201";
const RUN_ID = "00000000-0000-4000-8000-00000000f301";
const CASE_ID = "00000000-0000-4000-8000-00000000f401";

const spec = (id: string, extra: Partial<ToolSpec> = {}): ToolSpec => ({
  id,
  description: `Does ${id}`,
  input: { type: "object" },
  output: { type: "object" },
  sideEffect: "none",
  verb: "read",
  source: "platform",
  ...extra,
});
const TOOLS: ToolSpec[] = [
  spec("bookkeeping.reconcile.open", { source: "bookkeeping", area: "bookkeeping" }),
  spec("testkit.record.query", { source: "testkit" }),
  spec("testkit.record.update", {
    source: "testkit",
    sideEffect: "external",
    verb: "update",
    connector: "testkit",
  }),
  spec("bookkeeping.reconcile.propose", {
    source: "bookkeeping",
    area: "bookkeeping",
    sideEffect: "internal",
    verb: "create",
  }),
  // The engine's own tools are never offered.
  spec("inbox.create", { sideEffect: "internal", verb: "create" }),
];
const CONNECTORS = [{ id: "testkit", name: "Testkit" }];

const DEFINITION = {
  schemaVersion: 1,
  id: "custom:find-why",
  name: "Find why",
  description: "Looks a record up and says why it is off.",
  category: "data",
  mode: "agent",
  instructions: "Look the record up.",
  tools: [],
  reads: ["testkit.record.query"],
  loop: { goal: "Say why the record is off.", maxTurns: 6, atLimit: "hand_back" },
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  output: { type: "object", properties: { why: { type: "string" } }, required: ["why"] },
  settings: [],
  requiresConnectors: ["testkit"],
  requiresPacks: [],
  producesAlerts: false,
};

const ITEM = {
  id: SKILL_ID,
  ref: "custom:find-why",
  name: "Find why",
  description: "Looks a record up and says why it is off.",
  category: "data",
  mode: "agent",
  source: "shared",
  clientId: null,
  clientName: null,
  status: "active",
  liveVersion: null,
  latestVersion: 1,
  latestStatus: "draft",
  inputs: ["id"],
  outputs: ["why"],
  tools: [],
  connectors: ["testkit"],
  usedBy: 0,
  usedByNames: [],
};
const VERSION = {
  id: VERSION_ID,
  version: 1,
  status: "draft",
  definition: DEFINITION,
  changeNote: "Created",
  authorId: null,
  parentVersionId: null,
  createdAt: "2026-11-25T00:00:00.000Z",
};
const LIBRARY = { skills: [ITEM], tools: TOOLS, connectors: CONNECTORS };
const RUN = {
  id: RUN_ID,
  clientId: null,
  targetKind: "skill",
  targetId: SKILL_ID,
  versionId: VERSION_ID,
  version: 1,
  status: "done",
  total: 1,
  passed: 1,
  failed: 0,
  metrics: null,
  costUsd: "0.01",
  startedBy: null,
  createdAt: "2026-11-25T00:00:00.000Z",
  finishedAt: "2026-11-25T00:01:00.000Z",
};
const DETAIL = { skill: ITEM, versions: [VERSION], usedBy: [] };

const TURNS = [
  {
    n: 1,
    said: "Look r1 up first.",
    finished: false,
    calls: [
      {
        tool: "testkit.record.query",
        status: "succeeded",
        reason: null,
        input: { ids: ["r1"] },
        output: { records: [{ id: "r1", duplicateOf: "r0" }] },
      },
    ],
  },
  {
    n: 2,
    said: null,
    finished: false,
    calls: [
      {
        tool: "testkit.record.update",
        status: "refused",
        reason: "not an action this Loop may use",
        input: { id: "r1" },
      },
    ],
  },
  { n: 3, said: "That is enough.", finished: true, calls: [] },
];

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

describe("the Loop form", () => {
  it("offers the catalog's Gets only, grouped under their connector or area", () => {
    const groups = readGroups(TOOLS, CONNECTORS);
    expect(groups.map((g) => [g.name, g.actions.map((a) => a.id)])).toEqual([
      ["Testkit", ["testkit.record.query"]],
      ["Bookkeeping", ["bookkeeping.reconcile.open"]],
    ]);
  });

  it("builds a definition the server accepts, and flags what it would refuse", () => {
    const form = formFromLoop(DEFINITION as unknown as SkillDefinition);
    expect(validateLoop(form)).toEqual({});
    const def = loopDefinition(form);
    expect(SkillDefinition.safeParse(def).success).toBe(true);
    expect(def).toMatchObject({
      mode: "agent",
      tools: [],
      reads: ["testkit.record.query"],
      loop: { goal: "Say why the record is off.", maxTurns: 6, atLimit: "hand_back" },
    });
    expect(loopProblems(form, TOOLS)).toEqual([]);
    expect(loopProblems({ ...form, reads: ["testkit.record.update"] }, TOOLS).join(" ")).toContain(
      "A Loop only reads",
    );
    expect(validateLoop({ ...form, reads: [], goal: " " })).toMatchObject({
      reads: expect.any(String),
      goal: expect.any(String),
    });
  });

  it("keeps Confer and Review on the definition only when they are set", () => {
    const form = formFromLoop(DEFINITION as unknown as SkillDefinition);
    expect(loopDefinition(form).loop).not.toHaveProperty("confer");
    const set = loopDefinition({ ...form, conferFocus: "Is the cause right?", review: "always" });
    expect(set.loop).toMatchObject({ confer: { focus: "Is the cause right?" }, review: "always" });
  });
});

describe("the Loop designer", () => {
  it("writes a new Loop and saves it as a draft, with Gets only to pick from", async () => {
    let saved: unknown;
    const { user } = renderAt("/ops/lab/loops/new", {
      "GET /api/ops/skills": () => LIBRARY,
      "POST /api/ops/skills": ({ init }) => {
        saved = JSON.parse(String(init.body));
        return { skill: ITEM, version: VERSION };
      },
      [`GET /api/ops/skills/${SKILL_ID}`]: () => DETAIL,
      "GET /api/ops/tests": () => ({ cases: [], runs: [], requireTests: true }),
    });
    const reads = await screen.findByTestId("loop-reads", {}, { timeout: 10_000 });
    expect(within(reads).getByTestId("loop-read-testkit.record.query")).toBeInTheDocument();
    expect(within(reads).getByTestId("loop-read-bookkeeping.reconcile.open")).toBeInTheDocument();
    // A change, a save and the engine's own tool are not offered.
    expect(within(reads).queryByTestId("loop-read-testkit.record.update")).toBeNull();
    expect(within(reads).queryByTestId("loop-read-bookkeeping.reconcile.propose")).toBeNull();
    expect(within(reads).queryByTestId("loop-read-inbox.create")).toBeNull();

    // Saving too early says what is missing.
    await user.click(screen.getByTestId("loop-create"));
    expect(saved).toBeUndefined();
    expect(await screen.findByText("Say what 'done' means for this Loop.")).toBeInTheDocument();

    await user.type(screen.getByTestId("loop-name"), "Find why");
    await user.type(screen.getByTestId("loop-description"), "Says why a record is off.");
    await user.type(screen.getByTestId("loop-goal"), "Say why the record is off.");
    await user.click(screen.getByTestId("skill-input-add"));
    await user.type(screen.getByTestId("skill-input-0-key"), "id");
    await user.click(screen.getByTestId("skill-output-add"));
    await user.type(screen.getByTestId("skill-output-0-key"), "why");
    await user.click(screen.getByTestId("loop-read-testkit.record.query"));
    await user.click(screen.getByTestId("loop-create"));

    await waitFor(() => expect(saved).toBeDefined());
    expect(saved).toMatchObject({
      definition: {
        id: "custom:find-why",
        mode: "agent",
        tools: [],
        reads: ["testkit.record.query"],
        loop: { goal: "Say why the record is off.", maxTurns: 10, atLimit: "stop" },
      },
    });
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        `/ops/lab/loops/${SKILL_ID}?tab=test`,
      ),
    );
  });

  it("opens a Loop from its skill page", async () => {
    renderAt(`/ops/skills/${SKILL_ID}`, {
      [`GET /api/ops/skills/${SKILL_ID}`]: () => DETAIL,
      "GET /api/ops/skills": () => LIBRARY,
      "GET /api/ops/tests": () => ({ cases: [], runs: [], requireTests: true }),
    });
    expect(await screen.findByTestId("loop-page", {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(screen.getByTestId("loop-page-kind")).toHaveTextContent("Loop");
    expect(screen.getByTestId("location")).toHaveTextContent(`/ops/lab/loops/${SKILL_ID}`);
  });

  it("tries the saved version and shows every turn: the call, what came back, what it decided", async () => {
    let body: unknown;
    const { user } = renderAt(`/ops/lab/loops/${SKILL_ID}?tab=test`, {
      [`GET /api/ops/skills/${SKILL_ID}`]: () => DETAIL,
      "GET /api/ops/skills": () => LIBRARY,
      "GET /api/ops/tests": () => ({ cases: [], runs: [], requireTests: true }),
      [`POST /api/ops/skills/${SKILL_ID}/try-loop`]: ({ init }) => {
        body = JSON.parse(String(init.body));
        return {
          status: "succeeded",
          output: { why: "duplicate of r0" },
          error: null,
          costUsd: "0.012",
          modelCalls: 3,
          turns: TURNS,
        };
      },
    });
    await user.clear(await screen.findByTestId("loop-try-input", {}, { timeout: 10_000 }));
    await user.click(screen.getByTestId("loop-try-input"));
    await user.paste('{"id":"r1"}');
    await user.click(screen.getByTestId("loop-try-run"));
    const turns = await screen.findByTestId("loop-try-turns");
    expect(body).toMatchObject({ versionId: VERSION_ID, input: { id: "r1" }, fixtures: [] });
    expect(within(turns).getByTestId("loop-turn-1-said")).toHaveTextContent("Look r1 up first.");
    expect(within(turns).getAllByTestId("loop-call")).toHaveLength(2);
    expect(turns).toHaveTextContent("duplicateOf");
    // The write it asked for is shown refused.
    expect(turns).toHaveTextContent("Refused");
    expect(turns).toHaveTextContent("not an action this Loop may use");
    expect(within(turns).getByTestId("loop-turn-3")).toHaveTextContent("It gave its answer");
    expect(screen.getByTestId("loop-try-output")).toHaveTextContent("duplicate of r0");
  });

  it("holds the gate: no run without cases, the publish refusal is shown, and there is no switch", async () => {
    const { user } = renderAt(`/ops/lab/loops/${SKILL_ID}?tab=test`, {
      [`GET /api/ops/skills/${SKILL_ID}`]: () => DETAIL,
      "GET /api/ops/skills": () => LIBRARY,
      "GET /api/ops/tests": () => ({ cases: [], runs: [], requireTests: true }),
      [`POST /api/ops/skills/${SKILL_ID}/versions/${VERSION_ID}/publish`]: () =>
        new Reply(422, {
          error: {
            code: "tests_failing",
            message: "a Loop needs a test set: add at least one case",
          },
        }),
    });
    expect(await screen.findByTestId("loop-gate", {}, { timeout: 10_000 })).toHaveTextContent(
      "can't be turned off",
    );
    expect(screen.getByTestId("loop-run-tests")).toBeDisabled();
    // Unlike a skill's tests there is no "publishing needs the tests" switch.
    expect(screen.queryByTestId("skill-require-tests")).toBeNull();
    await user.click(screen.getByTestId("loop-publish-latest"));
    expect(await screen.findByTestId("loop-publish-error")).toHaveTextContent(
      "a Loop needs a test set",
    );
  });

  it("lists the test set with each case's turns", async () => {
    const { user } = renderAt(`/ops/lab/loops/${SKILL_ID}?tab=test`, {
      [`GET /api/ops/skills/${SKILL_ID}`]: () => DETAIL,
      "GET /api/ops/skills": () => LIBRARY,
      "GET /api/ops/tests": () => ({
        cases: [
          {
            id: CASE_ID,
            clientId: null,
            clientName: null,
            targetKind: "skill",
            targetId: SKILL_ID,
            name: "r1 is a duplicate",
            input: { id: "r1" },
            fixtures: [],
            expected: { why: "duplicate of r0" },
            matcher: { kind: "subset", tolerances: {} },
            required: true,
            source: "manual",
            sourceRef: null,
            createdBy: null,
            createdAt: "2026-11-25T00:00:00.000Z",
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
            id: "r",
            testCaseId: CASE_ID,
            name: "r1 is a duplicate",
            required: true,
            status: "pass",
            got: { why: "duplicate of r0" },
            diff: { fields: [], calls: [], turns: TURNS },
            costUsd: "0.01",
            runId: null,
            createdAt: "2026-11-25T00:00:30.000Z",
          },
        ],
      }),
    });
    const row = await screen.findByTestId(`loop-case-${CASE_ID}`, {}, { timeout: 10_000 });
    expect(await within(row).findByText("Pass")).toBeInTheDocument();
    expect(screen.getByTestId("loop-gate")).toHaveTextContent("can be published");
    await user.click(within(row).getByTestId(`loop-case-turns-${CASE_ID}`));
    expect(await within(row).findByTestId(`loop-case-${CASE_ID}-turns`)).toHaveTextContent(
      "Look r1 up first.",
    );
  });
});
