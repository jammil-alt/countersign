// Human release on the portal (docs/plan.md §1.26, phase 4): the client admin turns it on with a
// person, a channel and a window (texts only to someone a text can reach), revokes live releases
// and turns it off; a client user only reads. In the inbox, the person the code went to enters it:
// a wrong code says how many tries are left, the right one releases, a new code can be asked for,
// and the item has no approve or answer buttons. Anyone else sees that only that person can.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const DEMO = CLIENT_SESSION.activeTenantId as string;
const CONN = "00000000-0000-4000-8000-0000000c0001";
const AGENT = "00000000-0000-4000-8000-0000000a0001";
const ANA = "00000000-0000-4000-8000-0000000b0001";
const BEN = "00000000-0000-4000-8000-0000000b0002";
const LIVE = "00000000-0000-4000-8000-0000000d0001";
const ITEM = "00000000-0000-4000-8000-0000000e0001";
const RUN = "00000000-0000-4000-8000-0000000f0001";

const overview = {
  client: { id: DEMO, name: "Demo client" },
  services: [],
  needsYou: { inbox: 1 },
  recentRuns: [],
};

const PEOPLE = [
  { id: ANA, name: "Ana Ruiz", email: "a•••@demo.example.com", canText: true },
  { id: BEN, name: "Ben Ode", email: "b•••@demo.example.com", canText: false },
];

function release(on: boolean) {
  return on
    ? {
        mode: "code",
        person: { id: ANA, name: "Ana Ruiz" },
        channel: "sms",
        window: "run",
        sentTo: "•••0142",
        updatedAt: "2026-11-05T10:00:00.000Z",
        live: [
          {
            id: LIVE,
            connectionId: CONN,
            agentId: AGENT,
            agentName: "Intake",
            person: { id: ANA, name: "Ana Ruiz" },
            channel: "sms",
            runId: RUN,
            releasedAt: "2026-11-05T10:05:00.000Z",
            validUntil: null,
          },
        ],
      }
    : {
        mode: "off",
        person: null,
        channel: "email",
        window: "run",
        sentTo: null,
        updatedAt: null,
        live: [],
      };
}

function vault(on: boolean) {
  return {
    connectionId: CONN,
    connector: "qbo",
    name: "QuickBooks",
    kind: "oauth",
    status: "connected",
    externalAccountId: null,
    secret: { set: true, fields: [], updatedAt: null },
    credentialForm: false,
    matrix: { read: "auto", create: "approval", update: "approval", delete: "off" },
    tools: [],
    agents: [],
    release: release(on),
  };
}

/** QuickBooks as the Accounts page lists it: connected, so it has its own card. */
const QBO_OFFER = {
  connector: "qbo",
  name: "QuickBooks",
  description: "Bills, vendors and items in QuickBooks Online.",
  icon: null,
  available: true,
  credentialForm: false,
  personal: false,
  connection: {
    id: CONN,
    status: "connected",
    externalAccountId: null,
    accountName: null,
    lastSyncAt: null,
    permissions: { read: "auto", create: "approval", update: "approval", delete: "off" },
    access: [],
    usedBy: [],
    connectedByYou: false,
  },
};

/** Human release is in the tool's card on the Accounts page, open on request. */
async function openQuickBooks() {
  const card = await screen.findByTestId("portal-connection-qbo");
  await userEvent.click(within(card).getByTestId("portal-connection-permissions-toggle"));
}

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  api.on("GET /api/connections", () => ({ connections: [QBO_OFFER] }));
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("human release on the Access page", () => {
  it("turns it on with a person, a channel and a window; texts only reach who can get them", async () => {
    const puts: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/access": () => ({
        items: [vault(puts.length > 0)],
        setup: [],
        canEdit: true,
        people: PEOPLE,
      }),
      [`PUT /api/access/connections/${CONN}/release`]: ({ init }) => {
        puts.push(JSON.parse(String(init.body)));
        return { item: vault(true) };
      },
    });
    renderAt("/access", api);
    await openQuickBooks();
    const section = await screen.findByTestId("release-section");
    expect(within(section).getByTestId("release-summary")).toHaveTextContent(
      "Off: agents use it without asking anyone first.",
    );
    await userEvent.click(within(section).getByTestId("release-edit"));
    await userEvent.selectOptions(within(section).getByTestId("release-person"), BEN);
    await userEvent.selectOptions(within(section).getByTestId("release-channel"), "sms");
    // Ben has no phone that agreed to texts: say so and don't save.
    expect(within(section).getByTestId("release-no-text")).toBeInTheDocument();
    expect(within(section).getByTestId("release-save")).toBeDisabled();
    await userEvent.selectOptions(within(section).getByTestId("release-channel"), "email");
    await userEvent.selectOptions(within(section).getByTestId("release-window"), "4");
    await userEvent.click(within(section).getByTestId("release-save"));
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]).toEqual({
      mode: "code",
      personId: BEN,
      channel: "email",
      window: { hours: 4 },
    });
    await waitFor(() =>
      expect(screen.getByTestId("release-summary")).toHaveTextContent(
        "Ana Ruiz releases it with a code by text, for one run.",
      ),
    );
  });

  it("lists live releases with Revoke, and the client admin turns it off", async () => {
    const calls: string[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/access": () => ({
        items: [vault(true)],
        setup: [],
        canEdit: true,
        people: PEOPLE,
      }),
      [`POST /api/access/releases/${LIVE}/revoke`]: () => {
        calls.push("revoke");
        return { item: vault(true) };
      },
      [`PUT /api/access/connections/${CONN}/release`]: ({ init }) => {
        calls.push(String(init.body));
        return { item: vault(false) };
      },
    });
    renderAt("/access", api);
    await openQuickBooks();
    const live = await screen.findByTestId(`release-live-${LIVE}`);
    expect(live).toHaveTextContent("Intake · released by Ana Ruiz");
    expect(live).toHaveTextContent("For the run under way");
    await userEvent.click(within(live).getByTestId(`release-revoke-${LIVE}`));
    await waitFor(() => expect(calls).toContain("revoke"));
    await userEvent.click(screen.getByTestId("release-turn-off"));
    await waitFor(() => expect(calls).toContain(JSON.stringify({ mode: "off" })));
  });

  it("a client user sees the setting and the live releases, and changes nothing", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: DEMO, name: "Demo client", role: "client_user" }],
      }),
      "GET /api/overview": () => overview,
      "GET /api/access": () => ({ items: [vault(true)], setup: [], canEdit: false, people: [] }),
    });
    renderAt("/access", api);
    await openQuickBooks();
    const section = await screen.findByTestId("release-section");
    expect(section).toHaveTextContent("Ana Ruiz releases it with a code by text, for one run.");
    expect(within(section).getByTestId(`release-live-${LIVE}`)).toBeInTheDocument();
    expect(within(section).queryByTestId("release-edit")).toBeNull();
    expect(within(section).queryByTestId("release-turn-off")).toBeNull();
    expect(within(section).queryByTestId(`release-revoke-${LIVE}`)).toBeNull();
  });
});

