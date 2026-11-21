// Decisions on a build (docs/builder-plan.md §4): the Decisions card beside the issues, each row
// with what, why, value and kind; a high-risk one nobody has looked at says "Check" and is an
// issue; "Ask about it" puts the conversation on it. Owner (2026-11-21): each is closed out on its
// row: Confirm, Change it (the Builder rewrites it), Undo, and by its kind Ask each client or A
// person decides each run, the last three as words to the Builder in the decision's thread.
import type { BuildDetail, Decision } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

// The back office's code loads on demand: loaded once, up front (as builds.test.tsx).
await import("../OpsApp");

const ID = "00000000-0000-4000-8000-0000000b0d01";
const at = "2026-11-19T10:00:00.000Z";

const dec = (id: string, over: Partial<Decision> = {}): Decision => ({
  id,
  what: `Decision ${id}`,
  why: "",
  kind: "assumption",
  risk: "normal",
  status: "never_discussed",
  by: null,
  at: null,
  ...over,
});

const decisions: Decision[] = [
  dec("tol", {
    what: "Amounts may differ by at most 0%",
    why: "Strict first: more goes to a person.",
    value: "0%",
    kind: "client_setup",
    risk: "high",
    category: "money",
  }),
  dec("freight", {
    what: "Freight and fees stay out of the catalog",
    why: "The brief is about materials.",
  }),
  dec("post", {
    what: "Bills are posted after a person approves",
    kind: "decision_point",
    risk: "high",
    category: "writes",
    status: "confirmed",
    by: "Ada",
    at,
  }),
];

function detail(list: Decision[]): BuildDetail {
  return {
    build: {
      id: ID,
      kind: "agent",
      title: "Invoice intake",
      client: null,
      phase: "poc",
      status: "open",
      agentId: null,
      skillId: null,
      testAgentId: null,
      testClient: null,
      openItems: 0,
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
      fitgap: { rows: [], needsTrue: [], setup: [], decisions: list },
      testPlan: { datasets: [] },
      qa: { accepted: {}, signedBy: null, signedAt: null, decision: null },
    },
    phases: [
      { phase: "intake", label: "Intake", state: "done" },
      { phase: "fitgap", label: "Fit-gap", state: "done" },
      { phase: "draft", label: "Draft", state: "done" },
      { phase: "poc", label: "POC test", state: "current" },
      { phase: "client_test", label: "Client test", state: "todo" },
      { phase: "qa", label: "QA and go / no-go", state: "todo" },
    ],
    gate: { next: "client_test", reasons: ["1 high-risk decision hasn't been looked at yet."] },
    messages: [],
    items: [],
    draft: null,
    poc: null,
    clientTest: null,
    qaChecks: [],
    events: [],
  };
}

