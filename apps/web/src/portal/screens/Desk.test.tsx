// Your Desk (`/desk`, docs/ui-plan.md C3): the list by day and the open item. A QuickBooks change
// reads like the record (the bill's number and vendor, its lines with totals, money in the reader's
// language), never a tool id or a raw object, and signs with the tool's name; the signature can be
// undone inside its window. One step's batch is signed in part; "Not now" snoozes; a question takes
// an answer; a change's editable fields are edited before signing; a viewer sees and never signs.
// The shell's Desk count follows every action. `/inbox` lands here.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { AppProviders, AppRoutes } from "../../App";
import { BILL_ITEM } from "../../test/changes";
import { CLIENT_SESSION, fakeApi } from "../../test/fixtures";

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

function team(canSign = true) {
  return {
    members: [
      {
        userId: ME,
        name: "Demo admin",
        email: "admin@demo-client.example.com",
        role: "client_admin",
        canSign,
        signs: canSign
          ? ["Every change no rule sends to someone else."]
          : ["Sees everything, signs nothing."],
      },
    ],
    settings: { undoSeconds: 60 },
  };
}

type Lists = { open?: unknown[]; snoozed?: unknown[]; resolved?: unknown[] };

/** `GET /api/inbox` by its query: waiting, snoozed or resolved. */
function inbox(lists: () => Lists) {
  return ({ url }: { url: URL }) => {
    const l = lists();
    const status = url.searchParams.get("status") ?? "open";
    if (status === "resolved") return { items: l.resolved ?? [] };
    if (url.searchParams.get("view") === "snoozed") return { items: l.snoozed ?? [] };
    return { items: l.open ?? [] };
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

const base = {
  "GET /api/session": () => CLIENT_SESSION,
  "GET /api/feedback/status": () => ({ enabled: false }),
  "GET /api/team": () => team(),
};

describe("Your Desk: a QuickBooks change", () => {
  it("shows the bill as the client knows it, signs with the tool's name, and undoes in the window", async () => {
    let open = true;
    const resolved: unknown[] = [];
    let undone = 0;
    const deliverAfter = new Date(Date.now() + 60_000).toISOString();
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(open ? 1 : 0),
      "GET /api/inbox": inbox(() => ({ open: open ? [ITEM] : [] })),
      [`POST /api/inbox/${ITEM.id}/resolve`]: ({ init }) => {
        resolved.push(JSON.parse(String(init.body)));
        open = false;
        return {
          item: {
            ...ITEM,
            status: "resolved",
            resolvedAt: new Date().toISOString(),
            resolvedBy: { id: ME, name: "Demo admin" },
            deliverAfter,
          },
        };
      },
      [`POST /api/inbox/${ITEM.id}/undo`]: () => {
        undone += 1;
        open = true;
        return {
          item: {
            id: ITEM.id,
            status: "open",
            deliverAfter: null,
            snoozedUntil: null,
            batchKey: null,
            resolvedAt: null,
          },
        };
      },
    });
    // The old address lands on the Desk.
    renderAt("/inbox", api);

    const entry = await screen.findByTestId(`desk-entry-${ITEM.id}`);
    expect(entry).toHaveTextContent("Pia");
    expect(screen.getByTestId("desk-requests")).toHaveAttribute("href", "/requests");
    expect(entry).toHaveTextContent("Sign");
    expect(entry).toHaveTextContent("QuickBooks bill 20418 · Northline Panel Supply");

    const card = await screen.findByTestId("desk-detail");
    expect(within(card).getByRole("heading", { level: 2 })).toHaveTextContent(
      "QuickBooks bill 20418 · Northline Panel Supply",
    );
    expect(within(card).getByTestId("desk-band")).toHaveTextContent("Waiting on you");
    expect(within(card).getByTestId("desk-description")).toHaveTextContent(
      "Replace the bill's lines with the items on the vendor's invoice. The total stays the same.",
    );
    expect(within(card).getByTestId("change-same-now-row-total")).toHaveTextContent("$9,742.35");
    const after = within(card).getByTestId("change-lines-after");
    expect(within(after).getByTestId("change-lines-after-item-0")).toHaveTextContent(
      "Baltic birch 3/4 4x8",
    );
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

    const count = screen.getByTestId("shell-inbox");
    await waitFor(() => expect(count).toHaveTextContent("1"));

    const sign = within(card).getByTestId("desk-sign");
    expect(sign).toHaveTextContent("Sign and update QuickBooks Online");
    await userEvent.click(sign);
    expect(resolved).toEqual([{ decision: "approve" }]);
    // Signed: the card stays, in copper, with Undo while the window lasts; the count follows.
    expect(await within(card).findByTestId("desk-outcome")).toHaveTextContent("Signed by you");
    expect(within(card).getByTestId("desk-undo-left")).toHaveTextContent(/seconds to undo/);
    await waitFor(() => expect(count).toHaveTextContent("0"));

    await userEvent.click(within(card).getByTestId("desk-undo"));
    expect(undone).toBe(1);
    expect(await within(card).findByTestId("desk-sign")).toBeInTheDocument();
    await waitFor(() => expect(count).toHaveTextContent("1"));
  });

  it("reads in the client's language", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/session": () => ({
        ...CLIENT_SESSION,
        language: { effective: "es", user: "es", client: null },
      }),
      "GET /api/overview": () => overview(1),
      "GET /api/inbox": inbox(() => ({ open: [ITEM] })),
    });
    renderAt("/desk", api);
    const card = await screen.findByTestId("desk-detail");
    expect(within(card).getByRole("heading", { level: 2 })).toHaveTextContent(
      "Factura de QuickBooks 20418 · Northline Panel Supply",
    );
    expect(within(card).getByTestId("change-same-now-row-total")).toHaveTextContent("9742,35");
    expect(within(card).getByTestId("desk-sign")).toHaveTextContent(
      "Firmar y actualizar QuickBooks Online",
    );
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Su escritorio");
  });
});

