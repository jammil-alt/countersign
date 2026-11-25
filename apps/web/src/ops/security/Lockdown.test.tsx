// Lockdown in the back office (docs/plan.md §1.243, K3): Security → Lockdown locks every client
// only with the words typed and a reason; a locked client is listed with who, why and what came in;
// only the security officer is offered Unlock, with a note; a client's settings lock it with its
// name typed; and every page says what is locked.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const BY = { id: "00000000-0000-4000-8000-0000000000b1", name: "Sam Lee", email: "sam@x.test" };

const nothingLocked = { everything: null, clients: [], canUnlock: false };
const demoLocked = (canUnlock: boolean) => ({
  everything: null,
  clients: [
    {
      clientId: DEMO,
      clientName: "Demo client",
      lockedAt: "2026-11-24T14:02:00.000Z",
      side: "operator",
      by: BY,
      reason: "A token may have leaked",
      inbound: { email: 3, webhook: 1 },
    },
  ],
  canUnlock,
});

function renderAt(path: string, handlers: Parameters<typeof fakeApi>[0]) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/clients/${DEMO}`]: () => ({
      client: { id: DEMO, name: "Demo client", timezone: "UTC", settings: {}, createdAt: "x" },
      agents: [],
      connections: [],
      members: [],
    }),
    ...handlers,
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

describe("Security → Lockdown", () => {
  it("locks every client only with the words typed and a reason", async () => {
    let state: unknown = nothingLocked;
    const sent: unknown[] = [];
    renderAt("/ops/security/lockdown", {
      "GET /api/ops/lockdown": () => state,
      "POST /api/ops/lockdown/lock": ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        state = {
          everything: { lockedAt: "2026-11-24T14:02:00.000Z", by: BY, reason: "Leaked key" },
          clients: [],
          canUnlock: false,
        };
        return { changed: true, lockedAt: "2026-11-24T14:02:00.000Z", runsStopped: 2 };
      },
    });
    const form = await screen.findByTestId("ops-lockdown-lock-everything", {}, { timeout: 10_000 });
    expect(await screen.findByTestId("ops-lockdown-none")).toBeInTheDocument();
    const confirm = within(form).getByTestId("ops-lockdown-lock-everything-confirm");
    await userEvent.type(
      within(form).getByTestId("ops-lockdown-lock-everything-reason"),
      "Leaked key",
    );
    await userEvent.type(within(form).getByTestId("ops-lockdown-lock-everything-typed"), "lock it");
    expect(confirm).toBeDisabled();
    await userEvent.clear(within(form).getByTestId("ops-lockdown-lock-everything-typed"));
    await userEvent.type(
      within(form).getByTestId("ops-lockdown-lock-everything-typed"),
      "Lock everything",
    );
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(sent).toEqual([{ reason: "Leaked key", confirm: "Lock everything" }]),
    );
    expect(await screen.findByTestId("ops-lockdown-everything-state")).toHaveTextContent("Locked");
    // Not the security officer: no unlock offered.
    expect(screen.getByText("Only the security officer can unlock.")).toBeInTheDocument();
  });

  it("lists a locked client with who, why and what came in, and the banner says so", async () => {
    renderAt("/ops/security/lockdown", { "GET /api/ops/lockdown": () => demoLocked(false) });
    const row = await screen.findByTestId(`ops-lockdown-client-${DEMO}`, {}, { timeout: 10_000 });
    expect(row).toHaveTextContent("Demo client");
    expect(row).toHaveTextContent("Locked by Sam Lee");
    expect(row).toHaveTextContent("Reason: A token may have leaked");
    expect(within(row).getByTestId("ops-lockdown-inbound")).toHaveTextContent(
      "Emails: 3 · Webhook calls: 1",
    );
    expect(within(row).queryByText("Unlock")).toBeNull();
    expect(await screen.findByTestId("ops-lockdown-banner")).toHaveTextContent(
      "Demo client is locked.",
    );
  });

  it("offers the security officer Unlock, with what they found", async () => {
    let state: unknown = demoLocked(true);
    const notes: unknown[] = [];
    renderAt("/ops/security/lockdown", {
      "GET /api/ops/lockdown": () => state,
      [`POST /api/ops/clients/${DEMO}/unlock`]: ({ init }) => {
        notes.push(JSON.parse(String(init.body)));
        state = { ...nothingLocked, canUnlock: true };
        return { changed: true };
      },
    });
    await userEvent.click(
      await screen.findByTestId(`ops-lockdown-unlock-open-${DEMO}`, {}, { timeout: 10_000 }),
    );
    const form = screen.getByTestId(`ops-lockdown-unlock-${DEMO}`);
    const confirm = within(form).getByTestId(`ops-lockdown-unlock-${DEMO}-confirm`);
    expect(confirm).toBeDisabled();
    await userEvent.type(within(form).getByTestId(`ops-lockdown-unlock-${DEMO}-note`), "Ours");
    await userEvent.click(confirm);
    await waitFor(() => expect(notes).toEqual([{ note: "Ours" }]));
    expect(await screen.findByTestId("ops-lockdown-none")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("ops-lockdown-banner")).toBeNull());
  });
});

describe("a client's settings → Lockdown", () => {
  it("locks the client only with its name typed and a reason", async () => {
    let state: unknown = nothingLocked;
    const sent: unknown[] = [];
    renderAt(`/ops/clients/${DEMO}/settings/lockdown`, {
      "GET /api/ops/lockdown": () => state,
      [`POST /api/ops/clients/${DEMO}/lock`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        state = demoLocked(false);
        return { changed: true, lockedAt: "2026-11-24T14:02:00.000Z", runsStopped: 1 };
      },
    });
    const form = await screen.findByTestId("ops-client-lock", {}, { timeout: 10_000 });
    const confirm = within(form).getByTestId("ops-client-lock-confirm");
    await userEvent.type(within(form).getByTestId("ops-client-lock-reason"), "A token leaked");
    await userEvent.type(within(form).getByTestId("ops-client-lock-typed"), "Demo");
    expect(confirm).toBeDisabled();
    await userEvent.type(within(form).getByTestId("ops-client-lock-typed"), " client");
    await userEvent.click(confirm);
    await waitFor(() =>
      expect(sent).toEqual([{ reason: "A token leaked", confirmName: "Demo client" }]),
    );
    expect(await screen.findByTestId("ops-client-lock-state")).toHaveTextContent("Locked");
    expect(screen.getByText("Only the security officer can unlock.")).toBeInTheDocument();
  });
});
