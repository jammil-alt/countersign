// The back office's chart of accounts (docs/plan.md §1.79): a client's ledger per accounting
// connection, and a change that shows what changes first and is written only on "Sign and save".
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { ClientLedger } from "./ClientLedger";

const CLIENT = "00000000-0000-4000-8000-00000000c001";
const CONN = "00000000-0000-4000-8000-00000000c0c1";

const LEDGER = {
  ledgers: [
    {
      connectionId: CONN,
      connector: "qbo",
      accountName: "Harbor Millwork",
      status: "connected",
      lastSyncAt: "2026-11-08T15:00:00.000Z",
      accounts: [
        {
          id: "00000000-0000-4000-8000-0000000a0084",
          externalId: "84",
          name: "Shop Supplies",
          fullName: "Shop Supplies",
          number: null,
          classification: "expense",
          kind: "expense",
          type: "Expense",
          subType: null,
          description: null,
          parentExternalId: null,
          active: true,
          syncToken: "2",
          notes: [{ note: "Glue, blades and sandpaper.", source: "client" }],
        },
      ],
      dimensions: [
        {
          id: "00000000-0000-4000-8000-0000000d0001",
          kind: "class",
          externalId: "5000000000000301",
          name: "Shop",
          fullName: "Shop",
          parentExternalId: null,
          active: true,
          syncToken: "0",
        },
      ],
    },
  ],
};

function renderLedger(routes: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION, ...routes });
  render(
    <MemoryRouter initialEntries={["/"]}>
      <AppProviders client={api.client}>
        <Routes>
          <Route path="*" element={<ClientLedger clientId={CLIENT} />} />
        </Routes>
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("the chart of accounts", () => {
  it("lists the company's accounts and classes with what each is for", async () => {
    renderLedger({ [`GET /api/ops/clients/${CLIENT}/ledger`]: () => LEDGER });
    const card = await screen.findByTestId("ops-ledger-card");
    expect(card).toHaveTextContent("Harbor Millwork");
    expect(within(card).getByTestId("ops-ledger-account")).toHaveTextContent("Shop Supplies");
    expect(card).toHaveTextContent("Glue, blades and sandpaper.");
    expect(card).toHaveTextContent("Shop");
  });

  it("shows a change before writing it, and writes it only when signed, naming the version read", async () => {
    const bodies: unknown[] = [];
    renderLedger({
      [`GET /api/ops/clients/${CLIENT}/ledger`]: () => LEDGER,
      [`POST /api/ops/clients/${CLIENT}/ledger/changes`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return {
          status: "done",
          output: { id: "84", name: "Shop supplies and tools" },
          error: null,
        };
      },
    });
    const card = await screen.findByTestId("ops-ledger-card");
    await userEvent.click(
      within(within(card).getByTestId("ops-ledger-account")).getByRole("button", {
        name: "Change",
      }),
    );
    const form = within(card).getByTestId("ops-ledger-form");
    const name = within(form).getByTestId("ops-ledger-name");
    await userEvent.clear(name);
    await userEvent.type(name, "Shop supplies and tools");
    await userEvent.click(within(form).getByTestId("ops-ledger-review"));
    // The change, before and after, and nothing written yet.
    expect(within(form).getByTestId("ops-ledger-review-table")).toHaveTextContent(
      "NameShop SuppliesShop supplies and tools",
    );
    expect(bodies).toEqual([]);
    await userEvent.click(within(form).getByTestId("ops-ledger-sign"));
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect(bodies[0]).toMatchObject({
      connectionId: CONN,
      tool: "qbo.account.update",
      input: { id: "84", syncToken: "2", name: "Shop supplies and tools" },
    });
  });

  it("shows QuickBooks' refusal and writes nothing more", async () => {
    renderLedger({
      [`GET /api/ops/clients/${CLIENT}/ledger`]: () => LEDGER,
      [`POST /api/ops/clients/${CLIENT}/ledger/changes`]: () => ({
        status: "failed",
        output: null,
        error: "there is already a class named Shop in QuickBooks (5000000000000301)",
      }),
    });
    const card = await screen.findByTestId("ops-ledger-card");
    await userEvent.click(within(card).getByTestId("ops-ledger-add-class"));
    const form = within(card).getByTestId("ops-ledger-form");
    await userEvent.type(within(form).getByTestId("ops-ledger-name"), "Shop");
    await userEvent.click(within(form).getByTestId("ops-ledger-review"));
    await userEvent.click(within(form).getByTestId("ops-ledger-sign"));
    expect(await within(form).findByTestId("ops-ledger-problem")).toHaveTextContent(
      "already a class named Shop",
    );
  });

  it("says Signing while the signed change goes to QuickBooks (1.8)", async () => {
    let answer: (v: unknown) => void = () => {};
    renderLedger({
      [`GET /api/ops/clients/${CLIENT}/ledger`]: () => LEDGER,
      [`POST /api/ops/clients/${CLIENT}/ledger/changes`]: () => new Promise((r) => (answer = r)),
    });
    const card = await screen.findByTestId("ops-ledger-card");
    await userEvent.click(within(card).getByTestId("ops-ledger-add-class"));
    const form = within(card).getByTestId("ops-ledger-form");
    await userEvent.type(within(form).getByTestId("ops-ledger-name"), "Shop");
    await userEvent.click(within(form).getByTestId("ops-ledger-review"));
    await userEvent.click(within(form).getByTestId("ops-ledger-sign"));
    const sign = within(form).getByTestId("ops-ledger-sign");
    expect(sign).toHaveTextContent("Signing…");
    expect(sign).toBeDisabled();
    answer({ status: "failed", output: null, error: "QuickBooks said no" });
    expect(await within(form).findByTestId("ops-ledger-problem")).toHaveTextContent(
      "QuickBooks said no",
    );
    expect(within(form).getByTestId("ops-ledger-sign")).toHaveTextContent("Sign and save");
  });
});
