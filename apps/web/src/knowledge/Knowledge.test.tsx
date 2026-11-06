// The knowledge base on both surfaces: the client admin adds and edits the client's FAQs and
// policies at /knowledge (a stale edit says so); the operator's Knowledge tab on the client page
// lists entries with their history, the indexed documents and memory notes, and tries a search.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply, SANDBOX_DETAIL } from "../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const ENTRY = "00000000-0000-4000-8000-0000000ab001";
const DOC = "00000000-0000-4000-8000-0000000ab101";

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: ENTRY,
  kind: "faq",
  status: "active",
  version: 1,
  title: "When do you deliver?",
  body: "Tuesdays and Thursdays.",
  createdAt: "2026-11-04T10:00:00.000Z",
  updatedAt: "2026-11-04T10:00:00.000Z",
  updatedBy: { role: "operator", name: null },
  ...over,
});

const portalBase = {
  "GET /api/session": () => CLIENT_SESSION,
  "GET /api/feedback/status": () => ({ enabled: false }),
  "GET /api/overview": () => ({
    client: { id: DEMO, name: "Demo client" },
    services: [],
    needsYou: { inbox: 0 },
    recentRuns: [],
  }),
};

describe("portal knowledge", () => {
  it("tells a client user only the admin sees it, and loads nothing (UI-3a)", async () => {
    const api = fakeApi({
      ...portalBase,
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: DEMO, name: "Demo client", role: "client_user" }],
      }),
    });
    renderAt("/knowledge", api);
    expect(
      await screen.findByText(
        "Only your admin can see and change what agents know about your business.",
      ),
    ).toBeInTheDocument();
    expect(api.calls).not.toContain("GET /api/knowledge");
  });

  it("adds an FAQ and shows it, with 'us' for our earlier edits", async () => {
    const entries: unknown[] = [entry()];
    const sent: unknown[] = [];
    const api = fakeApi({
      ...portalBase,
      "GET /api/knowledge": () => ({ entries }),
      "POST /api/knowledge/entries": ({ init }) => {
        const body = JSON.parse(String(init.body));
        sent.push(body);
        const created = entry({
          id: "00000000-0000-4000-8000-0000000ab002",
          kind: body.kind,
          title: body.title,
          body: body.body,
          updatedBy: { role: "client_admin", name: "Demo admin" },
        });
        entries.unshift(created);
        return { entry: created };
      },
    });
    renderAt("/knowledge", api);
    const card = await screen.findByTestId(`portal-knowledge-entry-${ENTRY}`);
    expect(card).toHaveTextContent("Version 1 · us");
    expect(screen.getByTestId("portal-nav-knowledge")).toBeInTheDocument();

    const save = screen.getByTestId("portal-knowledge-new-save");
    expect(save).toBeDisabled();
    await userEvent.selectOptions(screen.getByTestId("portal-knowledge-new-kind"), "policy");
    await userEvent.type(screen.getByTestId("portal-knowledge-new-title"), "Returns");
    await userEvent.type(
      screen.getByTestId("portal-knowledge-new-body"),
      "Unused boards within 30 days.",
    );
    await userEvent.click(save);
    expect(sent).toEqual([
      { kind: "policy", title: "Returns", body: "Unused boards within 30 days." },
    ]);
    await waitFor(() =>
      expect(
        screen.getAllByTestId("portal-knowledge-entry-title").map((e) => e.textContent),
      ).toEqual(["Returns", "When do you deliver?"]),
    );
    expect(screen.getByTestId("portal-knowledge-new-title")).toHaveValue("");
  });

  it("edits from the version it opened, and says so when someone changed it first", async () => {
    const bodies: unknown[] = [];
    const api = fakeApi({
      ...portalBase,
      "GET /api/knowledge": () => ({ entries: [entry({ version: 2 })] }),
      [`PUT /api/knowledge/entries/${ENTRY}`]: ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Reply(409, { error: { code: "stale", message: "changed" } });
      },
    });
    renderAt("/knowledge", api);
    const card = await screen.findByTestId(`portal-knowledge-entry-${ENTRY}`);
    await userEvent.click(within(card).getByTestId("portal-knowledge-entry-edit"));
    const body = within(card).getByTestId("portal-knowledge-edit-body");
    await userEvent.clear(body);
    await userEvent.type(body, "Tuesdays only.");
    await userEvent.click(within(card).getByTestId("portal-knowledge-edit-save"));
    expect(bodies).toEqual([
      { title: "When do you deliver?", body: "Tuesdays only.", baseVersion: 2 },
    ]);
    expect(await within(card).findByTestId("portal-knowledge-edit-error")).toHaveTextContent(
      "Someone changed this since you opened it",
    );
  });

  it("is not in a client user's sidebar", async () => {
    const api = fakeApi({
      ...portalBase,
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        tenants: [{ id: DEMO, name: "Demo client", role: "client_user" }],
      }),
    });
    renderAt("/", api);
    await screen.findByTestId("portal-nav-table");
    expect(screen.queryByTestId("portal-nav-knowledge")).toBeNull();
  });
});

