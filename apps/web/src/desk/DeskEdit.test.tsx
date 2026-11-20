// PLATFORM_QA INPUT lens: the Inbox's edit-before-signing form (`DeskDetail.tsx` EditForm) with a number
// field. What a person types is sent as the input they sign; a typed "1,200" or a cleared field
// must not reach the API as null or 0.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../App";
import { BILL_ITEM } from "../test/changes";
import { CLIENT_SESSION, fakeApi } from "../test/fixtures";

const SERVICE = { id: "00000000-0000-4000-8000-0000000a0c01", name: "Pia" };
const ME = CLIENT_SESSION.user.id;

const base = {
  "GET /api/session": () => CLIENT_SESSION,
  "GET /api/feedback/status": () => ({ enabled: false }),
  "GET /api/team": () => ({
    members: [
      {
        userId: ME,
        name: "Demo admin",
        email: "admin@demo-client.example.com",
        role: "client_admin",
        canSign: true,
        signs: ["Every change no rule sends to someone else."],
      },
    ],
    settings: { undoSeconds: 60 },
  }),
  "GET /api/overview": () => ({
    client: { id: "00000000-0000-4000-8000-00000000a002", name: "Demo client" },
    services: [],
    needsYou: { inbox: 1 },
    recentRuns: [],
  }),
};

const ORDER = {
  ...BILL_ITEM,
  resolvedBy: null,
  service: SERVICE,
  batchKey: null,
  id: "00000000-0000-4000-8000-0000000d0e01",
  title: "Order plywood",
  payload: {
    tool: "materials.po.send",
    input: { vendor: "Lakeside Lumber", qty: 120, price: "1100.00", note: "3/4 birch" },
    before: null,
  },
  display: {
    connectorName: "Purchasing",
    tool: {
      name: { en: "Purchase order" },
      fields: [
        { label: { en: "Vendor" }, kind: "text", after: "input.vendor" },
        { label: { en: "Sheets" }, kind: "number", after: "input.qty", editable: true },
        { label: { en: "Price" }, kind: "money", after: "input.price", editable: true },
      ],
    },
  },
};

async function edit(key: string, typed: string) {
  const edits: { input: Record<string, unknown> }[] = [];
  const api = fakeApi({
    ...base,
    "GET /api/inbox": ({ url }: { url: URL }) =>
      url.searchParams.get("status") === "resolved" || url.searchParams.get("view") === "snoozed"
        ? { items: [] }
        : { items: [ORDER] },
    [`PUT /api/inbox/${ORDER.id}/edit`]: ({ init }) => {
      const body = JSON.parse(String(init.body)) as { input: Record<string, unknown> };
      edits.push(body);
      return {
        item: {
          id: ORDER.id,
          status: "open",
          deliverAfter: null,
          snoozedUntil: null,
          batchKey: null,
          resolvedAt: null,
        },
        edited: { input: body.input, at: new Date().toISOString() },
      };
    },
  });
  render(
    <MemoryRouter initialEntries={["/desk"]}>
      <AppProviders client={api.client}>
        <AppRoutes />
      </AppProviders>
    </MemoryRouter>,
  );
  const card = await screen.findByTestId("desk-detail");
  await userEvent.click(within(card).getByTestId("desk-edit"));
  const box = within(card).getByTestId(`desk-edit-${key}`);
  await userEvent.clear(box);
  if (typed) await userEvent.type(box, typed);
  await userEvent.click(within(card).getByTestId("desk-edit-save"));
  return { edits, card };
}

describe("INPUT: the Inbox's edit form with a number field", () => {
  it("(PLATFORM_QA INPUT-5) a typed 1,200 is sent as 1200, never as null", async () => {
    const { edits } = await edit("qty", "1,200");
    // Number("1,200") is NaN, and JSON.stringify(NaN) is null.
    await waitFor(() => expect(edits[0]?.input.qty).toBe(1200));
  });

  it("(PLATFORM_QA INPUT-5) a cleared number field is refused on the page, not sent as 0", async () => {
    const { edits, card } = await edit("qty", "");
    // Number("") is 0: the person would sign an order for 0 sheets without having typed a 0.
    expect(await within(card).findByTestId("desk-edit-qty-error")).toHaveTextContent(
      "Type a number, like 1200.",
    );
    expect(edits).toEqual([]);
  });

  it("(PLATFORM_QA INPUT-5) a number that doesn't read as one is refused on the page", async () => {
    const { edits, card } = await edit("qty", "twelve");
    expect(await within(card).findByTestId("desk-edit-qty-error")).toBeInTheDocument();
    expect(edits).toEqual([]);
  });

  it("(PLATFORM_QA INPUT-5) an amount typed as $1,250.50 is sent as decimal text", async () => {
    const { edits } = await edit("price", "$1,250.50");
    await waitFor(() => expect(edits[0]?.input.price).toBe("1250.50"));
  });
});
