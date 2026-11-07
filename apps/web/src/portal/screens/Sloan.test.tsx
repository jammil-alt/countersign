// Sloan (C6): the latest conversation opens, messages read in order, a question is sent to the
// thread, the first message starts a conversation, a change Sloan drafted is signed through its own
// route, and the search box's first line asks Sloan.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { describe, expect, it } from "vitest";
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
    [`GET /api/threads/${LATEST}/messages`]: () => ({
      thread: threads[1],
      messages: [
        message("m1", true, "Why was Cole waiting on me?"),
        message("m2", false, "Emails to customers always need your sign."),
      ],
    }),
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
          title: "Add Lisa Park as a signer",
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
        item: { id: ITEM, title: "Add Lisa Park as a signer", status: "resolved", approved: true },
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
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(list).toHaveTextContent("Emails to customers always need your sign.");
    await waitFor(() => expect(reads).toEqual([LATEST]));

    await userEvent.type(screen.getByTestId("portal-sloan-input"), "Pause Cole until Monday");
    await userEvent.click(screen.getByTestId("portal-sloan-send"));
    expect(posts).toEqual([{ id: LATEST, body: { text: "Pause Cole until Monday" } }]);
  });

  it("starts a conversation with the first message", async () => {
    const { posts } = setup([]);
    expect(await screen.findByTestId("portal-sloan-empty")).toBeInTheDocument();
    await userEvent.type(screen.getByTestId("portal-sloan-input"), "Hello");
    await userEvent.click(screen.getByTestId("portal-sloan-send"));
    await waitFor(() => expect(posts).toEqual([{ id: OLD, body: { text: "Hello" } }]));
    await waitFor(() => expect(screen.getByTestId("where")).toHaveTextContent(`/sloan/${OLD}`));
  });

  it("fills the box from ?ask= and sends nothing until you do", async () => {
    const { posts } = setup(undefined, "/sloan?ask=About%20run%20R-1a2b3c%3A%20");
    expect(await screen.findByTestId("portal-sloan-input")).toHaveValue("About run R-1a2b3c: ");
    expect(posts).toEqual([]);
  });

  it("signs a change Sloan drafted through its own route", async () => {
    const { resolves } = setup();
    const changes = await screen.findByTestId("portal-sloan-changes");
    expect(changes).toHaveTextContent("Add Lisa Park as a signer");
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
