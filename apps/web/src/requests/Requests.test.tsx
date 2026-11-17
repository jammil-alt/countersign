// Requests on both surfaces. The client asks from Sloan's "Ask for a change" (`/sloan?mode=change`)
// and follows the reply; §1.123: `/requests` is the client's Requests page (its issues and asks, a
// conversation each), and the back office works them in Build (`/ops/requests` redirects to its
// Issues): the work order with a reason per row, and the issue with its notes kept internal.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply } from "../test/fixtures";

// These two type whole sentences key by key; on a loaded machine 5 s is not enough.
const SLOW = 15_000;
const DEMO = "00000000-0000-4000-8000-00000000a002";
const SERVICE = "00000000-0000-4000-8000-0000000a9001";
const VERSION = "00000000-0000-4000-8000-0000000a9101";
const REQ = "00000000-0000-4000-8000-0000000ae001";

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const portalItem = (over: Record<string, unknown> = {}) => ({
  id: REQ,
  subject: "Add Acme as a vendor",
  text: "We started buying from Acme Lumber.",
  service: { id: SERVICE, name: "Invoice intake" },
  status: "open",
  raisedBy: { id: "u", name: "Demo admin" },
  createdAt: "2026-11-04T10:00:00.000Z",
  resolvedAt: null,
  note: null,
  changes: [],
  ...over,
});

describe("portal requests", () => {
  it("lives in Sloan: /requests opens Ask for a change, and the tabs switch modes", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/requests": () => ({ items: [portalItem()] }),
      "GET /api/threads": () => ({ threads: [] }),
    });
    renderAt("/sloan?mode=change&x=1", api);
    expect(await screen.findByRole("heading", { name: "Sloan", level: 1 })).toBeInTheDocument();
    const modes = screen.getByTestId("portal-sloan-modes");
    expect(within(modes).getByRole("link", { name: "Ask for a change" })).toHaveClass(
      "border-slate",
    );
    expect(await screen.findByTestId(`portal-request-${REQ}`)).toBeInTheDocument();
    expect(screen.queryByTestId("portal-sloan-conversation")).toBeNull();
    await userEvent.click(within(modes).getByRole("link", { name: "Ask Sloan" }));
    expect(await screen.findByTestId("portal-sloan-conversation")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-requests-page")).toBeNull();
  });

  it("sends a request about a service and shows it with us", { timeout: SLOW }, async () => {
    const items: unknown[] = [];
    const sent: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/overview": () => ({
        client: { id: DEMO, name: "Demo client" },
        services: [{ id: SERVICE, name: "Invoice intake", description: null, status: "active" }],
        needsYou: { inbox: 0 },
        recentRuns: [],
      }),
      "GET /api/requests": () => ({ items }),
      "POST /api/requests": ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push(body);
        const item = portalItem();
        items.unshift(item);
        return { item };
      },
    });
    renderAt("/sloan?mode=change", api);
    expect(await screen.findByText(/No requests yet/)).toBeInTheDocument();
    const send = screen.getByTestId("portal-request-send");
    expect(send).toBeDisabled();
    await screen.findByRole("option", { name: "Invoice intake" });
    await userEvent.selectOptions(screen.getByTestId("portal-request-service"), SERVICE);
    await userEvent.type(screen.getByTestId("portal-request-subject"), "Add Acme as a vendor");
    await userEvent.type(
      screen.getByTestId("portal-request-text"),
      "We started buying from Acme Lumber.",
    );
    await userEvent.click(send);
    expect(sent).toEqual([
      {
        text: "We started buying from Acme Lumber.",
        subject: "Add Acme as a vendor",
        serviceId: SERVICE,
      },
    ]);
    const card = await screen.findByTestId(`portal-request-${REQ}`);
    expect(within(card).getByTestId("portal-request-status")).toHaveTextContent("With us");
    expect(within(card).getByTestId("portal-request-status")).toHaveClass("ds-pill--neutral");
    expect(screen.getByTestId("portal-request-sent")).toHaveTextContent("We'll reply here");
    expect(screen.getByTestId("portal-request-text")).toHaveValue("");
  });

  it("shows our reply and what changed", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/overview": () => ({
        client: { id: DEMO, name: "Demo client" },
        services: [],
        needsYou: { inbox: 0 },
        recentRuns: [],
      }),
      "GET /api/requests": () => ({
        items: [
          portalItem({
            status: "done",
            resolvedAt: "2026-11-05T10:00:00.000Z",
            note: "Acme is on the vendor list now.",
            changes: [{ service: { id: SERVICE, name: "Invoice intake" }, version: 4 }],
          }),
        ],
      }),
    });
    renderAt("/sloan?mode=change", api);
    const card = await screen.findByTestId(`portal-request-${REQ}`);
    expect(within(card).getByTestId("portal-request-status")).toHaveClass("ds-pill--positive");
    const reply = within(card).getByTestId("portal-request-reply");
    expect(reply).toHaveTextContent("Acme is on the vendor list now.");
    expect(within(card).getByTestId("portal-request-changes")).toHaveTextContent(
      "Invoice intake: now on version 4",
    );
  });
});

