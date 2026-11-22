// The back office's Connections page for the Sandbox client (docs/plan.md §1.5): the operator
// connects a no-sign-in tool, signs in to an offered OAuth tool with their own account (the API
// answers where the provider's sign-in starts), sees "Not available yet" for one this deployment
// can't sign in to, and no Connect at all in a real client.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import {
  fakeApi as baseFakeApi,
  OPERATOR_SESSION,
  Reply,
  SANDBOX_DETAIL,
} from "../../test/fixtures";
import { connectorFits, operatorBlurb } from "./Connections";

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

type Routes = Parameters<typeof baseFakeApi>[0];
type Handler = Routes[string];
const OLD = /^GET \/api\/ops\/clients\/([^/]+)\/connections$/;

/**
 * Connectors C6: the tab reads its connectors from `/connectors`; these tests describe the older
 * list, so the tab's answer is made from it (one card per connection, its account as the API
 * names it, never the realm id).
 */
function tabOf(old: ReturnType<typeof connections>) {
  const list = old.connections as {
    id: string;
    connector: string;
    status: string;
    externalAccountId: string | null;
    config: Record<string, unknown>;
    lastSyncAt: string | null;
  }[];
  const usedBy = old.usedBy as Record<string, { id: string; name: string }[]>;
  const names = Object.fromEntries(
    (old.connectors as { id: string; name: string }[]).map((c) => [c.id, c.name]),
  );
  return {
    connected: list.map((c) => ({
      connector: c.connector,
      name: names[c.connector] ?? c.connector,
      description: "",
      icon: null,
      auth: "oauth2",
      personal: false,
      multiple: false,
      available: true,
      beta: false,
      recommended: false,
      custom: false,
      group: "Other",
      connections: [
        {
          id: c.id,
          status: c.status,
          accountName:
            typeof c.config.accountName === "string"
              ? c.config.accountName
              : c.externalAccountId?.includes("@")
                ? c.externalAccountId
                : null,
          lastSyncAt: c.lastSyncAt,
          usedBy: usedBy[c.id] ?? [],
          access: { reads: 1, changesAsk: 2, changesAuto: 0 },
          needsSomething: false,
          openRequest: false,
          mezonasMay: null,
        },
      ],
    })),
    builtForYou: [],
    recommended: [],
    requests: [],
    agents: [],
    sandbox: old.sandbox,
  };
}

const tabHandler =
  (handler: Handler): Handler =>
  (req) => {
    const old = handler(req);
    return old instanceof Reply ? old : tabOf(old as ReturnType<typeof connections>);
  };