describe("Your Desk: batches, not now, questions, edits", () => {
  it("signs part of one step's batch", async () => {
    const key = `${ITEM.runId}:send`;
    const one = { ...ITEM, id: "00000000-0000-4000-8000-0000000b0001", batchKey: key };
    const two = { ...ITEM, id: "00000000-0000-4000-8000-0000000b0002", batchKey: key };
    const bodies: unknown[] = [];
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(2),
      "GET /api/inbox": inbox(() => ({ open: [one, two] })),
      "POST /api/inbox/batch/resolve": ({ init }) => {
        bodies.push(JSON.parse(String(init.body)));
        return {
          items: [
            {
              id: one.id,
              status: "resolved",
              deliverAfter: new Date(Date.now() + 60_000).toISOString(),
              snoozedUntil: null,
              batchKey: key,
              resolvedAt: new Date().toISOString(),
            },
          ],
        };
      },
    });
    renderAt("/desk", api);
    // One entry for the two changes.
    const entry = await screen.findByTestId(`desk-entry-${one.id}`);
    expect(entry).toHaveTextContent("2 changes");
    expect(screen.queryByTestId(`desk-entry-${two.id}`)).toBeNull();

    const card = await screen.findByTestId("desk-detail");
    const sign = within(card).getByTestId("desk-sign");
    expect(sign).toHaveTextContent("Sign all 2");
    await userEvent.click(within(card).getByTestId(`desk-batch-tick-${two.id}`));
    expect(sign).toHaveTextContent("Sign 1 of 2");
    await userEvent.click(sign);
    expect(bodies).toEqual([{ batchKey: key, approve: [one.id], reject: [] }]);
    expect(await within(card).findByTestId("desk-outcome")).toHaveTextContent("1 of 2 done by you");
  });

  it("puts an item off until tomorrow with Not now", async () => {
    const snoozes: { until: string }[] = [];
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(1),
      "GET /api/inbox": inbox(() => ({ open: snoozes.length ? [] : [ITEM] })),
      [`POST /api/inbox/${ITEM.id}/snooze`]: ({ init }) => {
        const body = JSON.parse(String(init.body)) as { until: string };
        snoozes.push(body);
        return {
          item: {
            id: ITEM.id,
            status: "open",
            deliverAfter: null,
            snoozedUntil: body.until,
            batchKey: null,
            resolvedAt: null,
          },
        };
      },
    });
    renderAt("/desk", api);
    const card = await screen.findByTestId("desk-detail");
    await userEvent.click(within(card).getByTestId("desk-not-now"));
    await userEvent.click(within(card).getByTestId("desk-snooze-tomorrow"));
    expect(snoozes).toHaveLength(1);
    const until = new Date(snoozes[0]?.until ?? "");
    expect(until.getHours()).toBe(8);
    expect(until.getTime()).toBeGreaterThan(Date.now());
    expect(await within(card).findByTestId("desk-band")).toHaveTextContent("Set aside for later");
  });

  it("answers a question, and lists it under Questions", async () => {
    const question = {
      ...ITEM,
      id: "00000000-0000-4000-8000-0000000c0001",
      kind: "request",
      title: 'Is "CP/CP BB 3/4" Baltic birch 3/4"?',
      payload: { question: 'Is "CP/CP BB 3/4" Baltic birch 3/4"?' },
      display: null,
    };
    const answers: unknown[] = [];
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(2),
      "GET /api/inbox": inbox(() => ({ open: [ITEM, question] })),
      [`POST /api/inbox/${question.id}/resolve`]: ({ init }) => {
        answers.push(JSON.parse(String(init.body)));
        return { item: { ...question, status: "resolved", resolvedAt: new Date().toISOString() } };
      },
    });
    renderAt("/desk", api);
    // The list is in before the view changes, so the count is there.
    await screen.findByTestId(`desk-entry-${question.id}`);
    await userEvent.click(screen.getByTestId("desk-view-questions"));
    expect(screen.getByTestId("desk-view-questions")).toHaveTextContent("Questions · 1");
    expect(screen.queryByTestId(`desk-entry-${ITEM.id}`)).toBeNull();
    // The view opens its first item.
    await waitFor(() =>
      expect(screen.getByTestId("desk-band")).toHaveTextContent("Waiting on your answer"),
    );
    const card = screen.getByTestId("desk-detail");
    await userEvent.type(within(card).getByTestId("desk-answer-input"), "Yes, the same sheet");
    await userEvent.click(within(card).getByTestId("desk-answer-send"));
    expect(answers).toEqual([{ decision: "approve", answer: "Yes, the same sheet" }]);
    expect(await within(card).findByTestId("desk-outcome")).toHaveTextContent("Answered by you");
  });

  it("edits a change's editable fields before signing", async () => {
    const mail = {
      ...ITEM,
      id: "00000000-0000-4000-8000-0000000d0001",
      title: "Send a reminder",
      payload: {
        tool: "gmail.message.send",
        input: { to: "jen@lakeside.example.com", subject: "Invoice 1043", body: "Hi Jen" },
        before: null,
      },
      display: {
        connectorName: "Gmail",
        tool: {
          name: { en: "Email" },
          fields: [
            { label: { en: "To" }, kind: "text", after: "input.to" },
            { label: { en: "Subject" }, kind: "text", after: "input.subject", editable: true },
          ],
        },
      },
    };
    const edits: unknown[] = [];
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(1),
      "GET /api/inbox": inbox(() => ({ open: [mail] })),
      [`PUT /api/inbox/${mail.id}/edit`]: ({ init }) => {
        const body = JSON.parse(String(init.body)) as { input: Record<string, unknown> };
        edits.push(body);
        return {
          item: {
            id: mail.id,
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
    renderAt("/desk", api);
    const card = await screen.findByTestId("desk-detail");
    await userEvent.click(within(card).getByTestId("desk-edit"));
    // Only the subject is offered; the recipient stays the agent's.
    expect(within(card).queryByTestId("desk-edit-to")).toBeNull();
    const subject = within(card).getByTestId("desk-edit-subject");
    await userEvent.clear(subject);
    await userEvent.type(subject, "Invoice 1043, now 62 days");
    await userEvent.click(within(card).getByTestId("desk-edit-save"));
    expect(edits).toEqual([
      {
        input: {
          to: "jen@lakeside.example.com",
          subject: "Invoice 1043, now 62 days",
          body: "Hi Jen",
        },
      },
    ]);
    expect(await within(card).findByTestId("desk-edited")).toBeInTheDocument();
    expect(within(card).getByTestId("desk-sign")).toBeInTheDocument();
  });

  it("shows a viewer the item without its buttons", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/team": () => team(false),
      "GET /api/overview": () => overview(1),
      "GET /api/inbox": inbox(() => ({ open: [ITEM] })),
    });
    renderAt("/desk", api);
    const card = await screen.findByTestId("desk-detail");
    expect(await within(card).findByText(/you don't sign for your team/)).toBeInTheDocument();
    expect(within(card).queryByTestId("desk-sign")).toBeNull();
    expect(screen.getByTestId("desk-team")).toHaveTextContent("Sees everything, signs nothing.");
  });

  it("says so when nothing waits", async () => {
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(0),
      "GET /api/inbox": inbox(() => ({})),
    });
    renderAt("/desk", api);
    expect(await screen.findByTestId("desk-entries")).toHaveTextContent(
      "Nothing waits on you right now.",
    );
  });
});

describe("portal header: the Desk count", () => {
  it("counts an approval that opened after the portal loaded, on the next page", async () => {
    let count = 0;
    const api = fakeApi({
      ...base,
      "GET /api/overview": () => overview(count),
      "GET /api/inbox": inbox(() => ({ open: count > 0 ? [ITEM] : [] })),
    });
    renderAt("/", api);
    const desk = await screen.findByTestId("shell-inbox");
    await waitFor(() => expect(desk).toHaveTextContent("0"));

    // The Bill clerk proposes the change while the client has the portal open.
    count = 1;
    await userEvent.click(screen.getByTestId("portal-nav-desk"));
    await screen.findByTestId(`desk-entry-${ITEM.id}`);
    await waitFor(() => expect(desk).toHaveTextContent("1"));
  });
});
