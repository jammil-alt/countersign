// "Who approves" on both surfaces: the operator adds, edits, reorders and removes a client's rules
// on the client page and tries a sample change; the client admin can only tighten them from
// Connections; a client user reads them.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { ApiProvider } from "../api/useApi";
import { PortalApproverRules } from "../portal/screens/ApproverRules";
import {
  fakeApi,
  OPERATOR_SESSION,
  opsClientSettings,
  Reply,
  SANDBOX_DETAIL,
} from "../test/fixtures";

const CLIENT = SANDBOX_DETAIL.client.id;
const ANA = "00000000-0000-4000-8000-00000000b001";
const BO = "00000000-0000-4000-8000-00000000b002";
const AGENT = "00000000-0000-4000-8000-00000000c001";
const R1 = "00000000-0000-4000-8000-0000000000e1";
const R2 = "00000000-0000-4000-8000-0000000000e2";

const people = [
  { id: ANA, name: "Ana Diaz", email: "ana@client.example.com", role: "client_admin" },
  { id: BO, name: "Bo Lee", email: "bo@client.example.com", role: "client_user" },
];
const connectors = [
  {
    id: "testkit",
    name: "Testkit",
    tools: [
      {
        id: "testkit.record.update",
        description: "Change a record's name or amount.",
        verb: "update",
        amount: true,
      },
    ],
  },
];
const rules = [
  {
    id: R1,
    match: { amountOver: { value: "1000", currency: "USD" } },
    approver: { kind: "operator" },
    setBy: "operator",
  },
  {
    id: R2,
    match: { connector: "testkit" },
    approver: { kind: "role", role: "client_user" },
    setBy: "operator",
  },
];

function opsView(over: Record<string, unknown> = {}) {
  return {
    revision: 3,
    rules,
    people,
    connectors,
    agents: [{ id: AGENT, name: "Record keeping", approver: null }],
    clientDefault: null,
    changes: [
      {
        id: "c1",
        side: "operator",
        by: "Operator",
        reason: "Big changes come to us",
        revision: 3,
        createdAt: "2026-11-04T10:00:00.000Z",
      },
    ],
    ...over,
  };
}

