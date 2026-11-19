// B3 (docs/builder-plan.md §5): the agent manual on screen. The portal's Manual tab reads the
// client's view (what it does, how it works, decisions, who decides, known risks, what we set up,
// what it learned) with "Ask about this" opening Sloan with the line quoted; a client user is told
// what it learned is the admin's. The back office's Manual tab reads its own route. A change whose
// step rests on a decision nobody has discussed says so on its card.

import type { ManualView } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { ApiProvider } from "../api/useApi";
import { InboxCard, type InboxCardItem } from "../inbox/InboxCard";
import { UndiscussedLines } from "../inbox/Undiscussed";
import { OpsManualTab } from "../ops/agents/ManualTab";
import { CLIENT_SESSION, fakeApi, Reply } from "../test/fixtures";

const SVC = "00000000-0000-4000-8000-00000000b001";

const VIEW: ManualView = {
  agent: { id: SVC, name: "Pia" },
  written: true,
  whatItDoes: "Reads each invoice into your vendor items.",
  howItWorks: [
    {
      workflow: "Read an invoice",
      stepId: "read",
      depth: 0,
      kind: "read",
      name: "Read the invoice",
      words: "Reads from your tools",
    },
    {
      workflow: "Read an invoice",
      stepId: "post",
      depth: 1,
      kind: "write",
      name: "Post the bill",
      words: "Updates your tools, after a person approves",
    },
  ],
  decisions: [
    {
      id: "freight",
      what: "Freight stays out of the catalog",
      why: "The brief is about item prices.",
      value: null,
      kind: "assumption",
      kindWords: "Assumption",
      risk: "normal",
      status: "never_discussed",
      statusWords: "Never discussed",
      step: "Post the bill",
      by: null,
    },
    {
      id: "tol",
      what: "Prices may differ by 2% before a person looks",
      why: "",
      value: "2%",
      kind: "client_setup",
      kindWords: "Client setup",
      risk: "high",
      status: "confirmed",
      statusWords: "Confirmed",
      step: null,
      by: null,
    },
  ],
  decisionPoints: [
    {
      stepId: "post",
      what: "Approve: Post the bill",
      who: "Your admin",
      byWhen: "2 days",
      notDiscussed: false,
    },
  ],
  knownRisks: [
    {
      id: "multi",
      what: "Several invoices in one file",
      detail: "Not built in this version: when it happens, a person handles it.",
      hits: null,
    },
  ],
  setup: [{ label: "When do we start writing into QuickBooks?", answer: "After the trial" }],
  learned: [{ id: "n1", note: "Acme sends two PDFs per bill", at: "2026-11-18T10:00:00.000Z" }],
  reads: ["The Mezonas guardrails: the rules every agent follows."],
};

const DETAIL = {
  service: { id: SVC, name: "Pia", description: "Reads invoices.", status: "active" },
  thisMonth: {
    from: "2026-11-01",
    to: "2026-11-04",
    runs: { total: 0, succeeded: 0, failed: 0, cancelled: 0, waiting: 0, going: 0 },
    documentsRead: 0,
    actions: 0,
  },
  recentRuns: [],
  packs: [],
};

