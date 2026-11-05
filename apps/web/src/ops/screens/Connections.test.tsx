// The back office's Connections page for the Sandbox client (docs/plan.md §1.5): the operator
// connects a no-sign-in tool, signs in to an offered OAuth tool with their own account (the API
// answers where the provider's sign-in starts), sees "Not available yet" for one this deployment
// can't sign in to, and no Connect at all in a real client.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, SANDBOX_DETAIL } from "../../test/fixtures";

const SANDBOX = "00000000-0000-4000-8000-00000000a001";
const DEMO = "00000000-0000-4000-8000-00000000a002";

const connector = (id: string, name: string, auth: string, available: boolean) => ({
  id,
  name,
  description: `${name} tools.`,
  icon: null,
  auth,
  available,
  tools: [],
});

function connections(over: Record<string, unknown> = {}) {
  return {
    connections: [],
    offered: ["qbo", "zoho_crm"],
    connectors: [
      connector("testkit", "Testkit", "none", true),
      connector("qbo", "QuickBooks Online", "oauth2", true),
      connector("zoho_crm", "Zoho CRM", "oauth2", false),
      connector("gmail", "Gmail", "oauth2", true),
    ],
    usedBy: {},
    sandbox: true,
    ...over,
  };
}

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ops connections: the Sandbox client", () => {
  it("signs the operator in to an offered OAuth tool, and starts the provider's sign-in", async () => {
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${SANDBOX}/connections`]: () => connections(),
      [`POST /api/ops/clients/${SANDBOX}/connections/qbo/authorize`]: () => ({
        redirectUrl: "https://appcenter.intuit.com/connect/oauth2?client_id=x&state=s",
      }),
    });
    renderAt(`/ops/clients/${SANDBOX}/connections`, api);
    const offering = await screen.findByTestId("ops-connections-offering");

    // Configured and offered: Connect. Not configured: not available yet. Not offered: nothing.
    expect(within(offering).getByTestId("ops-connections-unavailable-zoho_crm")).toHaveTextContent(
      "Not available yet",
    );
    expect(within(offering).queryByTestId("ops-connections-connect-zoho_crm")).toBeNull();
    expect(within(offering).queryByTestId("ops-connections-connect-gmail")).toBeNull();
    expect(within(offering).getByTestId("ops-connections-connect-testkit")).toBeInTheDocument();

    await userEvent.setup().click(within(offering).getByTestId("ops-connections-connect-qbo"));
    expect(api.calls).toContain(`POST /api/ops/clients/${SANDBOX}/connections/qbo/authorize`);
    expect(assign).toHaveBeenCalledWith(
      "https://appcenter.intuit.com/connect/oauth2?client_id=x&state=s",
    );
  });

  it("shows a connected OAuth tool as connected", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${SANDBOX}/connections`]: () =>
        connections({
          connections: [
            {
              id: "00000000-0000-4000-8000-0000000000c9",
              tenantId: SANDBOX,
              connector: "qbo",
              status: "connected",
              externalAccountId: "9341458640918607",
              config: { accountName: "Sandbox Company_US_1" },
              permissions: {
                read: "auto",
                create: "approval",
                update: "approval",
                delete: "off",
                scope: null,
              },
              lastSyncAt: null,
              connectedBy: OPERATOR_SESSION.user.id,
              createdAt: "2026-11-05T18:00:00.000Z",
            },
          ],
        }),
    });
    renderAt(`/ops/clients/${SANDBOX}/connections`, api);
    const offering = await screen.findByTestId("ops-connections-offering");
    expect(within(offering).queryByTestId("ops-connections-connect-qbo")).toBeNull();
    expect(screen.getByTestId("ops-connections-list")).toHaveTextContent("9341458640918607");
  });

  it("names a QuickBooks connection by its company, with the realm id under it, and links to what it synced", async () => {
    const CONN = "00000000-0000-4000-8000-0000000000d1";
    const qbo = (over: Record<string, unknown>) => ({
      id: CONN,
      tenantId: DEMO,
      connector: "qbo",
      status: "connected",
      externalAccountId: "9341458640918607",
      config: { accountName: "Sandbox Company_US_1" },
      permissions: {
        read: "auto",
        create: "approval",
        update: "approval",
        delete: "off",
        scope: null,
      },
      lastSyncAt: "2026-11-05T12:41:00.000Z",
      connectedBy: null,
      createdAt: "2026-11-05T12:00:00.000Z",
      ...over,
    });
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}/connections`]: () =>
        connections({ sandbox: false, connections: [qbo({})] }),
    });
    const view = renderAt(`/ops/clients/${DEMO}/connections`, api);
    const card = await screen.findByTestId(`ops-connection-${CONN}`);
    expect(within(card).getByTestId("ops-connection-account")).toHaveTextContent(
      /^Sandbox Company_US_1$/,
    );
    expect(card).toHaveTextContent("9341458640918607");
    expect(within(card).getByTestId("ops-connection-records")).toHaveAttribute(
      "href",
      `/ops/clients/${DEMO}/records?source=${CONN}`,
    );
    view.unmount();

    // No company name and never synced: the realm id, and no link to an empty list.
    api.on(`GET /api/ops/clients/${DEMO}/connections`, () =>
      connections({ sandbox: false, connections: [qbo({ config: {}, lastSyncAt: null })] }),
    );
    renderAt(`/ops/clients/${DEMO}/connections`, api);
    const bare = await screen.findByTestId(`ops-connection-${CONN}`);
    expect(within(bare).getByTestId("ops-connection-account")).toHaveTextContent(
      /^9341458640918607$/,
    );
    expect(within(bare).queryByTestId("ops-connection-records")).toBeNull();
  });

  it("offers no Connect in a real client", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}/connections`]: () => connections({ sandbox: false }),
    });
    renderAt(`/ops/clients/${DEMO}/connections`, api);
    const offering = await screen.findByTestId("ops-connections-offering");
    expect(within(offering).queryByRole("button", { name: "Connect" })).toBeNull();
    expect(within(offering).queryByText("Not available yet")).toBeNull();
  });
});