describe("entering a code from the inbox", () => {
  const item = {
    id: ITEM,
    kind: "request",
    title: "Enter the code we texted you to let Intake use QuickBooks",
    payload: {
      accessRelease: {
        connectionId: CONN,
        connector: "qbo",
        toolName: "QuickBooks",
        agentName: "Intake",
        tool: "qbo.bill.query",
        channel: "sms",
        window: "run",
        resends: 0,
      },
    },
    status: "open",
    runId: RUN,
    dueAt: "2026-11-05T10:10:00.000Z",
    createdAt: "2026-11-05T10:00:00.000Z",
    resolvedAt: null,
    resolvedBy: null,
  };
  const request = (o: Record<string, unknown> = {}) => ({
    inboxItemId: ITEM,
    status: "pending",
    agentName: "Intake",
    toolName: "QuickBooks",
    channel: "sms",
    sentTo: "•••0142",
    expiresAt: "2026-11-05T10:10:00.000Z",
    triesLeft: 5,
    resendsLeft: 3,
    mine: true,
    ...o,
  });

  it("says how many tries are left after a wrong code, releases on the right one, and re-sends", async () => {
    const sent: unknown[] = [];
    let state = request();
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/inbox": () => ({ items: [item] }),
      [`GET /api/access/requests/${ITEM}`]: () => ({ request: state }),
      [`POST /api/access/requests/${ITEM}/code`]: ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push(body);
        const right = body.code === "246810";
        state = request(right ? { status: "released" } : { triesLeft: 4 });
        return { request: state, result: right ? "released" : "wrong" };
      },
      [`POST /api/access/requests/${ITEM}/resend`]: () => {
        sent.push("resend");
        state = request({ resendsLeft: 2 });
        return { request: state };
      },
    });
    renderAt("/inbox", api);
    const card = await screen.findByTestId(`inbox-item-${ITEM}`);
    const entry = await within(card).findByTestId("release-code-entry");
    expect(within(card).getByTestId("inbox-item-status")).toHaveTextContent("Needs a code");
    expect(entry).toHaveTextContent("We sent a code to •••0142.");
    // Answered only with the code: no approve, decline or answer.
    expect(within(card).queryByTestId("inbox-item-approve")).toBeNull();
    expect(within(card).queryByTestId("inbox-item-decline")).toBeNull();
    expect(within(card).queryByTestId("inbox-item-answer-input")).toBeNull();
    const input = within(entry).getByTestId("release-code-input");
    expect(input).toHaveAttribute("autocomplete", "one-time-code");
    await userEvent.type(input, "12a3456");
    expect(input).toHaveValue("123456");
    await userEvent.click(within(entry).getByTestId("release-code-submit"));
    await waitFor(() =>
      expect(within(entry).getByTestId("release-code-message")).toHaveTextContent(
        "That code isn't right. 4 tries left.",
      ),
    );
    // Nothing typed stays in the page.
    expect(input).toHaveValue("");
    await userEvent.click(within(entry).getByTestId("release-code-resend"));
    await waitFor(() =>
      expect(within(entry).getByTestId("release-code-message")).toHaveTextContent(
        "We sent a new code.",
      ),
    );
    await userEvent.type(input, "246810");
    await userEvent.click(within(entry).getByTestId("release-code-submit"));
    await waitFor(() =>
      expect(within(entry).getByTestId("release-code-message")).toHaveTextContent(
        "Released. The agent goes on.",
      ),
    );
    expect(sent).toEqual([{ code: "123456" }, "resend", { code: "246810" }]);
  });

  it("tells anyone else that only the person the code went to can enter it", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => overview,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/inbox": () => ({ items: [item] }),
      [`GET /api/access/requests/${ITEM}`]: () => ({ request: request({ mine: false }) }),
    });
    renderAt("/inbox", api);
    const card = await screen.findByTestId(`inbox-item-${ITEM}`);
    expect(await within(card).findByTestId("release-code-not-mine")).toHaveTextContent(
      "Only the person we sent the code to can enter it.",
    );
    expect(within(card).queryByTestId("release-code-input")).toBeNull();
  });
});
