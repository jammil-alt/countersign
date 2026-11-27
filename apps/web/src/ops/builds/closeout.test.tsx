// Owner (2026-11-21): "There is no way to answer this question here." An issue is closed out on
// its row: a question answered in a box under it (sent to the Builder in its thread) or closed from
// a menu, a gap's choice sent to the Builder, a note or precondition marked done.
import type { BuildDetail, BuildItemKind } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";
import { NOT_NEEDED_NOTE, withNote } from "./words";

// The back office's code loads on demand: loaded once, up front (as builds.test.tsx).
await import("../OpsApp");

const ID = "00000000-0000-4000-8000-0000000b0c01";
const at = "2026-11-21T10:00:00.000Z";
const Q = "00000000-0000-4000-8000-0000000b0c11";
const GAP = "00000000-0000-4000-8000-0000000b0c12";
const NOTE = "00000000-0000-4000-8000-0000000b0c13";
const TEST = "00000000-0000-4000-8000-0000000b0c14";

type Item = BuildDetail["items"][number];

const item = (id: string, kind: BuildItemKind, title: string, over: Partial<Item> = {}): Item => ({
  id,
  phase: "intake",
  kind,
  title,
  detail: "",
  owner: "operator",
  state: "open",
  stepId: null,
  ref: {},
  key: null,
  createdAt: at,
  resolvedAt: null,
  ...over,
});

const ITEMS: Item[] = [
  item(Q, "question", "Who approves new vendors", { detail: "The brief doesn't say." }),
  item(GAP, "gap", "Read handwritten delivery notes", { phase: "fitgap" }),
  item(NOTE, "note", "The client is closed in August"),
  item(TEST, "test", "Totals match the invoice", { phase: "poc", owner: "engineering" }),
];

function detail(items: Item[] = ITEMS): BuildDetail {
  return {
    build: {
      id: ID,
      kind: "agent",
      title: "Invoice intake",
      client: null,
      phase: "fitgap",
      status: "open",
      agentId: null,
      skillId: null,
      testAgentId: null,
      testClient: null,
      openItems: items.length,
      waitingOnClient: 0,
      createdBy: "Ann",
      createdAt: at,
      updatedAt: at,
      phaseAt: at,
      path: "new",
      flow: "phases",
      templateId: null,
      promisedOn: null,
      origin: null,
      requirements: null,
      pipelineStage: "building",
      standing: "you",
      waitingOn: "operator",
      statusLine: "",
      stuck: false,
      brief: {},
      fitgap: { rows: [], needsTrue: [], setup: [], decisions: [] },
      testPlan: { datasets: [] },
      qa: { accepted: {}, signedBy: null, signedAt: null, decision: null },
    },
    phases: [
      { phase: "intake", label: "Intake", state: "done" },
      { phase: "fitgap", label: "Fit-gap", state: "current" },
      { phase: "draft", label: "Draft", state: "todo" },
    ],
    gate: { next: "draft", reasons: [] },
    messages: [],
    items,
    draft: null,
    poc: null,
    clientTest: null,
    qaChecks: [],
    events: [],
  };
}

