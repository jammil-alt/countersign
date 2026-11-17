// Approving a Claude connection (docs/plan.md §1.120), from the link Claude gives: an operator in the
// back office, a client's person in the portal; approved and expired links say so; a link that
// matches none of yours says so; a refused approval shows why; a client reads it in their language.
import type { ClaudeConnection, Locale } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { CLIENT_SESSION, fakeApi, OPERATOR_SESSION, Reply } from "../test/fixtures";

const CODE = "abcdefghijklmnopqrstuvwxyz234567";

function connection(over: Partial<ClaudeConnection> = {}): ClaudeConnection {
  return {
    status: "waiting",
    startedAt: "2026-11-16T14:05:00.000Z",
    requestedAt: "2026-11-16T14:05:00.000Z",
    expiresAt: "2026-11-16T14:35:00.000Z",
    ...over,
  };
}

/** The bodies sent to Approve. */
const sent: unknown[] = [];

function renderWith(
  get: () => unknown,
  approve?: () => unknown,
  opts: { path?: string; session?: unknown } = {},
) {
  const api = fakeApi({
    "GET /api/session": () => opts.session ?? OPERATOR_SESSION,
    [`GET /api/auth/claude-connections/${CODE}`]: get,
    ...(approve
      ? {
          [`POST /api/auth/claude-connections/${CODE}/approve`]: ({
            init,
          }: {
            init: RequestInit;
          }) => {
            sent.push(JSON.parse(String(init.body)));
            return approve();
          },
        }
      : {}),
  });
  render(
    <MemoryRouter initialEntries={[opts.path ?? `/ops/connect-claude/${CODE}`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

const clientIn = (locale: Locale) => ({
  ...CLIENT_SESSION,
  language: { effective: locale, user: locale, client: null },
});

describe("approving a Claude connection", () => {
  it("explains the request to an operator, and approves it", async () => {
    const api = renderWith(
      () => connection(),
      () => connection({ status: "approved", expiresAt: "2026-11-17T02:05:00.000Z" }),
    );
    const waiting = await screen.findByTestId("connect-claude-waiting", {}, { timeout: 10_000 });
    expect(screen.getByTestId("shell-ops")).toBeInTheDocument();
    expect(waiting).toHaveTextContent("Claude is asking to use Mezonas as you. It first asked at");
    expect(waiting).toHaveTextContent("Approve it only if you just connected Claude yourself.");
    expect(waiting).toHaveTextContent("This link works until");
    expect(screen.getByTestId("connect-claude-requested")).toHaveTextContent(
      "Claude gave you this link at",
    );
    expect(screen.getByTestId("connect-claude-card")).toHaveTextContent("Waiting for you");
    // Not one click: the code Claude showed comes first.
    const approve = within(waiting).getByTestId("connect-claude-approve");
    expect(approve).toBeDisabled();
    await userEvent.type(screen.getByTestId("connect-claude-confirm"), "123 45");
    expect(approve).toBeDisabled();
    await userEvent.type(screen.getByTestId("connect-claude-confirm"), "6");
    sent.length = 0;
    await userEvent.click(approve);
    expect(await screen.findByTestId("connect-claude-approved")).toHaveTextContent(
      "Approved. Claude can use Mezonas as you until",
    );
    expect(api.calls).toContain(`POST /api/auth/claude-connections/${CODE}/approve`);
    expect(sent).toEqual([{ confirm: "123456" }]);
    expect(screen.queryByTestId("connect-claude-approve")).toBeNull();
  });

  it("opens in the portal for a client's person", async () => {
    const api = renderWith(
      () => connection(),
      () => connection({ status: "approved" }),
      { path: `/connect-claude/${CODE}`, session: CLIENT_SESSION },
    );
    await screen.findByTestId("connect-claude-waiting", {}, { timeout: 10_000 });
    expect(screen.getByTestId("shell-portal")).toBeInTheDocument();
    await userEvent.type(screen.getByTestId("connect-claude-confirm"), "654321");
    await userEvent.click(screen.getByTestId("connect-claude-approve"));
    await screen.findByTestId("connect-claude-approved");
    expect(api.calls).toContain(`POST /api/auth/claude-connections/${CODE}/approve`);
  });

  it("reads in the client's language", async () => {
    renderWith(() => connection(), undefined, {
      path: `/connect-claude/${CODE}`,
      session: clientIn("es"),
    });
    const waiting = await screen.findByTestId("connect-claude-waiting", {}, { timeout: 10_000 });
    expect(waiting).toHaveTextContent("Claude pide usar Mezonas en su nombre.");
    expect(waiting).toHaveTextContent("El código que le mostró Claude");
    expect(within(waiting).getByTestId("connect-claude-approve")).toHaveTextContent("Aprobar");
  });

  it("says when it is already approved", async () => {
    renderWith(() => connection({ status: "approved" }));
    expect(
      await screen.findByTestId("connect-claude-approved", {}, { timeout: 10_000 }),
    ).toHaveTextContent("Approved.");
    expect(screen.getByTestId("connect-claude-card")).toHaveTextContent("Approved");
    expect(screen.queryByTestId("connect-claude-approve")).toBeNull();
  });

  it("says when the link has expired", async () => {
    renderWith(() => connection({ status: "expired" }));
    expect(
      await screen.findByTestId("connect-claude-expired", {}, { timeout: 10_000 }),
    ).toHaveTextContent("This link has expired. Ask Claude again to get a new one.");
    expect(screen.getByTestId("connect-claude-card")).toHaveTextContent("Expired");
    expect(screen.queryByTestId("connect-claude-approve")).toBeNull();
  });

  it("says when a link matches none of yours", async () => {
    renderWith(() => new Reply(404, { error: { code: "not_found", message: "No such code" } }));
    expect(
      await screen.findByTestId("connect-claude-unknown", {}, { timeout: 10_000 }),
    ).toHaveTextContent("This link doesn't match a Claude connection of yours.");
  });

  it("never asks the API about a code that can't be one", async () => {
    const api = fakeApi({ "GET /api/session": () => OPERATOR_SESSION });
    render(
      <MemoryRouter initialEntries={["/ops/connect-claude/not-a-code"]}>
        <AppProviders client={api.client}>
          <AppRoutes />
        </AppProviders>
      </MemoryRouter>,
    );
    await screen.findByTestId("connect-claude-unknown", {}, { timeout: 10_000 });
    expect(api.calls.some((c) => c.includes("claude-connections"))).toBe(false);
  });

  it("shows why an approval was refused", async () => {
    renderWith(
      () => connection(),
      () => new Reply(409, { error: { code: "expired", message: "this link has expired" } }),
    );
    await userEvent.type(
      await screen.findByTestId("connect-claude-confirm", {}, { timeout: 10_000 }),
      "123456",
    );
    await userEvent.click(screen.getByTestId("connect-claude-approve"));
    expect(await screen.findByRole("alert")).toHaveTextContent("this link has expired");
  });
});