function portal(view: ManualView, session = CLIENT_SESSION) {
  const api = fakeApi({
    "GET /api/session": () => session,
    "GET /api/overview": () => new Reply(404, {}),
    "GET /api/feedback/status": () => ({ enabled: false }),
    [`GET /api/services/${SVC}`]: () => DETAIL,
    [`GET /api/services/${SVC}/manual`]: () => view,
  });
  render(
    <MemoryRouter initialEntries={[`/agents/${SVC}/manual`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("the portal's Manual tab", () => {
  it("shows the manual's sections, read only, with Ask about this on each line", async () => {
    const api = portal(VIEW);
    const manual = await screen.findByTestId("manual");
    expect(api.calls).toContain(`GET /api/services/${SVC}/manual`);
    expect(screen.getByRole("link", { name: "Manual" })).toBeInTheDocument();
    expect(within(manual).getByTestId("manual-what")).toHaveTextContent(
      "Reads each invoice into your vendor items.",
    );
    expect(within(manual).getByTestId("manual-step-post")).toHaveTextContent(
      "Post the billUpdates your tools, after a person approves",
    );
    const freight = within(manual).getByTestId("manual-decision-freight");
    expect(freight).toHaveTextContent("Freight stays out of the catalog");
    expect(within(freight).getByTestId("manual-decision-freight-status")).toHaveTextContent(
      "Never discussed",
    );
    expect(freight).toHaveTextContent("Step: Post the bill");
    const tol = within(manual).getByTestId("manual-decision-tol");
    expect(tol).toHaveTextContent("High risk");
    expect(tol).toHaveTextContent("Starts at 2%");
    expect(tol).toHaveTextContent("Set up with you");
    expect(within(manual).getByTestId("manual-points")).toHaveTextContent(
      "Who: Your admin · Within 2 days",
    );
    expect(within(manual).getByTestId("manual-risks")).toHaveTextContent(
      "Several invoices in one file",
    );
    expect(within(manual).getByTestId("manual-setup")).toHaveTextContent("After the trial");
    expect(within(manual).getByTestId("manual-learned")).toHaveTextContent(
      "Acme sends two PDFs per bill",
    );
    // Ask about this opens Sloan with the line quoted.
    const ask = within(freight).getByTestId("manual-ask");
    expect(ask).toHaveTextContent("Ask about this");
    const href = decodeURIComponent(ask.getAttribute("href") ?? "");
    expect(href).toBe("/sloan?ask=About Pia's manual: “Freight stays out of the catalog” ");
  });

  it("tells a client user what it learned is the admin's, and hides setup when there is none", async () => {
    portal(
      { ...VIEW, learned: [], setup: [], written: false },
      {
        ...CLIENT_SESSION,
        tenants: CLIENT_SESSION.tenants.map((t) => ({ ...t, role: "client_user" as const })),
      },
    );
    const manual = await screen.findByTestId("manual");
    expect(within(manual).getByTestId("manual-learned")).toHaveTextContent(
      "What it learned is for your admin to see.",
    );
    expect(within(manual).queryByTestId("manual-setup")).toBeNull();
    expect(within(manual).getByTestId("manual-not-written")).toBeInTheDocument();
  });
});

// B5 (docs/builder-plan.md §7): "This is wrong because…" on a line, and changes on the settings.
describe("the portal's Manual tab: feedback and changes", () => {
  it("sends 'This is wrong because…' on a decision, linked to it", async () => {
    const api = portal(VIEW);
    let sent: unknown = null;
    api.on(`POST /api/services/${SVC}/manual/feedback`, ({ init }) => {
      sent = JSON.parse(String(init.body));
      return { request: { id: "00000000-0000-4000-8000-0000000d0001", number: 7 } };
    });
    const manual = await screen.findByTestId("manual");
    const freight = within(manual).getByTestId("manual-decision-freight");
    const u = userEvent.setup();
    await u.click(within(freight).getByTestId("manual-wrong"));
    const form = within(freight).getByTestId("manual-wrong-form");
    // Nothing to send until it says why.
    expect(within(form).getByTestId("manual-wrong-send")).toBeDisabled();
    await u.type(within(form).getByTestId("manual-wrong-input"), "Freight is on every bill.");
    await u.click(within(form).getByTestId("manual-wrong-send"));
    expect(await within(freight).findByTestId("manual-wrong-sent")).toHaveTextContent(
      "Sent to us as request #7. We'll answer there.",
    );
    expect(sent).toEqual({
      section: "decision",
      lineId: "freight",
      line: "Freight stays out of the catalog",
      because: "Freight is on every bill.",
    });
  });

  it("says who changed a setting: the client's own person by name, ours as us", async () => {
    portal({
      ...VIEW,
      decisions: VIEW.decisions.map((d) =>
        d.id === "tol"
          ? {
              ...d,
              status: "changed",
              statusWords: "Changed",
              by: "Ada",
              at: "2026-11-19T10:00:00.000Z",
              side: "client",
            }
          : {
              ...d,
              status: "changed",
              statusWords: "Changed",
              by: null,
              at: "2026-11-18T10:00:00.000Z",
              side: "operator",
            },
      ),
    });
    const manual = await screen.findByTestId("manual");
    expect(within(manual).getByTestId("manual-decision-tol-by")).toHaveTextContent(
      /^Changed by Ada on /,
    );
    expect(within(manual).getByTestId("manual-decision-freight-by")).toHaveTextContent(
      /^Changed by us on /,
    );
  });
});

describe("the back office's Manual tab", () => {
  it("reads the version shown, and names who looked at a decision", async () => {
    const ID = "00000000-0000-4000-8000-00000000c001";
    const api = fakeApi({
      [`GET /api/ops/agents/${ID}/manual`]: ({ url }) => {
        expect(url.searchParams.get("version")).toBe("3");
        return {
          ...VIEW,
          decisions: VIEW.decisions.map((d) => (d.id === "tol" ? { ...d, by: "Dana" } : d)),
        };
      },
    });
    render(
      <MemoryRouter>
        <ApiProvider client={api.client}>
          <OpsManualTab agentId={ID} version={3} />
        </ApiProvider>
      </MemoryRouter>,
    );
    const manual = await screen.findByTestId("manual");
    expect(within(manual).getByTestId("manual-decision-tol")).toHaveTextContent("By Dana");
    expect(within(manual).getByTestId("manual-decision-tol")).toHaveTextContent("Client setup");
    // No "Ask about this" in the back office: the build's conversation is where it talks.
    expect(within(manual).queryByTestId("manual-ask")).toBeNull();
    // Nor "This is wrong": that is the client's way to tell us (B5).
    expect(within(manual).queryByTestId("manual-wrong")).toBeNull();
  });
});

describe("the approval card", () => {
  const CHANGE: InboxCardItem = {
    id: "00000000-0000-4000-8000-0000000f0001",
    kind: "external_action",
    title: "Change a record's name or amount. (testkit.record.update)",
    payload: {
      tool: "testkit.record.update",
      verb: "update",
      connector: "testkit",
      input: { id: "r1", amount: "12.00" },
      before: { id: "r1", name: "Oak board", amount: "10.00" },
      stepId: "post",
      undiscussed: [{ id: "freight", what: "Freight stays out of the catalog." }],
    },
    status: "open",
    runId: null,
    dueAt: null,
    createdAt: "2026-11-03T10:00:00.000Z",
    resolvedAt: null,
  };

  it("says the change rests on a decision nobody has discussed yet", () => {
    render(
      <MemoryRouter>
        <InboxCard item={CHANGE} onResolve={null} />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("inbox-undiscussed")).toHaveTextContent(
      "Based on a decision nobody has discussed yet: freight stays out of the catalog",
    );
    // Shown as its own line, never as a raw fact.
    expect(screen.queryByText(/undiscussed/)).toBeNull();
  });

  it("says nothing more when the step rests on none", () => {
    const { container } = render(<UndiscussedLines payload={{ stepId: "post" }} />);
    expect(container).toBeEmptyDOMElement();
  });
});