function setup(turn?: () => unknown) {
  const turns: unknown[] = [];
  const updates: { item: string; body: unknown }[] = [];
  let items = ITEMS;
  const routes: Parameters<typeof fakeApi>[0] = {
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
    [`GET /api/ops/builds/${ID}`]: () => detail(items),
    [`POST /api/ops/builds/${ID}/turns`]: ({ init }) => {
      turns.push(JSON.parse(String(init.body)));
      return turn ? turn() : detail(items);
    },
  };
  for (const i of ITEMS) {
    routes[`PATCH /api/ops/builds/${ID}/items/${i.id}`] = ({ init }) => {
      const body = JSON.parse(String(init.body));
      updates.push({ item: i.id, body });
      // As the server does (§1.169): a drop is done, with its note kept in the detail.
      const change = body.drop
        ? { state: "done", detail: withNote(i.detail, NOT_NEEDED_NOTE) }
        : body;
      items = items.map((x) => (x.id === i.id ? { ...x, ...change } : x));
      return detail(items);
    };
  }
  const api = fakeApi(routes);
  render(
    <MemoryRouter initialEntries={[`/ops/builds/${ID}`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { turns, updates };
}

describe("closing out an issue on its row", () => {
  it("answers a question in a box under it, sent to the Builder in the issue's thread", async () => {
    const { turns } = setup();
    const view = await screen.findByTestId("build-view");
    const row = within(view).getByTestId(`build-item-${Q}`);
    // Its words at full width; where it came from, who has it and its status in full words.
    expect(row).toHaveTextContent("The brief doesn't say.");
    expect(row).toHaveTextContent("From Intake");
    expect(within(row).getByTestId(`build-item-${Q}-owner`)).toHaveTextContent("Who has it: You");
    expect(within(row).getByTestId(`build-item-${Q}-state`)).toHaveTextContent("Open");

    // Cancel shuts the box and sends nothing.
    await userEvent.click(within(row).getByTestId(`build-item-${Q}-answer`));
    expect(within(row).getByTestId(`build-item-${Q}-answer-box-input`)).toHaveFocus();
    await userEvent.click(within(row).getByTestId(`build-item-${Q}-answer-box-cancel`));
    expect(within(row).queryByTestId(`build-item-${Q}-answer-box`)).toBeNull();

    await userEvent.click(within(row).getByTestId(`build-item-${Q}-answer`));
    const send = within(row).getByTestId(`build-item-${Q}-answer-box-send`);
    expect(send).toHaveTextContent("Send answer");
    expect(send).toBeDisabled();
    // The conversation's own box is left as it was.
    await userEvent.type(
      within(row).getByTestId(`build-item-${Q}-answer-box-input`),
      "Dana in accounts payable",
    );
    expect(within(view).getByTestId("build-input")).toHaveValue("");
    await userEvent.click(send);
    await waitFor(() =>
      expect(turns).toEqual([
        {
          text: "About “Who approves new vendors”: Dana in accounts payable",
          about: `item:${Q}`,
        },
      ]),
    );
    // The conversation is on the issue, and the box has shut.
    expect(within(view).getByTestId("build-focus")).toHaveTextContent(
      "About: Who approves new vendors",
    );
    expect(within(view).queryByTestId(`build-item-${Q}-answer-box`)).toBeNull();
  });

  it("gives the answer back when the Builder couldn't take it", async () => {
    const { turns } = setup(
      () => new Reply(503, { error: "builder_unavailable", message: "The Builder is down." }),
    );
    const view = await screen.findByTestId("build-view");
    await userEvent.click(within(view).getByTestId(`build-item-${Q}-answer`));
    await userEvent.type(within(view).getByTestId(`build-item-${Q}-answer-box-input`), "Dana");
    await userEvent.click(within(view).getByTestId(`build-item-${Q}-answer-box-send`));
    await waitFor(() => expect(turns).toHaveLength(1));
    expect(await within(view).findByTestId(`build-item-${Q}-answer-box-input`)).toHaveValue("Dana");
  });

  it("closes a question from its Close menu: put off or not needed, never done by saying so", async () => {
    const { updates, turns } = setup();
    const view = await screen.findByTestId("build-view");
    const close = within(view).getByTestId(`build-item-${Q}-close`);
    expect(close).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(close);
    expect(close).toHaveAttribute("aria-expanded", "true");
    // docs/plan.md §1.169: a question closes by its answer; there is no "answered elsewhere".
    expect(within(view).queryByTestId(`build-item-${Q}-close-done`)).toBeNull();
    await userEvent.click(within(view).getByTestId(`build-item-${Q}-close-deferred`));
    await waitFor(() => expect(updates).toEqual([{ item: Q, body: { state: "deferred" } }]));
    // Put off: no longer open, so its Close menu goes; taken up again, it comes back.
    expect(within(view).queryByTestId(`build-item-${Q}-close`)).toBeNull();
    await userEvent.click(within(view).getByTestId(`build-item-${Q}-reopen`));
    await waitFor(() => expect(updates.at(-1)).toEqual({ item: Q, body: { state: "open" } }));

    // Not needed is a drop: the server closes it, with a note kept in its detail.
    await userEvent.click(await within(view).findByTestId(`build-item-${Q}-close`));
    await userEvent.click(within(view).getByTestId(`build-item-${Q}-close-not-needed`));
    await waitFor(() => expect(updates.at(-1)).toEqual({ item: Q, body: { drop: true } }));
    expect(within(view).getByTestId(`build-item-${Q}`)).toHaveTextContent("Closed as not needed.");
    expect(within(view).getByTestId(`build-item-${Q}-reopen`)).toHaveTextContent("Reopen");
    expect(turns).toEqual([]);
  });

  it("sends a gap's choice to the Builder, and marks a note done", async () => {
    const { turns, updates } = setup();
    const view = await screen.findByTestId("build-view");
    const gap = within(view).getByTestId(`build-item-${GAP}`);
    expect(gap).toHaveTextContent("From Fit-gap");
    await userEvent.click(within(gap).getByTestId(`build-item-${GAP}-gap-build`));
    await waitFor(() => expect(turns).toHaveLength(1));
    await userEvent.click(within(gap).getByRole("button", { name: "A person does it" }));
    await waitFor(() => expect(turns).toHaveLength(2));
    expect(turns).toEqual([
      {
        text: "About “Read handwritten delivery notes”: build it. Cover it in the draft.",
        about: `item:${GAP}`,
      },
      {
        text: "About “Read handwritten delivery notes”: a person does it. Make it a person step.",
        about: `item:${GAP}`,
      },
    ]);
    // Put off and Drop it are the gap's own; dropping isn't sent to the Builder (§1.169).
    expect(within(gap).getByTestId(`build-item-${GAP}-put-off`)).toHaveTextContent("Put off");
    await userEvent.click(within(gap).getByRole("button", { name: "Drop it" }));
    await waitFor(() => expect(updates).toEqual([{ item: GAP, body: { drop: true } }]));
    expect(turns).toHaveLength(2);

    await userEvent.click(within(view).getByTestId(`build-item-${NOTE}-done`));
    await waitFor(() => expect(updates.at(-1)).toEqual({ item: NOTE, body: { state: "done" } }));

    // A test keeps its own path: what settles it, and its status; no close-out buttons.
    const test = within(view).getByTestId(`build-item-${TEST}`);
    expect(within(test).getByTestId(`build-item-${TEST}-how`)).toHaveTextContent(
      "Fix what failed, then run the tests again.",
    );
    expect(within(test).getByTestId(`build-item-${TEST}-owner`)).toHaveTextContent(
      "Who has it: Mezonas engineering",
    );
    expect(within(test).getByTestId(`build-item-${TEST}-how`)).toHaveTextContent(
      "It closes when the test passes.",
    );
    expect(within(test).queryByTestId(`build-item-${TEST}-done`)).toBeNull();
    expect(within(test).queryByTestId(`build-item-${TEST}-answer`)).toBeNull();
  });
});

describe("withNote", () => {
  it("adds the note after the detail, within the item's room", () => {
    expect(withNote("", NOT_NEEDED_NOTE)).toBe("Closed as not needed.");
    expect(withNote("Asked twice.", NOT_NEEDED_NOTE)).toBe("Asked twice.\nClosed as not needed.");
    const long = withNote("x".repeat(2000), NOT_NEEDED_NOTE);
    expect(long).toHaveLength(2000);
    expect(long.endsWith("\nClosed as not needed.")).toBe(true);
  });
});
