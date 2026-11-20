// PLATFORM_QA FLOW lens: the Inbox (the Desk, `/inbox`), where a client approves what agents want to do.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { BILL_ITEM } from "../../test/changes";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

for (const level of ["warn", "error"] as const)
  vi.spyOn(console, level).mockImplementation(() => {});

const SERVICE = { id: "00000000-0000-4000-8000-0000000a0c01", name: "Pia" };
const ITEM = { ...BILL_ITEM, resolvedBy: null, service: SERVICE, batchKey: null };
const ME = CLIENT_SESSION.user.id;

function overview(inbox: number) {
  return {
    client: { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client" },
    services: [],
    needsYou: { inbox },
    recentRuns: [],
  };
}

function team(role: string, canSign: boolean) {
  return {
    members: [
      {
        userId: ME,
        name: "Demo person",
        email: "person@demo-client.example.com",
        role,
        canSign,
        signs: canSign ? ["Every change."] : ["Sees everything, approves nothing."],
      },
    ],
    settings: { undoSeconds: 60 },
  };
}

type Lists = { open?: unknown[]; snoozed?: unknown[]; resolved?: unknown[] };
type Handler = Parameters<typeof fakeApi>[0][string];

function inbox(lists: () => Lists | Reply, snoozed?: () => unknown): Handler {
  return ({ url }) => {
    const status = url.searchParams.get("status") ?? "open";
    if (url.searchParams.get("view") === "snoozed" && snoozed) return snoozed();
    const l = lists();
    if (l instanceof Reply) return l;
    if (status === "resolved") return { items: l.resolved ?? [] };
    if (url.searchParams.get("view") === "snoozed") return { items: l.snoozed ?? [] };
    return { items: l.open ?? [] };
  };
}

function renderAt(path: string, routes: Record<string, Handler>) {
  const api = fakeApi({
    "GET /api/session": () => CLIENT_SESSION,
    "GET /api/feedback/status": () => ({ enabled: false }),
    "GET /api/team": () => team("client_admin", true),
    ...routes,
  });
  render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("FLOW: the Desk", () => {
  it("(PLATFORM_QA FLOW-4) the set-aside (Not now) list that fails to load says so, not 'nothing waits'", async () => {
    // A link to the old Not now view (`?view=later`), or the Waiting view with "Show set aside":
    // the snoozed list answers 500.
    renderAt("/inbox?view=later", {
      "GET /api/overview": () => overview(0),
      "GET /api/inbox": inbox(
        () => ({}),
        () => new Reply(500, { error: { code: "internal", message: "boom" } }),
      ),
    });
    const list = await screen.findByTestId("desk-entries");
    expect(list).toHaveTextContent("Nothing waits on you right now.");
    // Expected: the page says the set-aside items couldn't be loaded (an alert with a retry).
    expect(screen.queryByRole("alert")).not.toBeNull();
  });

  it("(PLATFORM_QA FLOW-5) Undo on a batch that half fails shows what the API holds and can be pressed again", {
    timeout: 15_000,
  }, async () => {
    const key = `${ITEM.runId}:send`;
    const one = { ...ITEM, id: "00000000-0000-4000-8000-0000000b0001", batchKey: key };
    const two = { ...ITEM, id: "00000000-0000-4000-8000-0000000b0002", batchKey: key };
    const deliverAfter = new Date(Date.now() + 60_000).toISOString();
    // The server: both approved; then one undo goes through and the other hits a passing 500.
    const status: Record<string, "open" | "resolved"> = { [one.id]: "open", [two.id]: "open" };
    let twoFailures = 1;
    const state = (id: string) => ({
      id,
      status: status[id] as string,
      deliverAfter: status[id] === "resolved" ? deliverAfter : null,
      snoozedUntil: null,
      batchKey: key,
      resolvedAt: status[id] === "resolved" ? new Date().toISOString() : null,
    });
    const listed = () => [one, two].filter((i) => status[i.id] === "open");
    renderAt("/inbox", {
      "GET /api/overview": () => overview(listed().length),
      "GET /api/inbox": inbox(() => ({ open: listed() })),
      "POST /api/inbox/batch/resolve": () => {
        status[one.id] = "resolved";
        status[two.id] = "resolved";
        return { items: [state(one.id), state(two.id)] };
      },
      [`POST /api/inbox/${one.id}/undo`]: () => {
        if (status[one.id] !== "resolved") {
          return new Reply(409, { error: { code: "not_undoable", message: "nothing to undo" } });
        }
        status[one.id] = "open";
        return { item: state(one.id) };
      },
      [`POST /api/inbox/${two.id}/undo`]: () => {
        if (twoFailures-- > 0) {
          return new Reply(503, { error: { code: "unavailable", message: "try again" } });
        }
        status[two.id] = "open";
        return { item: state(two.id) };
      },
    });
    const card = await screen.findByTestId("desk-detail");
    await userEvent.click(within(card).getByTestId("desk-sign"));
    await within(card).findByTestId("desk-undo");
    await userEvent.click(within(card).getByTestId("desk-undo"));
    // The first press: one undone, two not. The person presses Undo again, as the error invites.
    await waitFor(() => expect(status[one.id]).toBe("open"));
    const again = await within(card).findByTestId("desk-undo");
    await userEvent.click(again);
    // Expected: both are open again and the card offers to approve them, with no error left.
    await waitFor(() => expect(status[two.id]).toBe("open"));
    await waitFor(() => expect(within(card).queryByRole("alert")?.textContent ?? null).toBeNull(), {
      timeout: 2000,
    });
  });
});
