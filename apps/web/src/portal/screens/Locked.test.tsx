// Lockdown in the portal (docs/plan.md §1.243, K3): once the API answers 423 `client_locked`, every
// screen gives way to the locked page, which never shows our reason; a lock the client's side made
// shows theirs and its admin may lift it, after which the screens ask again; and a client admin locks
// the account from Settings.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { clearLocked } from "../../lockdown/locked";
import { CLIENT_SESSION, fakeApi, Reply } from "../../test/fixtures";

const DEMO = "00000000-0000-4000-8000-00000000a002";
const overview = {
  client: { id: DEMO, name: "Demo client" },
  services: [],
  needsYou: { inbox: 0 },
  recentRuns: [],
};
const LOCKED = () =>
  new Reply(423, {
    error: { code: "client_locked", message: "This account is locked down." },
  });

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

afterEach(() => clearLocked());

describe("the portal while the account is locked", () => {
  it("shows the locked page, without our reason, in place of any screen", async () => {
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": LOCKED,
      "GET /api/inbox": LOCKED,
      "GET /api/account/lock": () => ({
        locked: true,
        lockedAt: "2026-11-24T14:02:00.000Z",
        side: "operator",
        reason: null,
        canUnlock: false,
      }),
    });
    renderAt("/inbox", api);
    const page = await screen.findByTestId("portal-locked", {}, { timeout: 10_000 });
    expect(page).toHaveTextContent("Your account is locked");
    expect(page).toHaveTextContent("while we look into a security concern");
    expect(screen.queryByTestId("portal-locked-reason")).toBeNull();
    expect(screen.queryByTestId("portal-unlock")).toBeNull();
    expect(page).toHaveTextContent("ask your Mezonas lead");
  });

  it("lets the client admin lift their own lock, and the screens ask again", async () => {
    let locked = true;
    const notes: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => (locked ? LOCKED() : overview),
      "GET /api/account/lock": () => ({
        locked,
        lockedAt: "2026-11-24T14:02:00.000Z",
        side: "client",
        reason: "Lost a laptop",
        canUnlock: true,
      }),
      "POST /api/account/unlock": ({ init }) => {
        notes.push(JSON.parse(String(init.body)));
        locked = false;
        return { changed: true };
      },
    });
    renderAt("/", api);
    await screen.findByTestId("portal-locked", {}, { timeout: 10_000 });
    expect(await screen.findByTestId("portal-locked-reason")).toHaveTextContent(
      "Reason: Lost a laptop",
    );
    expect(screen.getByTestId("portal-locked-body")).toHaveTextContent("Your team locked");
    const confirm = screen.getByTestId("portal-unlock-confirm");
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByTestId("portal-unlock-note"), "Found it");
    await userEvent.click(confirm);
    await waitFor(() => expect(notes).toEqual([{ note: "Found it" }]));
    await waitFor(() => expect(screen.queryByTestId("portal-locked")).toBeNull());
    await waitFor(() =>
      expect(api.calls.filter((c) => c === "GET /api/overview").length).toBeGreaterThan(1),
    );
  });

  it("lets a client admin lock the account from Settings, with what happened", async () => {
    let locked = false;
    const reasons: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/overview": () => (locked ? LOCKED() : overview),
      "GET /api/settings/my-notifications": () => ({
        email: true,
        sms: false,
        canText: false,
        emailsOn: true,
      }),
      "POST /api/account/lock": ({ init }) => {
        reasons.push(JSON.parse(String(init.body)));
        locked = true;
        return { changed: true, lockedAt: "2026-11-24T14:02:00.000Z", runsStopped: 0 };
      },
      "GET /api/account/lock": () => ({
        locked: true,
        lockedAt: "2026-11-24T14:02:00.000Z",
        side: "client",
        reason: "A shared password",
        canUnlock: true,
      }),
    });
    renderAt("/settings", api);
    const card = await screen.findByTestId("portal-settings-lock", {}, { timeout: 10_000 });
    const confirm = screen.getByTestId("portal-settings-lock-confirm");
    expect(confirm).toBeDisabled();
    expect(card).toHaveTextContent("Lock our account");
    await userEvent.type(screen.getByTestId("portal-settings-lock-reason"), "A shared password");
    await userEvent.click(confirm);
    await waitFor(() => expect(reasons).toEqual([{ reason: "A shared password" }]));
    expect(await screen.findByTestId("portal-locked")).toBeInTheDocument();
  });
});
