// The Sandbox's sample company on its Records page: shown in the Sandbox only; it posts the
// operator's name, email and phone when given (no body fields otherwise), then shows what is there
// and the employees; a second run says it was already set up; a refused call shows the API's words.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply, SANDBOX_DETAIL } from "../../test/fixtures";
import { sampleCounts } from "./SampleCompany";

const CLIENT = SANDBOX_DETAIL.client.id;

const COUNTS = {
  vendors: 8,
  organizations: 12,
  contacts: 16,
  ledgerAccounts: 22,
  ledgerNotes: 5,
  masterItems: 15,
  vendorItems: 20,
  transactions: 10,
};
const NONE = Object.fromEntries(Object.keys(COUNTS).map((k) => [k, 0]));

function result(added: Record<string, number>) {
  return {
    company: { name: "Ridgeline Builders", domain: "ridgeline.example.com" },
    counts: COUNTS,
    added,
    employees: [
      {
        contactId: "00000000-0000-4000-8000-0000000c0001",
        name: "Dana Whitfield",
        email: "dana@ridgeline.example.com",
        phone: "+15125550101",
        title: "Owner",
        you: false,
      },
      {
        contactId: "00000000-0000-4000-8000-0000000c0002",
        name: "Pat Operator",
        email: "pat@mezonas.test",
        phone: "+15125550177",
        title: "Operator (you)",
        you: true,
      },
    ],
    switchedOn: [],
    examples: [{ what: "A SKU at Northfork Lumber", value: "NF-BB34" }],
  };
}

function renderRecords(sandbox: boolean, post: (body: unknown) => unknown) {
  const bodies: unknown[] = [];
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${CLIENT}`]: () => ({
      ...SANDBOX_DETAIL,
      client: { ...SANDBOX_DETAIL.client, settings: sandbox ? { sandbox: true } : {} },
    }),
    [`GET /api/ops/clients/${CLIENT}/records`]: () => ({
      counts: { transactions: 0, vendors: 0, items: 0, receivables: 0 },
      lastSyncAt: null,
      sources: [],
      total: 0,
      offset: 0,
      limit: 50,
      page: { kind: "transactions", rows: [] },
    }),
    [`POST /api/ops/clients/${CLIENT}/sample-company`]: ({ init }) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return post(body);
    },
  });
  render(
    <MemoryRouter initialEntries={[`/ops/clients/${CLIENT}/records`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return { api, bodies };
}

describe("the Sandbox's sample company", () => {
  it("words the counts, leaving out kinds with none", () => {
    expect(sampleCounts({ ...COUNTS, ledgerNotes: 0, contacts: 1 })).toBe(
      "8 vendors · 12 organizations · 1 person · 22 accounts · 15 master items · 20 vendor items · 10 bills and purchases",
    );
  });

  it("sets it up with the operator as an employee, then shows the counts and the employees", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const { bodies } = renderRecords(true, () => (++calls === 1 ? result(COUNTS) : result(NONE)));
    const card = await screen.findByTestId("ops-sample-company", {}, { timeout: 10_000 });
    expect(card).toHaveTextContent("Every name, address and number is made up");
    // An email without a name: the button waits for the name.
    await user.type(within(card).getByTestId("ops-sample-company-email"), "pat@mezonas.test");
    expect(within(card).getByTestId("ops-sample-company-run")).toBeDisabled();
    await user.type(within(card).getByTestId("ops-sample-company-name"), "Pat Operator");
    await user.type(within(card).getByTestId("ops-sample-company-phone"), "(512) 555-0177");
    await user.click(within(card).getByTestId("ops-sample-company-run"));
    const counts = await within(card).findByTestId("ops-sample-company-counts");
    expect(counts).toHaveTextContent(
      "Ridgeline Builders is in the Sandbox: 8 vendors · 12 organizations · 16 people",
    );
    expect(bodies).toEqual([
      { you: { name: "Pat Operator", email: "pat@mezonas.test", phone: "(512) 555-0177" } },
    ]);
    const employees = within(card).getByTestId("ops-sample-company-employees");
    expect(employees).toHaveTextContent("Dana Whitfield, Owner · dana@ridgeline.example.com");
    expect(employees).toHaveTextContent("Pat Operator (you) · pat@mezonas.test · +15125550177");
    expect(within(card).getByTestId("ops-sample-company-examples")).toHaveTextContent(
      "A SKU at Northfork Lumber: NF-BB34",
    );

    // Again: nothing added.
    await user.click(within(card).getByTestId("ops-sample-company-run"));
    await waitFor(() =>
      expect(within(card).getByTestId("ops-sample-company-counts")).toHaveTextContent(
        "Already set up: 8 vendors",
      ),
    );
  });

  it("sends no one when no name is given, and shows a refusal in the API's words", async () => {
    const user = userEvent.setup();
    const { bodies } = renderRecords(
      true,
      () =>
        new Reply(403, {
          error: {
            code: "not_sandbox",
            message: "the sample company is set up in the Sandbox client only",
          },
        }),
    );
    const card = await screen.findByTestId("ops-sample-company", {}, { timeout: 10_000 });
    await user.click(within(card).getByTestId("ops-sample-company-run"));
    await waitFor(() => expect(bodies).toEqual([{}]));
    expect(await within(card).findByRole("alert")).toBeInTheDocument();
    expect(within(card).queryByTestId("ops-sample-company-result")).not.toBeInTheDocument();
  });

  it("isn't on a real client's Records page", async () => {
    renderRecords(false, () => result(COUNTS));
    await screen.findByTestId("ops-records-empty", {}, { timeout: 10_000 });
    expect(screen.queryByTestId("ops-sample-company")).not.toBeInTheDocument();
  });
});