function fakeApi(routes: Routes) {
  const extra: Routes = {};
  for (const [key, handler] of Object.entries(routes)) {
    const m = OLD.exec(key);
    if (m) extra[`GET /api/ops/clients/${m[1]}/connectors`] = tabHandler(handler);
  }
  const api = baseFakeApi({ ...routes, ...extra });
  const on = api.on;
  api.on = (route, handler) => {
    on(route, handler);
    const m = OLD.exec(route);
    if (m) on(`GET /api/ops/clients/${m[1]}/connectors`, tabHandler(handler));
  };
  return api;
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

describe("a connector's description in the back office", () => {
  it("leaves out what its manifest says to the client, and speaks of them", () => {
    expect(
      operatorBlurb(
        "Bills, purchases and vendors in your QuickBooks Online. You sign in to QuickBooks yourself.",
      ),
    ).toBe("Bills, purchases and vendors in their QuickBooks Online.");
    expect(
      operatorBlurb(
        "Read the transactions of your bank accounts. You connect them yourself. Nothing here can move money.",
      ),
    ).toBe("Read the transactions of their bank accounts. Nothing here can move money.");
    expect(operatorBlurb("Upload tools.")).toBe("Upload tools.");
    expect(operatorBlurb("Your Podio workspaces, apps and items.")).toBe(
      "Their Podio workspaces, apps and items.",
    );
    expect(
      operatorBlurb("Read and add rows in the Google Sheets you pick. We can open only those."),
    ).toBe("Read and add rows in the Google Sheets they pick. We can open only those.");
    expect(
      operatorBlurb("Post to your LinkedIn page. We can't read your messages or post as you."),
    ).toBe("Post to their LinkedIn page. We can't read their messages or post as them.");
  });
});

describe("what fits a client", () => {
  const area = (over: Record<string, unknown>) => ({
    id: "materials",
    name: "Materials",
    area: "Purchasing",
    description: "",
    enabled: true,
    enabledAt: null,
    screens: [],
    connections: [
      { connectors: ["qbo"], use: "Bills and vendors" },
      { connectors: ["gmail", "outlook"], use: "Asking vendors" },
    ],
    config: { fields: [], values: {} },
    processors: [],
    ...over,
  });
  const agent = (name: string, connector: string) => ({
    agent: { id: "00000000-0000-4000-8000-0000000000b1", name },
    ready: false,
    gaps: [
      {
        kind: "not_connected",
        connector,
        connectorName: connector,
        connectionId: null,
        blocking: true,
        fixBy: "client",
        needs: [],
      },
    ],
  });

  it("is what the areas it has on and its agents need, never one it has connected", () => {
    const fits = connectorFits({
      areas: [area({}), area({ id: "marketing", area: "Marketing", enabled: false })],
      agents: [agent("Buyer", "slack")] as never,
      connected: new Set(["qbo"]),
    });
    expect([...fits.keys()].sort()).toEqual(["gmail", "outlook", "slack"]);
    expect(fits.get("gmail")).toEqual(["Their Purchasing area uses it"]);
    expect(fits.get("slack")).toEqual(["Buyer needs it"]);
  });

  it("asks nothing more of a need one alternative meets, and nothing with no signal", () => {
    expect([
      ...connectorFits({
        areas: [area({})],
        agents: [],
        connected: new Set(["qbo", "outlook"]),
      }).keys(),
    ]).toEqual([]);
    expect(connectorFits({ areas: [], agents: [], connected: new Set() }).size).toBe(0);
  });
});

describe("what we recommend to a real client", () => {
  const real = (over: Record<string, unknown> = {}) => ({
    ...connections({ offered: [] }),
    sandbox: false,
    connectors: [
      connector("qbo", "QuickBooks Online", "oauth2", true),
      connector("gmail", "Gmail", "oauth2", true),
      connector("slack", "Slack", "oauth2", true),
      connector("zoho_crm", "Zoho CRM", "oauth2", true),
    ],
    connections: [
      {
        id: "00000000-0000-4000-8000-0000000000c9",
        tenantId: SANDBOX,
        connector: "qbo",
        status: "connected",
        externalAccountId: "9341458640918607",
        config: { accountName: "Hartley Millwork LLC" },
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
    ...over,
  });
  const packs = {
    packs: [
      {
        id: "materials",
        name: "Materials",
        area: "Purchasing",
        description: "",
        enabled: true,
        enabledAt: null,
        screens: [],
        connections: [
          { connectors: ["qbo"], use: "Bills and vendors" },
          { connectors: ["gmail"], use: "Asking vendors" },
        ],
      },
    ],
  };

  it("lists what fits and what we recommend, never a connected one; the rest is one click away", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${SANDBOX}/packs`]: () => packs,
      [`GET /api/ops/clients/${SANDBOX}/connections`]: () => real({ offered: ["slack"] }),
    });
    renderAt(`/ops/clients/${SANDBOX}/connections`, api);
    const offering = await screen.findByTestId("ops-connections-offering", {}, { timeout: 10_000 });
    await waitFor(() =>
      expect(within(offering).getByTestId("ops-connections-offer-gmail-why")).toHaveTextContent(
        "Their Purchasing area uses it",
      ),
    );
    expect(within(offering).getByTestId("ops-connections-offer-slack-toggle")).toBeChecked();
    expect(within(offering).queryByTestId("ops-connections-offer-qbo-toggle")).toBeNull();
    expect(within(offering).queryByTestId("ops-connections-offer-zoho_crm-toggle")).toBeNull();
    const more = within(offering).getByTestId("ops-connections-offering-more");
    expect(more).toHaveTextContent("Recommend another connector · 1 more");
    await userEvent.setup().click(more);
    expect(within(offering).getByTestId("ops-connections-offer-zoho_crm-toggle")).not.toBeChecked();
    expect(within(offering).queryByTestId("ops-connections-offer-qbo-toggle")).toBeNull();
  });

  it("recommends none when nothing fits and nothing is recommended", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${SANDBOX}/packs`]: () => ({ packs: [] }),
      [`GET /api/ops/clients/${SANDBOX}/connections`]: () => real(),
    });
    renderAt(`/ops/clients/${SANDBOX}/connections`, api);
    const offering = await screen.findByTestId("ops-connections-offering", {}, { timeout: 10_000 });
    expect(within(offering).getByTestId("ops-connections-offering-none")).toHaveTextContent(
      "None recommended.",
    );
    expect(within(offering).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(offering).getByTestId("ops-connections-offering-more")).toHaveTextContent(
      "3 more",
    );
  });

  it("names the tools offered with the right plural and how the client connects", async () => {
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${SANDBOX}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${SANDBOX}/connections`]: () => ({
        ...connections({ offered: ["qbo"] }),
        sandbox: false,
        connectors: [
          {
            ...connector("qbo", "QuickBooks Online", "oauth2", true),
            description: "Bills in your QuickBooks Online. You sign in to QuickBooks yourself.",
            tools: [
              { id: "qbo.bill.get", description: "Get a bill", verb: "read", sideEffect: "none" },
            ],
          },
        ],
      }),
    });
    renderAt(`/ops/clients/${SANDBOX}/connections`, api);
    const offering = await screen.findByTestId("ops-connections-offering", {}, { timeout: 10_000 });
    expect(offering).toHaveTextContent("Bills in their QuickBooks Online.");
    expect(offering).not.toHaveTextContent("your");
    expect(offering).not.toHaveTextContent("yourself");
    expect(offering).toHaveTextContent("1 tool · the client signs in from their portal");
    expect(offering).not.toHaveTextContent("oauth2");
  });
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
    expect(screen.getByTestId("ops-connections-list")).toHaveTextContent("Sandbox Company_US_1");
  });

  it("names a QuickBooks connection by its company, never its realm id, and links to what it synced", async () => {
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
    // The provider's company id (the realm) never shows.
    expect(card).not.toHaveTextContent("9341458640918607");
    expect(within(card).getByTestId("ops-connection-records")).toHaveAttribute(
      "href",
      `/ops/clients/${DEMO}/records?source=${CONN}`,
    );
    view.unmount();

    // No company name and never synced: no account line (never the realm id), and no link to an
    // empty list.
    api.on(`GET /api/ops/clients/${DEMO}/connections`, () =>
      connections({ sandbox: false, connections: [qbo({ config: {}, lastSyncAt: null })] }),
    );
    renderAt(`/ops/clients/${DEMO}/connections`, api);
    const bare = await screen.findByTestId(`ops-connection-${CONN}`);
    expect(within(bare).queryByTestId("ops-connection-account")).toBeNull();
    expect(bare).not.toHaveTextContent("9341458640918607");
    expect(within(bare).queryByTestId("ops-connection-records")).toBeNull();
  });

  it("shows upload's last document and the agents its documents start, not 'never synced'", async () => {
    const UPLOAD = "00000000-0000-4000-8000-0000000000f1";
    const upload = (over: Record<string, unknown> = {}) => ({
      id: UPLOAD,
      tenantId: DEMO,
      connector: "upload",
      status: "connected",
      externalAccountId: null,
      config: {},
      permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
      lastSyncAt: null,
      lastActivityAt: "2026-11-05T12:41:00.000Z",
      connectedBy: null,
      createdAt: "2026-11-05T12:00:00.000Z",
      ...over,
    });
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${DEMO}/connections`]: () =>
        connections({
          sandbox: false,
          connections: [upload()],
          connectors: [connector("upload", "Upload", "none", true)],
          usedBy: { [UPLOAD]: [{ id: "a1", name: "Bill clerk" }] },
        }),
    });
    const view = renderAt(`/ops/clients/${DEMO}/connections`, api);
    const card = await screen.findByTestId(`ops-connection-${UPLOAD}`);
    expect(card).toHaveTextContent("last document");
    expect(card).not.toHaveTextContent("never synced");
    expect(card).toHaveTextContent("Used by Bill clerk");
    view.unmount();

    api.on(`GET /api/ops/clients/${DEMO}/connections`, () =>
      connections({
        sandbox: false,
        connections: [upload({ lastActivityAt: null })],
        connectors: [connector("upload", "Upload", "none", true)],
      }),
    );
    renderAt(`/ops/clients/${DEMO}/connections`, api);
    expect(await screen.findByTestId(`ops-connection-${UPLOAD}`)).toHaveTextContent(
      "no documents yet",
    );
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
