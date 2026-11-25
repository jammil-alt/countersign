// An automation in the one-screen builder (F7): it opens on its saved steps between Takes in and
// Gives back, a step is added from the rail, both ends are edited in the side panel, a save posts
// the definition as edited (ids as they were), and Publish makes the saved version live.
import { AutomationDefinition, type BuilderCatalog } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../../test/fixtures";

const AUTO_ID = "00000000-0000-4000-8000-00000000a201";
const CLIENT_ID = "00000000-0000-4000-8000-00000000a001";
const V1 = "00000000-0000-4000-8000-00000000b201";
const V2 = "00000000-0000-4000-8000-00000000b202";
const V3 = "00000000-0000-4000-8000-00000000b203";
const STEPS = `/ops/skills/automations/${AUTO_ID}/steps`;

const skill = (id: string, name: string, input: object, output: object) => ({
  ref: id,
  source: "builtin" as const,
  version: null,
  definition: {
    schemaVersion: 1 as const,
    id,
    name,
    description: `${name}.`,
    category: "documents",
    mode: "agent" as const,
    tools: [],
    input: { type: "object", properties: input },
    output: { type: "object", properties: output },
    settings: [],
    requiresConnectors: [],
    requiresPacks: [],
    producesAlerts: false,
  },
});

const CATALOG = {
  skills: [
    skill(
      "docs.find-support",
      "Find supporting document",
      { billId: { type: "string" } },
      { documentId: { type: "string" } },
    ),
    skill(
      "docs.extract",
      "Read a document",
      { documentId: { type: "string" } },
      { total: { type: "number" } },
    ),
  ],
  tools: [
    {
      id: "testkit.record.update",
      description: "Updates a record",
      input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      output: { type: "object" },
      sideEffect: "external",
      verb: "update",
      source: "testkit",
      connector: "testkit",
    },
  ],
  connectors: [{ id: "testkit", name: "Testkit", icon: null }],
  stepTools: [],
  automations: [],
} as unknown as BuilderCatalog;

const DEFINITION = AutomationDefinition.parse({
  schemaVersion: 2,
  slug: "bill-intake",
  name: "Bill intake",
  description: "Finds a bill's document.",
  input: {
    type: "object",
    properties: { billId: { type: "string", description: "The bill to read" } },
    required: ["billId"],
  },
  output: { documentId: "{{steps.find.output.documentId}}" },
  steps: [
    {
      id: "find",
      name: "Find the document",
      kind: "skill",
      skill: "docs.find-support",
      input: { billId: "{{input.billId}}" },
    },
  ],
  requires: { skills: ["docs.find-support"], tools: [], connectors: [] },
});

const version = (id: string, n: number, status: string, definition: unknown = DEFINITION) => ({
  id,
  version: n,
  status,
  definition,
  changeNote: null,
  authorId: null,
  parentVersionId: null,
  createdAt: "2026-11-20T00:00:00.000Z",
});

const AUTOMATION = {
  id: AUTO_ID,
  slug: "bill-intake",
  name: "Bill intake",
  description: "Finds a bill's document.",
  source: "shared",
  clientId: null,
  clientName: null,
  status: "active",
  liveVersion: 1,
  latestVersion: 2,
  latestStatus: "draft",
  inputs: ["billId"],
  outputs: ["documentId"],
  requires: { skills: ["docs.find-support"], tools: [], connectors: [] },
  usedBy: 0,
  health: { uses: 0, clean: 0, cleanRunRate: null },
};

function Probe() {
  const { pathname } = useLocation();
  return <span data-testid="location">{pathname}</span>;
}

interface Posted {
  definition: typeof DEFINITION;
  parentVersionId?: string;
  changeNote?: string;
}

