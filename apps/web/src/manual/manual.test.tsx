// B3 (docs/builder-plan.md §5): the agent manual on screen. The back office's Manual tab reads its
// own route; the portal reads the agent's SOP in its place (docs/sop-plan.md S1, sop.test.tsx). A
// change whose step rests on a decision nobody has discussed says so on its card.

import type { ManualView } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../api/useApi";
import { InboxCard, type InboxCardItem } from "../inbox/InboxCard";
import { UndiscussedLines } from "../inbox/Undiscussed";
import { OpsManualTab } from "../ops/agents/ManualTab";
import { fakeApi } from "../test/fixtures";

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