describe("back office: who approves", () => {
  function setup() {
    const sent: { revision: number; rules: unknown[]; reason: string }[] = [];
    let view = opsView();
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}`]: () => SANDBOX_DETAIL,
      // The rules sit on the client page's Settings tab.
      [`GET /api/ops/clients/${CLIENT}/settings`]: () => opsClientSettings(CLIENT),
      [`GET /api/ops/clients/${CLIENT}/feedback`]: () => ({ enabled: false, changes: [] }),
      [`GET /api/ops/clients/${CLIENT}/approver-rules`]: () => view,
      [`PUT /api/ops/clients/${CLIENT}/approver-rules`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push(body);
        view = opsView({
          revision: 4,
          rules: body.rules.map((r: object) => ({ setBy: "operator", ...r })),
        });
        return view;
      },
    });
    render(
      <MemoryRouter initialEntries={[`/ops/clients/${CLIENT}/settings`]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    return { sent };
  }

  it("lists the rules in order with who approves, and the change log", async () => {
    setup();
    const list = await screen.findByTestId("approver-rules-list");
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => within(r).getByTestId("approver-rule-match").textContent)).toEqual([
      "Over 1000 USD",
      "Testkit",
    ]);
    expect(within(rows[0] as HTMLElement).getByTestId("approver-rule-approver")).toHaveTextContent(
      "Operator, for the client",
    );
    expect(within(rows[1] as HTMLElement).getByTestId("approver-rule-approver")).toHaveTextContent(
      "Anyone in the client",
    );
    expect(screen.getByTestId("approver-rules-history")).toHaveTextContent(
      "Big changes come to us",
    );
  });

  it("adds, reorders, edits and removes rules, then saves them with a reason", async () => {
    const { sent } = setup();
    await screen.findByTestId("approver-rules-list");
    // Add: testkit record changes over 500 USD go to Bo, first.
    await userEvent.click(screen.getByTestId("approver-rules-add"));
    const form = screen.getByTestId("approver-rule-form");
    await userEvent.selectOptions(
      within(form).getByTestId("approver-rule-form-connector"),
      "testkit",
    );
    await userEvent.selectOptions(
      within(form).getByTestId("approver-rule-form-tool"),
      "testkit.record.update",
    );
    await userEvent.type(within(form).getByTestId("approver-rule-form-amount"), "5OO");
    await userEvent.selectOptions(
      within(form).getByTestId("approver-rule-form-approver"),
      `user:${BO}`,
    );
    await userEvent.selectOptions(within(form).getByTestId("approver-rule-form-where"), "top");
    await userEvent.click(within(form).getByTestId("approver-rule-form-done"));
    expect(screen.getByTestId("approver-rule-form-problem")).toHaveTextContent("as a number");
    await userEvent.clear(within(form).getByTestId("approver-rule-form-amount"));
    await userEvent.type(within(form).getByTestId("approver-rule-form-amount"), "500");
    await userEvent.click(within(form).getByTestId("approver-rule-form-done"));
    const matches = () =>
      screen.getAllByTestId("approver-rule-match").map((m) => m.textContent ?? "");
    expect(matches()).toEqual([
      "Testkit · Change a record's name or amount. · Over 500 USD",
      "Over 1000 USD",
      "Testkit",
    ]);
    // Move the 1000 rule to the top, edit the testkit rule to the admin, remove nothing yet.
    await userEvent.click(
      within(screen.getByTestId("approver-rule-1")).getByTestId("approver-rule-up"),
    );
    expect(matches()[0]).toBe("Over 1000 USD");
    await userEvent.click(
      within(screen.getByTestId("approver-rule-2")).getByTestId("approver-rule-edit"),
    );
    await userEvent.selectOptions(
      within(screen.getByTestId("approver-rule-form")).getByTestId("approver-rule-form-approver"),
      "client_admin",
    );
    await userEvent.click(screen.getByTestId("approver-rule-form-done"));
    // Remove the 1000 rule.
    await userEvent.click(
      within(screen.getByTestId("approver-rule-0")).getByTestId("approver-rule-remove"),
    );
    expect(matches()).toEqual([
      "Testkit · Change a record's name or amount. · Over 500 USD",
      "Testkit",
    ]);

    // A reason is needed.
    await userEvent.click(screen.getByTestId("approver-rules-save"));
    expect(screen.getByTestId("approver-rules-reason-error")).toBeInTheDocument();
    expect(sent).toEqual([]);
    await userEvent.type(screen.getByTestId("approver-rules-reason"), "Bo signs off big edits");
    await userEvent.click(screen.getByTestId("approver-rules-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({
      revision: 3,
      reason: "Bo signs off big edits",
      rules: [
        {
          match: {
            connector: "testkit",
            tool: "testkit.record.update",
            amountOver: { value: "500", currency: "USD" },
          },
          approver: { kind: "user", userId: BO },
        },
        { id: R2, match: { connector: "testkit" }, approver: { kind: "client_admin" } },
      ],
    });
    // Saved: the editor starts again from the new revision.
    await waitFor(() => expect(screen.queryByTestId("approver-rules-save")).toBeNull());
  });

  it("tries a sample change against the rules", async () => {
    setup();
    const tryIt = await screen.findByTestId("approver-rules-try");
    const result = within(tryIt).getByTestId("approver-try-result");
    // An update somewhere else, with no amount: no rule fits.
    expect(result).toHaveTextContent("Client admin: no rule fits, so the client admin.");
    await userEvent.selectOptions(within(tryIt).getByTestId("approver-try-connector"), "testkit");
    expect(result).toHaveTextContent("Anyone in the client, by rule 2.");
    await userEvent.type(within(tryIt).getByTestId("approver-try-amount"), "1000.01");
    expect(result).toHaveTextContent("Operator, for the client, by rule 1.");
    await userEvent.clear(within(tryIt).getByTestId("approver-try-currency"));
    await userEvent.type(within(tryIt).getByTestId("approver-try-currency"), "EUR");
    expect(result).toHaveTextContent("by rule 2.");
  });
});

describe("portal: who approves", () => {
  function setup(canTighten: boolean) {
    const sent: { rules: { id?: string; approver: unknown }[]; reason: string }[] = [];
    const view = {
      revision: 3,
      rules,
      people,
      connectors,
      agents: [{ id: AGENT, name: "Record keeping" }],
      changes: [],
      canTighten,
    };
    const api = fakeApi({
      "GET /api/approver-rules": () => view,
      "PUT /api/approver-rules": ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push(body);
        return new Reply(200, { ...view, revision: 4, rules: body.rules });
      },
    });
    render(
      <ApiProvider client={api.client}>
        <PortalApproverRules />
      </ApiProvider>,
    );
    return { sent };
  }

  it("offers the client admin only the same or a stricter approver, never us", async () => {
    const { sent } = setup(true);
    const selects = await screen.findAllByTestId("approver-rule-approver-select");
    const labels = (el: HTMLElement) =>
      within(el)
        .getAllByRole("option")
        .map((o) => o.textContent);
    // Rule 1 is ours: it can come back to anyone on your team, your admin or a person.
    expect(labels(selects[0] as HTMLElement)).toEqual([
      "Your admin",
      "Anyone on your team",
      "Ana Diaz",
      "Bo Lee",
      "We approve for you",
    ]);
    // Rule 2 is anyone on your team: it can narrow, never go to us.
    expect(labels(selects[1] as HTMLElement)).toEqual([
      "Your admin",
      "Anyone on your team",
      "Ana Diaz",
      "Bo Lee",
    ]);
    // No reordering or removing a saved rule.
    expect(screen.queryByTestId("approver-rule-up")).toBeNull();
    expect(screen.queryByTestId("approver-rule-remove")).toBeNull();

    await userEvent.selectOptions(selects[0] as HTMLElement, `user:${ANA}`);
    // A new rule names your admin or one person only.
    await userEvent.click(screen.getByTestId("approver-rules-add"));
    const form = screen.getByTestId("approver-rule-form");
    expect(
      within(within(form).getByTestId("approver-rule-form-approver"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Your admin", "Ana Diaz", "Bo Lee"]);
    await userEvent.selectOptions(within(form).getByTestId("approver-rule-form-verb"), "create");
    await userEvent.click(within(form).getByTestId("approver-rule-form-done"));
    expect(screen.getAllByTestId("approver-rule-match")[0]).toHaveTextContent("Creates");
    expect(screen.getByTestId("approver-rule-0")).toHaveTextContent("Added by you");

    await userEvent.type(screen.getByTestId("approver-rules-reason"), "We sign our own changes");
    await userEvent.click(screen.getByTestId("approver-rules-save"));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]?.rules.map((r) => r.approver)).toEqual([
      { kind: "client_admin" },
      { kind: "user", userId: ANA },
      { kind: "role", role: "client_user" },
    ]);
    expect(sent[0]?.rules[1]?.id).toBe(R1);
  });

  it("shows a client user the rules without controls", async () => {
    setup(false);
    await screen.findByTestId("approver-rules-list");
    expect(screen.getAllByTestId("approver-rule-approver").map((t) => t.textContent)).toEqual([
      "We approve for you",
      "Anyone on your team",
    ]);
    expect(screen.queryByTestId("approver-rule-approver-select")).toBeNull();
    expect(screen.queryByTestId("approver-rules-add")).toBeNull();
  });
});