function open(over: Parameters<typeof fakeApi>[0] = {}, path = STEPS) {
  const saves: Posted[] = [];
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/automations/${AUTO_ID}`]: () => ({
      automation: AUTOMATION,
      versions: [version(V2, 2, "draft"), version(V1, 1, "live")],
      usedBy: [],
    }),
    [`GET /api/ops/automations/${AUTO_ID}/builder-catalog`]: () => CATALOG,
    [`POST /api/ops/automations/${AUTO_ID}/versions`]: ({ init }) => {
      const body = JSON.parse(String(init.body)) as Posted;
      saves.push(body);
      return { version: version(V3, 3, "draft", body.definition), errors: [] };
    },
    [`POST /api/ops/automations/${AUTO_ID}/versions/${V3}/publish`]: () => ({
      version: version(V3, 3, "live", saves.at(-1)?.definition),
    }),
    [`POST /api/ops/automations/${AUTO_ID}/versions/${V2}/publish`]: () => ({
      version: version(V2, 2, "live"),
    }),
    ...over,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <Probe />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, saves, user: userEvent.setup() };
}

const save = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByTestId("flow-bar-save"));
  await screen.findByTestId("flow-auto-notice");
};

describe("an automation in the builder", () => {
  it("opens on its saved steps, between what it takes in and what it gives back", async () => {
    const { api } = open();
    expect(await screen.findByTestId("flow-bar-name")).toHaveValue("Bill intake");
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Draft · v2");
    expect(screen.getByTestId("flow-bar-counts")).toHaveTextContent("1 step");
    expect(screen.getByTestId("flow-bar-settled")).toBeInTheDocument();

    const start = screen.getByTestId("flow-start");
    expect(start).toHaveTextContent("Takes in");
    expect(start).toHaveTextContent("billId · text");
    const end = screen.getByTestId("flow-gives-back");
    expect(end).toHaveTextContent("Gives back");
    expect(end).toHaveTextContent("documentId: Find the document · document id");
    expect(screen.getByTestId("flow-box-find")).toHaveTextContent("Find the document");

    // The same catalog, with no triggers (an automation has none) and no automations inside one.
    expect(screen.getByTestId("flow-rail-skills")).toBeInTheDocument();
    expect(screen.getByTestId("flow-rail-tool-testkit")).toBeInTheDocument();
    expect(screen.getByTestId("flow-rail-logic")).toBeInTheDocument();
    expect(screen.queryByTestId("flow-rail-triggers")).toBeNull();
    expect(screen.queryByTestId("flow-rail-processes")).toBeNull();
    expect(screen.queryByTestId("flow-rail-handoff")).toBeNull();

    // Nothing to save yet; it asks for its own catalog, not an agent's.
    expect(screen.getByTestId("flow-bar-save")).toBeDisabled();
    expect(api.calls).toContain(`GET /api/ops/automations/${AUTO_ID}/builder-catalog`);
    expect(api.calls.some((c) => c.includes("/api/ops/agents/"))).toBe(false);
  });

  it("adds a step from the rail, undoes it, and saves the steps with their ids", async () => {
    const { user, saves } = open();
    await user.click(await screen.findByTestId("flow-rail-item-skill:docs.extract"));
    // The new step is on the chart and open in the side panel, with the inspector's fields.
    expect(screen.getByTestId("flow-bar-counts")).toHaveTextContent("2 steps");
    const panel = screen.getByTestId("flow-panel");
    expect(within(panel).getByTestId("flow-panel-name")).toHaveValue("Read a document");
    expect(within(panel).getByTestId("builder-inspector")).toBeInTheDocument();

    await user.click(screen.getByTestId("flow-bar-undo"));
    expect(screen.getByTestId("flow-bar-counts")).toHaveTextContent("1 step");
    await user.click(screen.getByTestId("flow-bar-redo"));
    expect(screen.getByTestId("flow-bar-counts")).toHaveTextContent("2 steps");

    await save(user);
    expect(saves).toHaveLength(1);
    const posted = saves[0];
    expect(posted?.parentVersionId).toBe(V2);
    expect(posted?.definition.steps.map((s) => s.kind)).toEqual(["skill", "skill"]);
    // The step that was there keeps its id and its input; the new one names its skill.
    expect(posted?.definition.steps[0]).toEqual(DEFINITION.steps[0]);
    expect(posted?.definition.steps[1]).toMatchObject({ skill: "docs.extract" });
    expect(posted?.definition).toMatchObject({ schemaVersion: 2, slug: "bill-intake" });
    expect(screen.getByTestId("flow-auto-notice")).toHaveTextContent("Saved v3 as a draft.");
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Draft · v3");
    expect(screen.getByTestId("flow-bar-save")).toBeDisabled();
  });

  it("puts a step where + was pressed on an arrow", async () => {
    const { user, saves } = open();
    await user.click(await screen.findByTestId("flow-insert-root-0"));
    expect(screen.getByTestId("flow-auto-insert-hint")).toBeInTheDocument();
    await user.click(screen.getByTestId("flow-rail-item-skill:docs.extract"));
    expect(screen.queryByTestId("flow-auto-insert-hint")).toBeNull();
    await save(user);
    expect(saves[0]?.definition.steps.map((s) => s.name)).toEqual([
      "Read a document",
      "Find the document",
    ]);
  });

  it("edits what it takes in, in the side panel, and saves it as the input schema", async () => {
    const { user, saves } = open();
    await user.click(await screen.findByTestId("flow-start"));
    const panel = screen.getByTestId("flow-panel");
    expect(within(panel).getByTestId("flow-panel-title")).toHaveTextContent("Takes in");
    expect(within(panel).getByTestId("flow-in-name-0")).toHaveValue("billId");
    expect(within(panel).getByTestId("flow-in-about-0")).toHaveValue("The bill to read");
    expect(within(panel).getByTestId("flow-in-required-0")).toBeChecked();

    await user.click(within(panel).getByTestId("flow-in-add"));
    // A row with no name yet is said, and not saved.
    expect(within(panel).getByTestId("flow-in-problem-1")).toHaveTextContent(
      "Give this field a name.",
    );
    await user.type(within(panel).getByTestId("flow-in-name-1"), "pages");
    await user.selectOptions(within(panel).getByTestId("flow-in-type-1"), "number");
    await user.click(within(panel).getByTestId("flow-in-required-1"));
    await user.type(within(panel).getByTestId("flow-in-about-1"), "How many to read");
    expect(within(panel).queryByTestId("flow-in-problem-1")).toBeNull();
    // The chart's start box follows: its first field, and how many more.
    expect(screen.getByTestId("flow-start")).toHaveAccessibleName(
      "Takes in: billId · text and 1 more",
    );

    await save(user);
    expect(saves[0]?.definition.input).toEqual({
      type: "object",
      properties: {
        billId: { type: "string", description: "The bill to read" },
        pages: { type: "number", description: "How many to read" },
      },
      required: ["billId"],
    });
    // The steps are as they were.
    expect(saves[0]?.definition.steps).toEqual(DEFINITION.steps);
  });

  it("edits what it gives back, each value picked from the input or a step", async () => {
    const { user, saves } = open();
    await user.click(await screen.findByTestId("flow-gives-back"));
    const panel = screen.getByTestId("flow-panel");
    expect(within(panel).getByTestId("flow-panel-title")).toHaveTextContent("Gives back");
    expect(within(panel).getByTestId("flow-out-name-0")).toHaveValue("documentId");

    await user.click(within(panel).getByTestId("flow-out-add"));
    await user.type(within(panel).getByTestId("flow-out-name-1"), "bill");
    expect(within(panel).getByTestId("flow-out-problem-1")).toHaveTextContent(
      "Pick what it gives back here.",
    );
    // The same picker a step's input has: what it takes in, and its steps' outputs.
    await user.click(within(panel).getByTestId("flow-out-value-1-pick"));
    const paths = within(panel).getByTestId("flow-out-value-1-paths");
    expect(
      within(paths).getByTestId("flow-out-value-1-path-steps.find.output.documentId"),
    ).toBeInTheDocument();
    await user.click(within(paths).getByTestId("flow-out-value-1-path-input.billId"));
    expect(within(panel).queryByTestId("flow-out-problem-1")).toBeNull();
    expect(screen.getByTestId("flow-gives-back")).toHaveTextContent("and 1 more");

    // The first field goes; the chart's end box follows.
    await user.click(within(panel).getByTestId("flow-out-remove-0"));
    expect(screen.getByTestId("flow-gives-back")).toHaveTextContent("bill: Input · bill id");
    await save(user);
    expect(saves[0]?.definition.output).toEqual({ bill: "{{input.billId}}" });
  });

  it("offers a step what the automation takes in", async () => {
    const { user } = open();
    await user.click(await screen.findByTestId("flow-box-find"));
    const panel = screen.getByTestId("flow-panel");
    expect(within(panel).getByTestId("flow-panel-eyebrow")).toHaveTextContent("step 1 of 1");
    const pick = within(panel).getAllByRole("button", {
      name: "Insert a field from an earlier step",
    })[0];
    if (!pick) throw new Error("no picker");
    // Its input already reads the field (the chip); the picker offers it too.
    expect(within(panel).getAllByText("Input · bill id")).toHaveLength(1);
    await user.click(pick);
    expect(within(panel).getAllByText("Input · bill id")).toHaveLength(2);
  });

  it("marks a step that reads a field it no longer takes in, and won't publish it", async () => {
    const { user } = open();
    await user.click(await screen.findByTestId("flow-start"));
    await user.click(screen.getByTestId("flow-in-remove-0"));
    expect(screen.getByTestId("flow-start")).toHaveTextContent("Nothing. Add what it needs");
    expect(screen.getByTestId("flow-bar-issues")).toHaveTextContent("1 issue");
    expect(screen.getByTestId("flow-flag-find")).toBeInTheDocument();
    expect(screen.getByTestId("flow-auto-publish")).toBeDisabled();
    // The pill opens the step it is on.
    await user.click(screen.getByTestId("flow-bar-open"));
    expect(screen.getByTestId("flow-panel")).toHaveAttribute("data-step", "find");
    expect(screen.getByTestId("flow-panel-settle")).toHaveAttribute("data-tone", "issue");
  });

  it("publishes the draft it opened on", async () => {
    const { user, api, saves } = open();
    await user.click(await screen.findByTestId("flow-auto-publish"));
    expect(await screen.findByTestId("flow-auto-notice")).toHaveTextContent(
      "v2 is live. Agents move to it with their own next version.",
    );
    expect(saves).toHaveLength(0);
    expect(api.calls).toContain(`POST /api/ops/automations/${AUTO_ID}/versions/${V2}/publish`);
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Live · v2");
    await waitFor(() => expect(screen.getByTestId("flow-auto-publish")).toBeDisabled());
  });

  it("saves its changes first, then publishes that version", async () => {
    const { user, api, saves } = open();
    const name = await screen.findByTestId("flow-bar-name");
    await user.clear(name);
    await user.type(name, "Bill intake, checked");
    await user.click(screen.getByTestId("flow-auto-publish"));
    expect(await screen.findByTestId("flow-auto-notice")).toHaveTextContent("v3 is live.");
    expect(saves).toHaveLength(1);
    expect(saves[0]?.definition.name).toBe("Bill intake, checked");
    const posts = api.calls.filter((c) => c.startsWith("POST "));
    expect(posts).toEqual([
      `POST /api/ops/automations/${AUTO_ID}/versions`,
      `POST /api/ops/automations/${AUTO_ID}/versions/${V3}/publish`,
    ]);
    expect(screen.getByTestId("flow-bar-version")).toHaveTextContent("Live · v3");
  });

  it("says why when a save is refused, and keeps the changes", async () => {
    const { user } = open({
      [`POST /api/ops/automations/${AUTO_ID}/versions`]: () =>
        new Reply(409, { error: { code: "stale", message: "A newer version was saved." } }),
    });
    await user.click(await screen.findByTestId("flow-rail-item-skill:docs.extract"));
    await user.click(screen.getByTestId("flow-bar-save"));
    expect(await screen.findByTestId("flow-auto-error")).toHaveTextContent(
      "A newer version was saved.",
    );
    expect(screen.getByTestId("flow-bar-counts")).toHaveTextContent("2 steps");
    expect(screen.getByTestId("flow-bar-save")).toBeEnabled();
  });

  it("offers a client's own automation that client's connected tools only", async () => {
    const own = { ...AUTOMATION, source: "client", clientId: CLIENT_ID, clientName: "Acme" };
    const routes = (connections: unknown[]) => ({
      [`GET /api/ops/automations/${AUTO_ID}`]: () => ({
        automation: own,
        versions: [version(V2, 2, "draft")],
        usedBy: [],
      }),
      [`GET /api/ops/clients/${CLIENT_ID}/connections`]: () => ({
        connections,
        offered: [],
        connectors: [],
        usedBy: {},
        sandbox: false,
      }),
    });
    const first = open(routes([]));
    expect(await screen.findByTestId("flow-rail-skills")).toBeInTheDocument();
    expect(screen.queryByTestId("flow-rail-tool-testkit")).toBeNull();
    expect(first.api.calls).toContain(`GET /api/ops/clients/${CLIENT_ID}/connections`);
  });

  it("doesn't open an automation saved in the older step format", async () => {
    const old = AutomationDefinition.parse({
      schemaVersion: 1,
      slug: "bill-intake",
      name: "Bill intake",
      steps: [],
    });
    open({
      [`GET /api/ops/automations/${AUTO_ID}`]: () => ({
        automation: AUTOMATION,
        versions: [version(V1, 1, "live", old)],
        usedBy: [],
      }),
    });
    expect(await screen.findByTestId("flow-auto-old")).toHaveTextContent("older step format");
    expect(screen.queryByTestId("flow-bar")).toBeNull();
    expect(screen.getByTestId("flow-auto-back")).toHaveAttribute(
      "href",
      `/ops/skills/automations/${AUTO_ID}`,
    );
  });

  it("opens from the automation's page, which keeps its versions and used by", async () => {
    const { user } = open({}, `/ops/skills/automations/${AUTO_ID}`);
    expect(await screen.findByTestId("automation-versions")).toBeInTheDocument();
    expect(screen.getByTestId("automation-used-by")).toBeInTheDocument();
    await user.click(screen.getByTestId("automation-edit-steps"));
    expect(screen.getByTestId("location")).toHaveTextContent(STEPS);
    expect(await screen.findByTestId("flow-bar")).toBeInTheDocument();
  });
});
