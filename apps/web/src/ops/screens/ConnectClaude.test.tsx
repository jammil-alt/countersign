// `/ops/connect-claude/:code` (docs/plan.md §1.83): an operator approves their own Claude
// connection to the back office; someone else's can't be approved here; approved and expired ones
// say so; a link that matches nothing says so.
import type { ClaudeConnection } from "@countersign/core";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { fakeApi, OPERATOR_SESSION, Reply } from "../../test/fixtures";

const CODE = "abcDEF123_-xyz7890";

function connection(over: Partial<ClaudeConnection> = {}): ClaudeConnection {
  return {
    status: "waiting",
    startedAt: "2026-11-09T14:05:00.000Z",
    expiresAt: "2026-11-10T02:05:00.000Z",
    yours: true,
    ...over,
  };
}

function renderWith(get: () => unknown, approve?: () => unknown, code = CODE) {
  const api = fakeApi({
    "GET /api/session": () => OPERATOR_SESSION,
    [`GET /api/ops/claude-connections/${code}`]: get,
    ...(approve ? { [`POST /api/ops/claude-connections/${code}/approve`]: approve } : {}),
  });
  render(
    <MemoryRouter initialEntries={[`/ops/connect-claude/${code}`]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  return api;
}

describe("approving a Claude connection", () => {
  it("explains the request, and approves it", async () => {
    const api = renderWith(
      () => connection(),
      () => connection({ status: "approved" }),
    );
    const waiting = await screen.findByTestId("connect-claude-waiting", {}, { timeout: 10_000 });
    expect(waiting).toHaveTextContent(
      "Claude is asking to use the Mezonas back office as you, started at",
    );
    expect(waiting).toHaveTextContent("Approve it only if you just connected Claude yourself.");
    expect(screen.getByTestId("connect-claude-card")).toHaveTextContent("Waiting for approval");
    await userEvent.click(within(waiting).getByTestId("connect-claude-approve"));
    expect(await screen.findByTestId("connect-claude-approved")).toHaveTextContent(
      "Approved. Claude can use the back office as you until",
    );
    expect(api.calls).toContain(`POST /api/ops/claude-connections/${CODE}/approve`);
    expect(screen.queryByTestId("connect-claude-approve")).toBeNull();
  });

  it("can't approve another person's connection", async () => {
    renderWith(() => connection({ yours: false }));
    expect(
      await screen.findByTestId("connect-claude-not-yours", {}, { timeout: 10_000 }),
    ).toHaveTextContent("This connection belongs to another person. It can't be approved here.");
    expect(screen.queryByTestId("connect-claude-approve")).toBeNull();
  });

  it("says when the request has expired", async () => {
    renderWith(() => connection({ status: "expired" }));
    expect(
      await screen.findByTestId("connect-claude-expired", {}, { timeout: 10_000 }),
    ).toHaveTextContent("This request has expired. Connect Claude again to get a new link.");
    expect(screen.getByTestId("connect-claude-card")).toHaveTextContent("Expired");
    expect(screen.queryByTestId("connect-claude-approve")).toBeNull();
  });

  it("says when a link matches no connection", async () => {
    renderWith(() => new Reply(404, { error: { code: "not_found", message: "No such code" } }));
    expect(
      await screen.findByTestId("connect-claude-unknown", {}, { timeout: 10_000 }),
    ).toHaveTextContent("This link doesn't match a Claude connection.");
  });

  it("shows why an approval was refused", async () => {
    renderWith(
      () => connection(),
      () => new Reply(409, { error: { code: "conflict", message: "Already approved elsewhere." } }),
    );
    await userEvent.click(
      await screen.findByTestId("connect-claude-approve", {}, { timeout: 10_000 }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Already approved elsewhere.");
  });
});
