// Requests on both surfaces: the client asks from Sloan's "Ask for a change" (`/sloan?mode=change`;
// `/requests` redirects there, QA round 1) and follows the reply; the operator
// works the queue at /ops/requests, hands a request to the Builder, and resolves it as done with
// the versions made for it, or declines it with a note.
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
    renderAt("/requests?x=1", api);
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
    renderAt("/requests", api);
    const card = await screen.findByTestId(`portal-request-${REQ}`);
    expect(within(card).getByTestId("portal-request-status")).toHaveClass("ds-pill--positive");
    const reply = within(card).getByTestId("portal-request-reply");
    expect(reply).toHaveTextContent("Acme is on the vendor list now.");
    expect(within(card).getByTestId("portal-request-changes")).toHaveTextContent(
      "Invoice intake: now on version 4",
    );
  });
});

const opsItem = (over: Record<string, unknown> = {}) => ({
  id: REQ,
  client: { id: DEMO, name: "Demo client" },
  subject: "Add Acme as a vendor",
  text: "We started buying from Acme Lumber.",
  agent: { id: SERVICE, slug: "intake", name: "Intake", serviceName: "Invoice intake" },
  status: "open",
  raisedBy: { id: "u", email: "admin@demo.example.com", name: "Demo admin" },
  createdAt: "2026-11-04T10:00:00.000Z",
  resolvedAt: null,
  resolvedBy: null,
  note: null,
  links: [],
  ...over,
});

const AGENT = {
  id: SERVICE,
  tenantId: DEMO,
  kind: "client",
  slug: "intake",
  name: "Intake",
  role: null,
  templateId: null,
  linked: true,
  liveVersionId: VERSION,
  status: "active",
  runStatus: "active",
  serviceName: "Invoice intake",
  serviceDescription: null,
  bindings: {},
  approver: null,
  testCopy: false,
  createdAt: "2026-11-04T09:00:00.000Z",
};
const VERSION_ROW = {
  id: VERSION,
  agentId: SERVICE,
  version: 4,
  status: "draft",
  bundleHash: "h",
  changeNote: null,
  releaseNote: null,
  authorType: "operator",
  authorId: null,
  parentVersionId: null,
  basedOnTemplateVersionId: null,
  mergedFromVersionIds: null,
  createdAt: "2026-11-04T11:00:00.000Z",
};

function opsApi() {
  let current = opsItem();
  const bodies: unknown[] = [];
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    "GET /api/ops/requests": ({ url }) => {
      const status = url.searchParams.get("status") ?? "open";
      const open = current.status === "open";
      return {
        items: status === "all" || (status === "open") === open ? [current] : [],
      };
    },
    [`GET /api/ops/clients/${DEMO}/agents`]: () => ({ agents: [AGENT] }),
    "GET /api/ops/templates": () => ({ templates: [] }),
    [`GET /api/ops/agents/${SERVICE}`]: () => ({
      agent: AGENT,
      versions: [VERSION_ROW],
      live: null,
      latest: null,
      update: null,
    }),
    [`POST /api/ops/requests/${REQ}/resolve`]: ({ init }) => {
      const body = JSON.parse(String(init.body)) as { outcome: string; note?: string };
      if (body.outcome === "declined" && !body.note) {
        return new Reply(400, { error: { code: "invalid_request" } });
      }
      bodies.push(body);
      current = opsItem({
        status: body.outcome,
        resolvedAt: "2026-11-05T10:00:00.000Z",
        resolvedBy: { id: "o", email: "operator@example.com", name: "Operator" },
        note: body.note ?? null,
        links:
          body.outcome === "done"
            ? [
                {
                  agentVersionId: VERSION,
                  agentId: SERVICE,
                  kind: "client",
                  tenantId: DEMO,
                  slug: "intake",
                  name: "Intake",
                  version: 4,
                },
              ]
            : [],
      });
      return { item: current };
    },
  });
  return { api, bodies };
}

describe("ops requests queue", () => {
  it("hands a request to the Builder and resolves it as done with a version", {
    timeout: SLOW,
  }, async () => {
    const { api, bodies } = opsApi();
    renderAt("/ops/requests", api);
    const card = await screen.findByTestId(`ops-request-${REQ}`);
    expect(within(card).getByTestId("ops-request-status")).toHaveTextContent("Open");
    expect(within(card).getByTestId("ops-request-status")).toHaveClass("ds-pill--warning");
    expect(within(card).getByTestId("ops-request-revise")).toHaveAttribute(
      "href",
      `/ops/clients/${DEMO}/agents/intake/revise?request=${REQ}`,
    );

    await userEvent.click(within(card).getByTestId("ops-request-resolve"));
    const confirm = screen.getByTestId("ops-request-resolve-confirm");
    expect(confirm).toBeDisabled();
    // The request's own service is chosen; its newest version is offered.
    await waitFor(() =>
      expect(screen.getByTestId("ops-request-link-version")).toHaveValue(VERSION),
    );
    await userEvent.click(screen.getByTestId("ops-request-link-add"));
    expect(screen.getByTestId("ops-request-picked")).toHaveTextContent("Invoice intake v4");
    await userEvent.type(screen.getByTestId("ops-request-note-input"), "Acme is on the list.");
    await userEvent.click(confirm);
    expect(bodies).toEqual([{ outcome: "done", note: "Acme is on the list.", links: [VERSION] }]);
    await waitFor(() => expect(screen.queryByTestId(`ops-request-${REQ}`)).toBeNull());

    await userEvent.click(screen.getByTestId("ops-requests-filter-resolved"));
    const done = await screen.findByTestId(`ops-request-${REQ}`);
    expect(within(done).getByTestId("ops-request-status")).toHaveClass("ds-pill--positive");
    expect(within(done).getByTestId("ops-request-links")).toHaveTextContent("Intake v4");
    expect(within(done).getByRole("link", { name: "Intake v4" })).toHaveAttribute(
      "href",
      `/ops/clients/${DEMO}/agents/intake?version=4`,
    );
  });

  it("needs a note to decline", async () => {
    const { api, bodies } = opsApi();
    renderAt("/ops/requests", api);
    const card = await screen.findByTestId(`ops-request-${REQ}`);
    await userEvent.click(within(card).getByTestId("ops-request-resolve"));
    await userEvent.click(screen.getByTestId("ops-request-outcome-filter-declined"));
    expect(screen.queryByTestId("ops-request-link-agent")).toBeNull();
    const confirm = screen.getByTestId("ops-request-resolve-confirm");
    expect(confirm).toHaveTextContent("Decline");
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByTestId("ops-request-note-input"), "Not in your plan yet.");
    await userEvent.click(confirm);
    expect(bodies).toEqual([{ outcome: "declined", note: "Not in your plan yet.", links: [] }]);
  });
});