describe("back office knowledge tab", () => {
  const CLIENT = SANDBOX_DETAIL.client.id;
  function opsApi() {
    const archived: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => OPERATOR_SESSION,
      [`GET /api/ops/clients/${CLIENT}`]: () => SANDBOX_DETAIL,
      [`GET /api/ops/clients/${CLIENT}/knowledge`]: () => ({
        entries: archived.length
          ? []
          : [entry({ version: 2, updatedBy: { role: "client_admin", name: "Dana" } })],
        documents: [
          {
            id: DOC,
            filename: "northline-20418.pdf",
            source: "email",
            status: "extracted",
            receivedAt: "2026-11-03T10:00:00.000Z",
            title: "Invoice 20418 from Northline Panel Supply",
            passages: 2,
            indexed: true,
          },
        ],
        memoryNotes: {
          count: 1,
          recent: [
            {
              id: "00000000-0000-4000-8000-0000000ab201",
              agent: { id: "a", name: "Front desk" },
              note: "Dana answers delivery questions.",
              createdAt: "2026-11-03T10:00:00.000Z",
            },
          ],
        },
      }),
      [`GET /api/ops/clients/${CLIENT}/knowledge/entries/${ENTRY}/versions`]: () => ({
        versions: [
          {
            id: "v1",
            version: 1,
            title: "When do you deliver?",
            body: "Tuesdays.",
            status: "active",
            author: { role: "operator", name: "Operator" },
            createdAt: "2026-11-03T10:00:00.000Z",
          },
          {
            id: "v2",
            version: 2,
            title: "When do you deliver?",
            body: "Tuesdays and Thursdays.",
            status: "active",
            author: { role: "client_admin", name: "Dana" },
            createdAt: "2026-11-04T10:00:00.000Z",
          },
        ],
      }),
      [`POST /api/ops/clients/${CLIENT}/knowledge/entries/${ENTRY}/archive`]: ({ init }) => {
        archived.push(JSON.parse(String(init.body)));
        return { entry: entry({ status: "archived", version: 3 }) };
      },
      [`GET /api/ops/clients/${CLIENT}/knowledge/search`]: ({ url }) => ({
        results:
          url.searchParams.get("q") === "deliver"
            ? [
                {
                  kind: "faq",
                  id: ENTRY,
                  title: "When do you deliver?",
                  excerpt: "Tuesdays and Thursdays.",
                  score: 0.6,
                  sources: [ENTRY, "v2"],
                },
              ]
            : [],
      }),
    });
    return { api, archived };
  }

  it("shows entries, indexed documents and notes, with each entry's history", async () => {
    const { api } = opsApi();
    renderAt(`/ops/clients/${CLIENT}/knowledge`, api);
    const card = await screen.findByTestId(`ops-knowledge-entry-${ENTRY}`);
    expect(card).toHaveTextContent("Version 2 · Dana");
    expect(screen.getByRole("link", { name: "Knowledge" })).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}/knowledge`,
    );
    const doc = screen.getByTestId(`ops-knowledge-document-${DOC}`);
    expect(doc).toHaveTextContent("Invoice 20418 from Northline Panel Supply");
    expect(within(doc).getByText("Indexed")).toHaveClass("ds-pill--positive");
    expect(screen.getByTestId("ops-knowledge-notes")).toHaveTextContent(
      "Dana answers delivery questions.",
    );
    await userEvent.click(within(card).getByTestId("ops-knowledge-entry-history"));
    const versions = await within(card).findByTestId("ops-knowledge-versions");
    expect(versions).toHaveTextContent("Version 2 · Dana");
    expect(versions).toHaveTextContent("Version 1 · Operator");
  });

  it("tries a search and archives an entry from the version shown", async () => {
    const { api, archived } = opsApi();
    renderAt(`/ops/clients/${CLIENT}/knowledge`, api);
    await screen.findByTestId(`ops-knowledge-entry-${ENTRY}`);
    await userEvent.type(screen.getByTestId("ops-knowledge-search-input"), "deliver");
    await userEvent.click(screen.getByTestId("ops-knowledge-search-go"));
    const results = await screen.findByTestId("ops-knowledge-search-results");
    expect(results).toHaveTextContent("Tuesdays and Thursdays.");
    expect(results).toHaveTextContent(ENTRY);

    await userEvent.click(screen.getByTestId("ops-knowledge-entry-archive"));
    expect(archived).toEqual([{ baseVersion: 2 }]);
    expect(await screen.findByText(/No FAQs or policies yet/)).toBeInTheDocument();
  });

  it("the client page has the Agents and Knowledge tabs", async () => {
    const { api } = opsApi();
    renderAt(`/ops/clients/${CLIENT}`, api);
    expect(await screen.findByRole("link", { name: "Knowledge" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Agents" })).toHaveAttribute(
      "href",
      `/ops/clients/${CLIENT}`,
    );
  });
});