describe("the Decisions card", () => {
  it("lists the decisions, says Check on unreviewed high-risk ones, and confirms one", async () => {
    const patched: unknown[] = [];
    const turns: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
      [`GET /api/ops/builds/${ID}`]: () => detail(decisions),
      [`PATCH /api/ops/builds/${ID}/decisions/tol`]: ({ init }) => {
        patched.push(JSON.parse(String(init.body)));
        return {
          ...detail(
            decisions.map((d) =>
              d.id === "tol" ? { ...d, status: "confirmed" as const, by: "Ann", at } : d,
            ),
          ),
          gate: { next: "client_test", reasons: [] },
        };
      },
      [`POST /api/ops/builds/${ID}/turns`]: ({ init }) => {
        turns.push(JSON.parse(String(init.body)));
        return detail(decisions);
      },
    });
    render(
      <MemoryRouter initialEntries={[`/ops/builds/${ID}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const view = await screen.findByTestId("build-view");
    const card = within(view).getByTestId("build-decisions");
    expect(within(card).getByTestId("build-decisions-meta")).toHaveTextContent(
      "3 decisions2 high risk1 to check",
    );
    const tol = within(card).getByTestId("build-decision-tol");
    expect(tol).toHaveTextContent("Amounts may differ by at most 0%");
    expect(tol).toHaveTextContent("Starts at: 0%");
    expect(tol).toHaveTextContent("Strict first: more goes to a person.");
    expect(tol).toHaveTextContent("Client setup");
    expect(within(tol).getByTestId("build-decision-tol-check")).toHaveTextContent("Check");
    // Normal or already looked at: no Check.
    expect(within(card).queryByTestId("build-decision-freight-check")).toBeNull();
    expect(within(card).queryByTestId("build-decision-post-check")).toBeNull();
    expect(within(card).getByTestId("build-decision-post")).toHaveTextContent("By Ada");
    // The unreviewed high-risk one is an issue too, holding the client test.
    expect(within(view).getByTestId("build-issue-decision:tol")).toHaveTextContent(
      "Never discussed",
    );

    // "Ask about it" puts the conversation on any decision, a normal one included.
    await userEvent.click(within(card).getByTestId("build-decision-freight-ask"));
    expect(within(view).getByTestId("build-focus")).toHaveTextContent(
      "About: Freight and fees stay out of the catalog",
    );
    await userEvent.type(within(view).getByTestId("build-input"), "Why?");
    await userEvent.click(within(view).getByTestId("build-send"));
    await waitFor(() => expect(turns).toEqual([{ text: "Why?", about: "decision:freight" }]));

    // The status is a chip in full words; Confirm sets it.
    expect(within(card).getByTestId("build-decision-tol-status")).toHaveTextContent(
      "Never discussed",
    );
    expect(within(card).getByTestId("build-decision-post-status")).toHaveTextContent("Confirmed");
    expect(within(card).queryByTestId("build-decision-post-confirm")).toBeNull();
    await userEvent.click(within(card).getByTestId("build-decision-tol-confirm"));
    await waitFor(() => expect(patched).toEqual([{ status: "confirmed" }]));
    await waitFor(() => expect(within(view).queryByTestId("build-decision-tol-check")).toBeNull());
    expect(within(view).getByTestId("build-decisions-meta")).not.toHaveTextContent("to check");
    expect(within(view).queryByTestId("build-issue-decision:tol")).toBeNull();
  });

  it("sends Change it to the Builder in the decision's thread, marking it discussed first", async () => {
    const calls: string[] = [];
    const turns: unknown[] = [];
    let list = decisions;
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
      [`GET /api/ops/builds/${ID}`]: () => detail(list),
      [`PATCH /api/ops/builds/${ID}/decisions/tol`]: ({ init }) => {
        const { status } = JSON.parse(String(init.body));
        calls.push(`status ${status}`);
        list = list.map((d) =>
          d.id === "tol"
            ? status === "never_discussed"
              ? { ...d, status, by: null, at: null }
              : { ...d, status, by: "Ann", at }
            : d,
        );
        return detail(list);
      },
      [`PATCH /api/ops/builds/${ID}/decisions/post`]: ({ init }) => {
        const { status } = JSON.parse(String(init.body));
        calls.push(`post ${status}`);
        list = list.map((d) => (d.id === "post" ? { ...d, status, by: null, at: null } : d));
        return detail(list);
      },
      [`POST /api/ops/builds/${ID}/turns`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        turns.push(body);
        calls.push(`turn ${body.about}`);
        return detail(list);
      },
    });
    render(
      <MemoryRouter initialEntries={[`/ops/builds/${ID}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const view = await screen.findByTestId("build-view");
    const card = within(view).getByTestId("build-decisions");

    // Change it opens a box under the row; Cancel shuts it and sends nothing.
    await userEvent.click(within(card).getByTestId("build-decision-tol-change"));
    expect(within(card).getByTestId("build-decision-tol-change-box-input")).toHaveFocus();
    await userEvent.click(within(card).getByTestId("build-decision-tol-change-box-cancel"));
    expect(within(card).queryByTestId("build-decision-tol-change-box")).toBeNull();
    expect(calls).toEqual([]);

    // Sent: a never-discussed decision is marked discussed, then the words go to the Builder.
    await userEvent.click(within(card).getByTestId("build-decision-tol-change"));
    expect(within(card).getByTestId("build-decision-tol-change-box-send")).toBeDisabled();
    await userEvent.type(
      within(card).getByTestId("build-decision-tol-change-box-input"),
      "2% or 5 dollars, whichever is less",
    );
    await userEvent.click(within(card).getByTestId("build-decision-tol-change-box-send"));
    await waitFor(() => expect(calls).toEqual(["status discussed", "turn decision:tol"]));
    expect(turns).toEqual([
      {
        text: "About “Amounts may differ by at most 0%”: change this decision. It should be: 2% or 5 dollars, whichever is less. Rewrite the decision, and the draft to match.",
        about: "decision:tol",
      },
    ]);
    expect(within(card).queryByTestId("build-decision-tol-change-box")).toBeNull();
    // The conversation is on the decision now.
    expect(within(view).getByTestId("build-focus")).toHaveTextContent(
      "About: Amounts may differ by at most 0%",
    );
    expect(within(card).getByTestId("build-decision-tol-status")).toHaveTextContent("Discussed");

    // A client setup decision can go to each client instead (it's discussed now: no mark first).
    await userEvent.click(within(card).getByTestId("build-decision-tol-each-client"));
    await waitFor(() => expect(calls).toHaveLength(3));
    expect(calls.at(-1)).toBe("turn decision:tol");
    expect(turns.at(-1)).toEqual({
      text: "About “Amounts may differ by at most 0%”: ask each client. Move it into the client intake form, so each client gives their own answer.",
      about: "decision:tol",
    });
    // Only a decision point offers a person on each run; only client setup offers each client.
    expect(within(card).queryByTestId("build-decision-tol-person")).toBeNull();
    expect(within(card).queryByTestId("build-decision-post-each-client")).toBeNull();
    await userEvent.click(within(card).getByTestId("build-decision-post-person"));
    await waitFor(() => expect(calls.at(-1)).toBe("turn decision:post"));
    expect(turns.at(-1)).toEqual({
      text: "About “Bills are posted after a person approves”: a person decides each run. Make it a person step.",
      about: "decision:post",
    });

    // Undo takes a confirmed or discussed decision back to never discussed.
    expect(within(card).queryByTestId("build-decision-freight-undo")).toBeNull();
    await userEvent.click(within(card).getByTestId("build-decision-post-undo"));
    await waitFor(() => expect(calls.at(-1)).toBe("post never_discussed"));
    await waitFor(() =>
      expect(within(card).getByTestId("build-decision-post-status")).toHaveTextContent(
        "Never discussed",
      ),
    );
    expect(within(card).queryByTestId("build-decision-post-undo")).toBeNull();
  });

  it("starts shut when nothing waits on a check, and its jump link opens it", async () => {
    localStorage.clear();
    const looked = decisions.map((d) => ({ ...d, status: "confirmed" as const, by: "Ann", at }));
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      "GET /api/ops/counts": () => ({ needsUs: 0, clients: [] }),
      [`GET /api/ops/builds/${ID}`]: () => detail(looked),
    });
    render(
      <MemoryRouter initialEntries={[`/ops/builds/${ID}`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    const view = await screen.findByTestId("build-view");
    const card = within(view).getByTestId("build-decisions");
    // Shut: its counts show, its rows don't.
    expect(within(card).getByTestId("build-decisions-meta")).toHaveTextContent("3 decisions");
    expect(within(card).queryByTestId("build-decision-tol")).toBeNull();
    // The bar links to each section, with what waits there.
    const bar = within(view).getByTestId("build-bar");
    expect(within(bar).getByTestId("build-jump-phase")).toHaveTextContent("POC test");
    expect(within(bar).getByTestId("build-jump-decisions")).toHaveTextContent(/^Decisions$/);
    await userEvent.click(within(bar).getByTestId("build-jump-decisions"));
    expect(within(card).getByTestId("build-decision-tol")).toBeTruthy();
    // Folding it again is kept for this browser.
    await userEvent.click(within(card).getByTestId("build-fold-decisions"));
    expect(within(card).queryByTestId("build-decision-tol")).toBeNull();
    expect(JSON.parse(localStorage.getItem("mezonas.build.folded") ?? "{}")).toEqual({
      decisions: false,
    });
  });
});
