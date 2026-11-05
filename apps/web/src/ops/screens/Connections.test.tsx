// The back office's Connections page for the Sandbox client (docs/plan.md §1.5): the operator
// connects a no-sign-in tool, signs in to an offered OAuth tool with their own account (the API
// answers where the provider's sign-in starts), sees "Not available yet" for one this deployment
// can't sign in to, and no Connect at all in a real client.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply, SANDBOX_DETAIL } from "../../test/fixtures";

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

  it("sends a test email from the Sandbox's Gmail, with an empty body, and says where it went", async () => {
    const GMAIL = "00000000-0000-4000-8000-0000000000e1";
    const gmail = (over: Record<string, unknown> = {}) => ({
      id: GMAIL,
      tenantId: SANDBOX,
      connector: "gmail",
      status: "connected",
      externalAccountId: "operator@gmail.test",
      config: { address: "operator@gmail.test", scopes: ["gmail.send"] },
      permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
      lastSyncAt: null,
      connectedBy: OPERATOR_SESSION.user.id,
      createdAt: "2026-11-05T18:00:00.000Z",
      ...over,
    });
    const bodies: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${SANDBOX}/connections`]: () =>
        connections({ offered: ["gmail"], connections: [gmail()] }),
      [`POST /api/ops/clients/${SANDBOX}/connections/gmail/test-send`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return { to: "operator@gmail.test", sentAt: "2026-11-05T18:05:00.000Z" };
      },
    });
    const view = renderAt(`/ops/clients/${SANDBOX}/connections`, api);
    const card = await screen.findByTestId(`ops-connection-${GMAIL}`);
    const button = within(card).getByTestId("ops-gmail-test-send");
    expect(button).toHaveTextContent("Send a test email");
    expect(button.className).toContain("ds-btn--secondary");
    await userEvent.setup().click(button);
    expect(await within(card).findByTestId("ops-gmail-test-sent")).toHaveTextContent(
      "Sent to operator@gmail.test. Check that mailbox's Sent folder and inbox.",
    );
    expect(bodies).toEqual([{}]);
    view.unmount();

    // A refusal shows the plain error.
    const failing = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${SANDBOX}/connections`]: () =>
        connections({ offered: ["gmail"], connections: [gmail()] }),
      [`POST /api/ops/clients/${SANDBOX}/connections/gmail/test-send`]: () =>
        new Reply(429, {
          error: {
            code: "rate_limited",
            message: "we sent a test email less than a minute ago; wait a minute and try again",
          },
        }),
    });
    const second = renderAt(`/ops/clients/${SANDBOX}/connections`, failing);
    const again = await screen.findByTestId(`ops-connection-${GMAIL}`);
    await userEvent.setup().click(within(again).getByTestId("ops-gmail-test-send"));
    expect(await within(again).findByRole("alert")).toHaveTextContent(
      "we sent a test email less than a minute ago; wait a minute and try again",
    );
    second.unmount();

    // Disconnected: no button.
    failing.on(`GET /api/ops/clients/${SANDBOX}/connections`, () =>
      connections({ offered: ["gmail"], connections: [gmail({ status: "disconnected" })] }),
    );
    renderAt(`/ops/clients/${SANDBOX}/connections`, failing);
    const off = await screen.findByTestId(`ops-connection-${GMAIL}`);
    expect(within(off).queryByTestId("ops-gmail-test-send")).toBeNull();
  });

  it("offers no Gmail test email in a real client", async () => {
    const GMAIL = "00000000-0000-4000-8000-0000000000e2";
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}/connections`]: () =>
        connections({
          sandbox: false,
          offered: ["gmail"],
          connections: [
            {
              id: GMAIL,
              tenantId: DEMO,
              connector: "gmail",
              status: "connected",
              externalAccountId: "pat.lee@gmail.test",
              config: {},
              permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
              lastSyncAt: null,
              connectedBy: null,
              createdAt: "2026-11-05T18:00:00.000Z",
            },
          ],
        }),
    });
    renderAt(`/ops/clients/${DEMO}/connections`, api);
    const card = await screen.findByTestId(`ops-connection-${GMAIL}`);
    expect(within(card).queryByTestId("ops-gmail-test-send")).toBeNull();
  });

  it("disconnects a Sandbox tool after a confirm step, and offers no Disconnect in a real client", async () => {
    const QBO = "00000000-0000-4000-8000-0000000000f1";
    const row = (tenantId: string, status = "connected") => ({
      id: QBO,
      tenantId,
      connector: "qbo",
      status,
      externalAccountId: "9341458640918607",
      config: {},
      permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
      lastSyncAt: null,
      connectedBy: OPERATOR_SESSION.user.id,
      createdAt: "2026-11-05T18:00:00.000Z",
    });
    let status = "connected";
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${SANDBOX}/connections`]: () =>
        connections({ offered: ["qbo"], connections: [row(SANDBOX, status)] }),
      [`DELETE /api/ops/clients/${SANDBOX}/connections/${QBO}`]: () => {
        status = "disconnected";
        return { connection: row(SANDBOX, status) };
      },
    });
    const view = renderAt(`/ops/clients/${SANDBOX}/connections`, api);
    const card = await screen.findByTestId(`ops-connection-${QBO}`);
    const user = userEvent.setup();

    // Cancel first: nothing is called.
    await user.click(within(card).getByTestId("ops-connection-disconnect-start"));
    expect(within(card).getByTestId("ops-connection-disconnect-confirm-box")).toHaveTextContent(
      "Agents stop using QuickBooks Online until you connect it again.",
    );
    await user.click(within(card).getByTestId("ops-connection-disconnect-cancel"));
    expect(api.calls).not.toContain(`DELETE /api/ops/clients/${SANDBOX}/connections/${QBO}`);

    await user.click(within(card).getByTestId("ops-connection-disconnect-start"));
    await user.click(within(card).getByTestId("ops-connection-disconnect-confirm"));
    expect(api.calls).toContain(`DELETE /api/ops/clients/${SANDBOX}/connections/${QBO}`);
    // Reloaded as disconnected: no Disconnect left.
    await waitFor(() =>
      expect(
        within(screen.getByTestId(`ops-connection-${QBO}`)).queryByTestId(
          "ops-connection-disconnect-start",
        ),
      ).toBeNull(),
    );
    view.unmount();

    const real = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}/connections`]: () =>
        connections({ sandbox: false, offered: ["qbo"], connections: [row(DEMO)] }),
    });
    renderAt(`/ops/clients/${DEMO}/connections`, real);
    const theirs = await screen.findByTestId(`ops-connection-${QBO}`);
    expect(within(theirs).queryByTestId("ops-connection-disconnect-start")).toBeNull();
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
