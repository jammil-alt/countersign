// Sloan (C6): the latest conversation opens, messages read in order, a question is sent to the
// thread, the first message starts a conversation, a change Sloan drafted is signed through its own
// route, and the search box's first line asks Sloan.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const OLD = "00000000-0000-4000-8000-0000000c1001";
const LATEST = "00000000-0000-4000-8000-0000000c1002";
const ITEM = "00000000-0000-4000-8000-0000000c2001";

const thread = (id: string, at: string) => ({
  id,
  subject: "account",
  service: null,
  startedBy: { id: CLIENT_SESSION.user.id, name: "Demo admin" },
  lastMessageAt: at,
  unread: 0,
  createdAt: at,
});

const message = (id: string, you: boolean, text: string) => ({
  id,
  kind: "text",
  sender: { type: you ? "user" : "agent", name: you ? "Demo admin" : "Sloan", you, lead: false },
  text,
  command: null,
  sources: [],
  createdAt: "2026-11-05T09:00:00.000Z",
});

function Where() {
  const { pathname, search } = useLocation();
  return <span data-testid="where">{`${pathname}${search}`}</span>;
}

function setup(
  threads = [thread(OLD, "2026-11-01T09:00:00.000Z"), thread(LATEST, "2026-11-05T09:00:00.000Z")],
  path = "/sloan",
  latest = [
    message("m1", true, "Why was Cole waiting on me?"),
    message("m2", false, "Emails to customers always need your sign."),
  ],
) {
  const posts: { id: string; body: unknown }[] = [];
  const resolves: unknown[] = [];
  const reads: string[] = [];
  const api = fakeApi({
    "GET /api/session": () => ({ ...CLIENT_SESSION, lead: { name: "Ana Ruiz" } }),
    "GET /api/overview": () => ({
      client: { id: DEMO, name: "Demo client" },
      services: [{ id: "s1", name: "Cole", description: null, status: "active" }],
      needsYou: { inbox: 1 },
      recentRuns: [],
    }),
    "GET /api/threads": () => ({ lead: { name: "Ana Ruiz" }, threads }),
    "POST /api/threads": () => ({ thread: thread(OLD, "2026-11-06T09:00:00.000Z") }),
    [`GET /api/threads/${LATEST}/messages`]: () => ({ thread: threads[1], messages: latest }),
    [`GET /api/threads/${OLD}/messages`]: () => ({ thread: threads[0], messages: [] }),
    [`POST /api/threads/${LATEST}/messages`]: ({ init }) => {
      posts.push({ id: LATEST, body: JSON.parse(String(init.body)) });
      return { messages: [] };
    },
    [`POST /api/threads/${OLD}/messages`]: ({ init }) => {
      posts.push({ id: OLD, body: JSON.parse(String(init.body)) });
      return { messages: [] };
    },
    [`POST /api/threads/${LATEST}/read`]: () => {
      reads.push(LATEST);
      return { ok: true };
    },
    "GET /api/inbox": () => ({
      items: [
        {
          id: ITEM,
          kind: "review",
          title: "Add Lisa Park as an approver",
          payload: {
            accountChange: {
              now: ["Only Dana signs."],
              after: ["Lisa signs bills under $2,000."],
            },
          },
          display: null,
          status: "open",
          runId: null,
          dueAt: null,
          createdAt: "2026-11-05T09:00:00.000Z",
          resolvedAt: null,
          resolvedBy: null,
        },
      ],
    }),
    [`POST /api/account-changes/${ITEM}/resolve`]: ({ init }) => {
      resolves.push(JSON.parse(String(init.body)));
      return {
        item: {
          id: ITEM,
          title: "Add Lisa Park as an approver",
          status: "resolved",
          approved: true,
        },
        applied: { kind: "add_signer", userId: "u2", contactId: null },
      };
    },
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
        <Where />
      </AppProviders>
    </MemoryRouter>,
  );
  return { posts, resolves, reads };
}

describe("Sloan", () => {
  it("opens the latest conversation and sends a question to it", async () => {
    const { posts, reads } = setup();
    const list = await screen.findByTestId("portal-sloan-messages");
    expect(list.querySelectorAll('[data-testid^="portal-sloan-message-"]')).toHaveLength(2);
    expect(list).toHaveTextContent("Emails to customers always need your sign.");
    await waitFor(() => expect(reads).toEqual([LATEST]));

    await userEvent.type(screen.getByTestId("portal-sloan-input"), "Pause Cole until Monday");
    await userEvent.click(screen.getByTestId("portal-sloan-send"));
    expect(posts).toEqual([
      { id: LATEST, body: { text: "Pause Cole until Monday", documents: [] } },
    ]);
  });

  it("is asked in a side panel from any page, on the latest conversation", async () => {
    // Feedback (2026-11-11): Sloan beside the page you're on, not on a page of its own.
    const { posts } = setup(undefined, "/");
    await userEvent.click(await screen.findByTestId("shell-ask-sloan"));
    const panel = await screen.findByTestId("portal-sloan-panel");
    expect(await within(panel).findByTestId("portal-sloan-messages")).toHaveTextContent(
      "Emails to customers always need your sign.",
    );
    await userEvent.type(within(panel).getByTestId("portal-sloan-input"), "Pause Cole");
    await userEvent.click(within(panel).getByTestId("portal-sloan-send"));
    expect(posts).toEqual([{ id: LATEST, body: { text: "Pause Cole", documents: [] } }]);
    // The page under it stays where it was.
    expect(screen.getByTestId("where")).toHaveTextContent(/^\/$/);
    // The full page is one link away, on the same conversation.
    await userEvent.click(within(panel).getByTestId("portal-sloan-panel-page"));
    expect(screen.getByTestId("where")).toHaveTextContent(`/sloan/${LATEST}`);
    expect(screen.queryByTestId("portal-sloan-panel")).toBeNull();
  });

  // S2.1 (overnight fixes): an answer that never comes no longer reads "Sloan is answering…"
  // for good.
  it("waits for an answer that is coming, and stops waiting for one that isn't", async () => {
    const asked = { ...message("m1", true, "Why was Cole waiting on me?") };
    setup(undefined, "/sloan", [{ ...asked, createdAt: new Date().toISOString() }]);
    expect(await screen.findByTestId("portal-sloan-thinking")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-sloan-no-answer")).toBeNull();
  });

  it("says no answer came for a question left long ago, and checks again", async () => {
    setup(undefined, "/sloan", [message("m1", true, "Why was Cole waiting on me?")]);
    const none = await screen.findByTestId("portal-sloan-no-answer");
    expect(none).toHaveTextContent("No answer from Sloan yet.");
    expect(screen.queryByTestId("portal-sloan-thinking")).toBeNull();
    await userEvent.click(screen.getByTestId("portal-sloan-check-again"));
    // Asked again, the old question still isn't waited on.
    expect(await screen.findByTestId("portal-sloan-no-answer")).toBeInTheDocument();
  });

  it("starts a conversation with the first message", async () => {
    const { posts } = setup([]);
    expect(await screen.findByTestId("portal-sloan-empty")).toBeInTheDocument();
    await userEvent.type(screen.getByTestId("portal-sloan-input"), "Hello");
    await userEvent.click(screen.getByTestId("portal-sloan-send"));
    await waitFor(() =>
      expect(posts).toEqual([{ id: OLD, body: { text: "Hello", documents: [] } }]),
    );
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/sloan/${OLD}`));
  });

  it("attaches a file and sends it with the message (§1.110)", async () => {
    const uploads: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      uploads.push(String(input));
      return new Response(
        JSON.stringify({
          results: [
            {
              filename: "inv-1042.pdf",
              kind: "document",
              created: true,
              purchases: null,
              error: null,
              document: {
                id: "0192f7a0-0000-7000-8000-00000000d001",
                source: "upload",
                filename: "inv-1042.pdf",
                mimeType: "application/pdf",
                sizeBytes: 4,
                status: "stored",
                pageCount: null,
                transactionId: null,
                receivedAt: "2026-11-05T09:00:00.000Z",
                vendorName: null,
                invoiceNumber: null,
                total: null,
              },
            },
          ],
        }),
        { status: 200 },
      );
    });
    try {
      const { posts } = setup();
      await screen.findByTestId("portal-sloan-messages");
      await userEvent.upload(
        screen.getByTestId("portal-sloan-composer-attach-input"),
        new File([new Uint8Array([1])], "inv-1042.pdf", { type: "application/pdf" }),
      );
      expect(await screen.findByText("inv-1042.pdf")).toBeInTheDocument();
      expect(uploads).toEqual(["/api/uploads?for=chat"]);
      await userEvent.type(screen.getByTestId("portal-sloan-input"), "Send this to Pia");
      await userEvent.click(screen.getByTestId("portal-sloan-send"));
      await waitFor(() =>
        expect(posts).toEqual([
          {
            id: LATEST,
            body: {
              text: "Send this to Pia",
              documents: ["0192f7a0-0000-7000-8000-00000000d001"],
            },
          },
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fills the box from ?ask= and sends nothing until you do", async () => {
    const { posts } = setup(undefined, "/sloan?ask=About%20run%20R-1a2b3c%3A%20");
    expect(await screen.findByTestId("portal-sloan-input")).toHaveValue("About run R-1a2b3c: ");
    expect(posts).toEqual([]);
  });

  it("signs a change Sloan drafted through its own route", async () => {
    const { resolves } = setup();
    const changes = await screen.findByTestId("portal-sloan-changes");
    expect(changes).toHaveTextContent("Add Lisa Park as an approver");
    expect(changes).toHaveTextContent("Lisa signs bills under $2,000.");
    await userEvent.click(within(changes).getByTestId("inbox-item-approve"));
    await waitFor(() => expect(resolves).toEqual([{ decision: "approve" }]));
  });

  it("is asked from the search box, not the sidebar", async () => {
    setup();
    expect(await screen.findByTestId("portal-nav-home")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-nav-sloan")).toBeNull();
    expect(screen.queryByTestId("portal-nav-weekly")).toBeNull();
    await userEvent.click(screen.getByTestId("shell-search"));
    await userEvent.type(screen.getByTestId("search-input"), "why is Cole waiting");
    const ask = await screen.findByTestId("search-ask");
    expect(ask).toHaveTextContent("Ask Sloan, your account agent: why is Cole waiting");
    expect(ask).toHaveAttribute("href", "/sloan?ask=why%20is%20Cole%20waiting");
  });
});