const CLIENT_A = { id: DEMO, name: "Demo client" };
const ISSUE = "00000000-0000-4000-8000-0000000ae101";

const workItem = (over: Record<string, unknown> = {}) => ({
  kind: "issue",
  id: ISSUE,
  number: 7,
  title: "Bookkeeper posted 14 card charges twice",
  description: "The bank re-sent yesterday's file.",
  client: CLIENT_A,
  asks: 0,
  agent: null,
  stage: "cause",
  stageName: "Finding the cause",
  standing: "you",
  statusLine: "Hold on · review",
  urgency: "critical",
  due: "2026-11-17T23:00:00.000Z",
  rank: 1,
  why: "Critical: ahead of everything.",
  moved: false,
  manual: false,
  held: true,
  fromTemplate: false,
  createdAt: "2026-11-17T06:12:00.000Z",
  updatedAt: "2026-11-17T06:12:00.000Z",
  ...over,
});

const hold = {
  agent: { id: SERVICE, name: "Bookkeeper" },
  client: CLIENT_A,
  since: "2026-11-17T06:12:00.000Z",
  by: "reggie",
  reason: "Critical issue #7",
  issueId: ISSUE,
  issueNumber: 7,
  held: { writes: 3, messages: 1 },
};

function buildApi() {
  const sent: unknown[] = [];
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/work": () => ({
      items: [
        workItem(),
        workItem({
          kind: "build",
          id: "00000000-0000-4000-8000-0000000ae201",
          number: null,
          title: "Bookkeeper, fuel by truck",
          urgency: null,
          stage: "trial",
          stageName: "Trial",
          standing: "stalled",
          statusLine: "Held · date at risk",
          rank: 2,
          moved: true,
          why: "Moved up: after the normal issues it would land Nov 27, past the promised Nov 24.",
          due: "2026-11-24",
        }),
      ],
      kpis: [
        { label: "Critical, held", value: "1", note: "Demo client", tone: "risk", href: null },
      ],
      holds: [hold],
      counts: { all: 2, issues: 1, builds: 1, enh: 0 },
    }),
    [`GET /api/ops/issues/${ISSUE}`]: () => ({
      issue: {
        id: ISSUE,
        number: 7,
        client: CLIENT_A,
        title: "Bookkeeper posted 14 card charges twice",
        description: "",
        urgency: "critical",
        stage: "cause",
        causeKind: null,
        agent: { id: SERVICE, name: "Bookkeeper" },
        source: "portal",
        raisedBy: { id: "u", name: "Mike Ochoa" },
        waitingOn: "operator",
        statusLine: "",
        stuck: false,
        standing: "stalled",
        replyBy: null,
        fixBy: "2026-11-17T23:00:00.000Z",
        firstReplyAt: null,
        reggieRead: null,
        askId: null,
        createdAt: "2026-11-17T06:12:00.000Z",
        stageAt: "2026-11-17T06:12:00.000Z",
        closedAt: null,
      },
      messages: [
        {
          id: "m1",
          at: "2026-11-17T06:20:00.000Z",
          audience: "operator",
          who: { kind: "operator", name: "Operator" },
          text: "v7 matches on id only.",
          sources: [],
        },
      ],
      events: [],
      todos: [
        {
          id: "t1",
          owner: "operator",
          title: "Tell Demo client about the safety hold",
          dueAt: null,
          state: "open",
        },
      ],
      hold,
    }),
    [`POST /api/ops/issues/${ISSUE}/messages`]: ({ init }) => {
      sent.push(JSON.parse(String(init.body)));
      return new Reply(500, { error: { code: "stop", message: "stop" } });
    },
  });
  return { api, sent };
}

