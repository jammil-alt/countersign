// The portal inbox's approval card for a change to the client's QuickBooks (docs/plan.md "Inbox
// and run views"): it reads like the record (the bill's number and vendor, its lines as a table with
// totals, money in the reader's language), never a tool id or a raw object, and signs with the
// tool's name. The header's Inbox count follows the inbox: it reloads on each page and after a
// resolve, so an approval that opens while the portal is open is counted.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { BILL_ITEM } from "../../test/changes";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

const ITEM = { ...BILL_ITEM, resolvedBy: null };

function overview(inbox: number) {
  return {
    client: { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client" },
    services: [],
    needsYou: { inbox },
    recentRuns: [],
  };
}

function renderAt(path: string, api: ReturnType<typeof fakeApi>) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
}

describe("portal inbox: a QuickBooks change", () => {
  it("shows the bill as the client knows it and signs with the tool's name", async () => {
    let open = true;
    const resolved: unknown[] = [];
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/overview": () => overview(open ? 1 : 0),
      "GET /api/inbox": () => ({ items: open ? [ITEM] : [] }),
      [`POST /api/inbox/${ITEM.id}/resolve`]: ({ init }) => {
        resolved.push(JSON.parse(String(init.body)));
        open = false;
        return { item: { ...ITEM, status: "resolved", resolvedAt: "2026-11-06T10:05:00.000Z" } };
      },
    });
    renderAt("/inbox", api);

    const card = await screen.findByTestId(`inbox-item-${ITEM.id}`);
    expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent(
      "QuickBooks bill 20418 · Northline Panel Supply",
    );
    expect(within(card).getByTestId("inbox-item-description")).toHaveTextContent(
      "Replace the bill's lines with the items on the vendor's invoice. The total stays the same.",
    );
    // The bill now: its one line and its total, in full.
    expect(within(card).getByTestId("change-now-row-total")).toHaveTextContent("$9,742.35");
    expect(within(card).getByTestId("change-lines-now-item-0")).toHaveTextContent(
      "Northline invoice 20418",
    );
    // After: the invoice's items by name, qty × unit price, amounts and the same total.
    const after = within(card).getByTestId("change-lines-after");
    expect(within(after).getByTestId("change-lines-after-item-0")).toHaveTextContent(
      "Baltic birch 3/4 4x8",
    );
    expect(within(after).getByTestId("change-lines-after-item-1")).toHaveTextContent("$1,192.35");
    expect(within(after).getByTestId("change-lines-after-total")).toHaveTextContent("$9,742.35");
    // Nothing for the machine: no tool id, no ids or guards, no raw objects, no "Qbo".
    const text = card.textContent ?? "";
    for (const hidden of [
      "qbo.bill.update_lines",
      "Qbo",
      "Replace line ids",
      "Expected total",
      "Sync token",
      "{",
    ]) {
      expect(text).not.toContain(hidden);
    }

    // The header counts the open approval.
    const inbox = screen.getByTestId("shell-inbox");
    await waitFor(() => expect(inbox).toHaveTextContent("1"));

    const sign = within(card).getByTestId("inbox-item-approve");
    expect(sign).toHaveTextContent("Sign and update QuickBooks Online");
    await userEvent.click(sign);
    expect(resolved).toEqual([{ decision: "approve" }]);
    // Signed: the header's count follows at once.
    await waitFor(() => expect(inbox).toHaveTextContent("0"));
  });

  it("reads in the client's language", async () => {
    const api = fakeApi({
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        language: { effective: "es", user: "es", client: null },
      }),
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/overview": () => overview(1),
      "GET /api/inbox": () => ({ items: [ITEM] }),
    });
    renderAt("/inbox", api);
    const card = await screen.findByTestId(`inbox-item-${ITEM.id}`);
    expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent(
      "Factura de QuickBooks 20418 · Northline Panel Supply",
    );
    expect(within(card).getByTestId("change-lines")).toHaveAccessibleName("Líneas");
    expect(within(card).getByTestId("change-now-row-total")).toHaveTextContent("9742,35");
    expect(within(card).getByTestId("inbox-item-approve")).toHaveTextContent(
      "Firmar y actualizar QuickBooks Online",
    );
  });
});

describe("portal header: the Inbox count", () => {
  it("counts an approval that opened after the portal loaded, on the next page", async () => {
    let count = 0;
    const api = fakeApi({
      "GET /api/session": () => CLIENT_SESSION,
      "GET /api/feedback/status": () => ({ enabled: false }),
      "GET /api/overview": () => overview(count),
      "GET /api/inbox": () => ({ items: count > 0 ? [ITEM] : [] }),
    });
    renderAt("/", api);
    const inbox = await screen.findByTestId("shell-inbox");
    await waitFor(() => expect(inbox).toHaveTextContent("0"));

    // The Bill clerk proposes the change while the client has the portal open.
    count = 1;
    await userEvent.click(screen.getByTestId("portal-nav-inbox"));
    await screen.findByTestId(`inbox-item-${ITEM.id}`);
    await waitFor(() => expect(inbox).toHaveTextContent("1"));
  });
});
