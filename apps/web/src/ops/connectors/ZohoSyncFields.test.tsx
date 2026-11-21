// docs/plan.md §1.164 step 3 ("Zoho's fields"): a Zoho CRM connection's page lists the client's
// own Zoho fields per module; choosing one adds it to the setup draft (`syncFields`), which the
// footer previews like any setup change; a sign-in without the field scope says so.
import type { ConnectorCardView, OpsConnectionPageView, ZohoFieldsView } from "@countersign/core";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";
import { syncFieldsOf, toggleSyncField } from "./ZohoSyncFields";

const CLIENT = "00000000-0000-4000-8000-00000000a002";
const CONN = "00000000-0000-4000-8000-0000000000c9";
const AT = "2026-11-20T12:00:00.000Z";

const field = (
  apiName: string,
  label: string,
  over: Partial<ZohoFieldsView["modules"][number]["fields"][number]> = {},
) => ({
  apiName,
  label,
  dataType: "text",
  custom: false,
  readOnly: false,
  mandatory: false,
  picklist: null,
  maxLength: 120,
  ...over,
});

function fieldsView(over: Partial<ZohoFieldsView> = {}): ZohoFieldsView {
  return {
    status: "ok",
    readAt: AT,
    modules: [
      {
        module: "Leads",
        fields: [
          field("Email", "Email", { dataType: "email" }),
          field("Region", "Sales region", {
            dataType: "picklist",
            custom: true,
            picklist: ["North", "South"],
          }),
          field("Last_Import_Date", "Last import date", { dataType: "date", custom: true }),
        ],
        standard: ["Email"],
        room: 40,
      },
      { module: "Deals", fields: [], standard: ["Deal_Name"], room: 41 },
    ],
    syncFields: {},
    ...over,
  };
}

function card(): ConnectorCardView {
  return {
    connector: "zoho_crm",
    name: "Zoho CRM",
    description: "Leads, contacts, accounts and deals.",
    icon: null,
    auth: "oauth2",
    personal: false,
    multiple: false,
    available: true,
    beta: false,
    recommended: false,
    custom: false,
    group: "Sales",
    connections: [],
  };
}

function page(config: Record<string, unknown>) {
  const connection: OpsConnectionPageView = {
    id: CONN,
    status: "connected",
    accountName: "Hartley Millwork",
    lastSyncAt: AT,
    connectedByYou: false,
    read: [],
    change: [],
    access: { reads: 4, changesAsk: 4, changesAuto: 0 },
    usedBy: [],
    mezonasMay: null,
    openRequest: null,
    history: [],
    config,
  };
  return {
    connector: card(),
    permissionEntities: [],
    connections: [connection],
    forAgent: null,
    sandbox: false,
  };
}

function renderPage(fields: ZohoFieldsView, previews: unknown[] = []) {
  const config = { dataCenter: "eu", apiDomain: "https://www.zohoapis.eu" };
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${CLIENT}`]: () => ({
      client: {
        id: CLIENT,
        name: "Hartley Millwork",
        timezone: "UTC",
        settings: {},
        createdAt: AT,
      },
      agents: [],
      connections: [],
      members: [],
    }),
    [`GET /api/ops/clients/${CLIENT}/connections`]: () => ({
      connections: [],
      offered: [],
      connectors: [],
      usedBy: {},
      sandbox: false,
    }),
    [`GET /api/ops/clients/${CLIENT}/connectors/zoho_crm`]: () => page(config),
    [`GET /api/ops/clients/${CLIENT}/connections/${CONN}/zoho-fields`]: () => fields,
    [`POST /api/ops/clients/${CLIENT}/connections/${CONN}/changes/preview`]: ({ init }) => {
      previews.push(JSON.parse(String(init.body)));
      return { direction: "looser", rows: [], outcome: "request", whyNot: null, mezonasMay: null };
    },
  });
  render(
    <MemoryRouter initialEntries={[`/ops/clients/${CLIENT}/connectors/zoho_crm`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("Zoho's sync fields", () => {
  it("adds and removes a field in the setup's syncFields", () => {
    const base = { dataCenter: "eu" };
    const one = toggleSyncField(base, "Leads", "Region", true);
    expect(one).toEqual({ dataCenter: "eu", syncFields: { Leads: ["Region"] } });
    expect(toggleSyncField(one, "Leads", "Region", true)).toEqual(one);
    expect(toggleSyncField(one, "Leads", "Region", false)).toEqual(base);
    expect(syncFieldsOf({ syncFields: { Leads: ["A", 3] } })).toEqual({ Leads: ["A"] });
    expect(syncFieldsOf({ syncFields: "A" })).toEqual({});
  });

  it("lists the client's own fields by label, and a choice goes through the setup's preview", async () => {
    const previews: unknown[] = [];
    renderPage(fieldsView(), previews);
    const section = await screen.findByTestId(`ops-zoho-fields-${CONN}`, {}, { timeout: 10_000 });
    const leads = await within(section).findByTestId(`ops-zoho-fields-${CONN}-Leads`);
    expect(leads).toHaveTextContent("Sales region");
    expect(leads).toHaveTextContent("0 of 40 added");
    // A field the sync reads anyway isn't offered.
    expect(within(leads).queryByTestId(`ops-zoho-fields-${CONN}-Leads-Email`)).toBeNull();
    const user = userEvent.setup();
    await user.click(within(leads).getByTestId(`ops-zoho-fields-${CONN}-Leads-Region`));
    await waitFor(() =>
      expect(previews.at(-1)).toEqual({
        config: {
          dataCenter: "eu",
          apiDomain: "https://www.zohoapis.eu",
          syncFields: { Leads: ["Region"] },
        },
      }),
    );
    expect(await screen.findByTestId("ops-change-footer")).toBeInTheDocument();
  });

  it("says when the sign-in can't read Zoho's fields", async () => {
    renderPage(fieldsView({ status: "needs_sign_in", readAt: AT, modules: [] }));
    expect(
      await screen.findByTestId(`ops-zoho-fields-${CONN}-sign-in`, {}, { timeout: 10_000 }),
    ).toHaveTextContent("Hartley Millwork needs to sign in to Zoho again");
  });
});