describe("Build in the back office", () => {
  it("sends the old requests queue to Build's Issues", async () => {
    const { api } = buildApi();
    renderAt("/ops/requests", api);
    expect(await screen.findByTestId("ops-build")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Issues/ })).toHaveAttribute("aria-current", "page");
  });

  it("lists the work in order with the reason for each, and the hold over it", async () => {
    const { api } = buildApi();
    renderAt("/ops/build", api);
    const row = await screen.findByTestId(`work-row-${ISSUE}`);
    expect(within(row).getByTestId("work-why")).toHaveTextContent("Critical: ahead of everything.");
    expect(within(row).getByText("Critical")).toHaveClass("mz-urgency--critical");
    expect(screen.getByTestId("work-holds")).toHaveTextContent("Demo client's Bookkeeper");
    expect(screen.getByText(/Moved by Reggie/)).toBeInTheDocument();
    expect(screen.getByTestId("work-status")).toHaveTextContent("2 shown");
    await userEvent.click(screen.getByTestId("work-filter-stuck"));
    expect(screen.queryByTestId(`work-row-${ISSUE}`)).toBeNull();
  });

  it("shows an issue with its note marked internal, its to-dos and the hold", async () => {
    const { api, sent } = buildApi();
    renderAt(`/ops/issues/${ISSUE}`, api);
    expect(await screen.findByTestId("issue-hold")).toHaveTextContent(
      "3 writes and 1 message held",
    );
    expect(screen.getByTestId("issue-note")).toHaveTextContent("Internal note");
    expect(screen.getByTestId("issue-todos")).toHaveTextContent(
      "Tell Demo client about the safety hold",
    );
    expect(screen.getByTestId("issue-read")).toHaveTextContent("Reggie hasn't read this yet");
    await userEvent.click(screen.getByRole("tab", { name: "Internal note" }));
    await userEvent.type(screen.getByTestId("issue-compose"), "Checked the bank file.");
    await userEvent.click(screen.getByTestId("issue-send"));
    expect(sent).toEqual([{ text: "Checked the bank file.", audience: "operator" }]);
  });
});

describe("the portal's Requests", () => {
  it("lists the client's requests and sends a new one with its kind", {
    timeout: SLOW,
  }, async () => {
    const sent: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/overview": () => ({
        client: { id: DEMO, name: "Demo client" },
        services: [],
        needsYou: { inbox: 0 },
        recentRuns: [],
      }),
      "GET /api/issues": () => ({
        items: [
          {
            id: ISSUE,
            kind: "problem",
            number: 7,
            title: "Charges posted twice",
            text: "14 card charges",
            state: "waiting_on_you",
            service: null,
            raisedBy: "Mike Ochoa",
            createdAt: "2026-11-17T06:12:00.000Z",
            updatedAt: "2026-11-17T06:12:00.000Z",
            canConfirm: true,
            canReopen: true,
          },
        ],
      }),
      "POST /api/requests": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return { item: portalItem() };
      },
    });
    renderAt("/requests", api);
    const row = await screen.findByTestId(`portal-work-request-${ISSUE}`);
    expect(within(row).getByTestId("request-state")).toHaveTextContent("Waiting on you");
    await userEvent.selectOptions(screen.getByTestId("new-request-kind"), "idea");
    await userEvent.type(screen.getByTestId("new-request-text"), "POs as CSV too");
    await userEvent.click(screen.getByTestId("new-request-send"));
    await waitFor(() => expect(sent).toEqual([{ kind: "idea", text: "POs as CSV too" }]));
  });
});
