import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { changeRows, changeTarget, fieldLabel, formatValue } from "./change";
import { InboxCard, type InboxCardItem } from "./InboxCard";

const CHANGE: InboxCardItem = {
  id: "00000000-0000-4000-8000-0000000f0001",
  kind: "external_action",
  title: "Change a record's name or amount. (testkit.record.update)",
  payload: {
    tool: "testkit.record.update",
    verb: "update",
    connector: "testkit",
    connectionId: "c1",
    input: { id: "r1", amount: "12.00", syncToken: "0" },
    before: { id: "r1", name: "Oak board", amount: "10.00", syncToken: "0" },
    stepId: "update",
    onReject: "stop",
    actionId: "a1",
  },
  status: "open",
  runId: "00000000-0000-4000-8000-0000000f0002",
  dueAt: null,
  createdAt: "2026-11-03T10:00:00.000Z",
  resolvedAt: null,
};

function renderCard(props: Partial<Parameters<typeof InboxCard>[0]> = {}) {
  return render(
    <MemoryRouter>
      <InboxCard item={CHANGE} onResolve={null} {...props} />
    </MemoryRouter>,
  );
}

describe("change rows", () => {
  it("pairs the record now with the record after the input, hiding id and version tokens", () => {
    expect(changeRows(CHANGE.payload.before, CHANGE.payload.input)).toEqual([
      { field: "name", now: "Oak board", after: "Oak board", changed: false },
      { field: "amount", now: "10.00", after: "12.00", changed: true },
    ]);
    expect(changeTarget(CHANGE.payload.before, CHANGE.payload.input)).toBe("r1 · Oak board");
  });

  it("has no 'now' for a record the change creates", () => {
    expect(changeRows(null, { name: "Walnut", amount: "5.00" })).toEqual([
      { field: "name", now: undefined, after: "Walnut", changed: true },
      { field: "amount", now: undefined, after: "5.00", changed: true },
    ]);
  });

  it("writes labels and values plainly", () => {
    expect(fieldLabel("unitPrice")).toBe("Unit price");
    expect(fieldLabel("vendor_name")).toBe("Vendor name");
    expect(formatValue(null)).toBe("—");
    expect(formatValue(["a", 2])).toBe("a, 2");
    expect(formatValue({ qty: 2 })).toBe('{"qty":2}');
  });
});

describe("InboxCard: external action", () => {
  it("shows the tool, the target record, and now / after this change with the change marked", () => {
    renderCard();
    const card = screen.getByTestId(`inbox-item-${CHANGE.id}`);
    expect(within(card).getByRole("heading", { level: 3 })).toHaveTextContent(
      "Testkit · r1 · Oak board",
    );
    expect(within(card).getByText("testkit.record.update")).toBeInTheDocument();
    expect(within(card).getByTestId("inbox-item-status")).toHaveTextContent("Needs approval");

    const now = screen.getByTestId("change-now");
    const after = screen.getByTestId("change-after");
    expect(within(now).getByTestId("change-now-row-amount")).toHaveTextContent("Amount10.00");
    expect(within(after).getByTestId("change-after-row-amount")).toHaveTextContent("Amount12.00");
    expect(within(after).getByTestId("change-after-row-amount")).toHaveAttribute(
      "data-changed",
      "true",
    );
    // An unchanged field reads the same on both sides and is not marked.
    expect(within(after).getByTestId("change-after-row-name")).toHaveTextContent("Oak board");
    expect(within(after).getByTestId("change-after-row-name")).not.toHaveAttribute("data-changed");
    // Identity and concurrency fields are not part of the change.
    expect(within(card).queryByText("Sync token")).toBeNull();
    expect(within(now).queryByTestId("change-now-row-id")).toBeNull();
  });

  it("says a create has nothing there yet", () => {
    renderCard({
      item: { ...CHANGE, payload: { ...CHANGE.payload, before: null, input: { name: "Walnut" } } },
    });
    expect(screen.getByTestId("change-now")).toHaveTextContent("Not there yet");
    expect(screen.getByTestId("change-after-row-name")).toHaveTextContent("Walnut");
  });

  it("approves or rejects through the resolve callback, and shows its error", async () => {
    const onResolve = vi.fn().mockResolvedValueOnce(undefined);
    renderCard({ onResolve });
    const approve = screen.getByTestId("inbox-item-approve");
    expect(approve).toHaveTextContent("Approve and update Testkit");
    await userEvent.click(approve);
    expect(onResolve).toHaveBeenCalledWith({ decision: "approve" });

    onResolve.mockRejectedValueOnce(new Error("this change was already rejected"));
    await userEvent.click(screen.getByTestId("inbox-item-reject"));
    expect(onResolve).toHaveBeenLastCalledWith({ decision: "reject" });
    expect(await screen.findByRole("alert")).toHaveTextContent("already rejected");
  });

  it("offers no buttons on someone else's item, and says who it waits on", () => {
    renderCard({ waitingOn: "Waiting on the client admin." });
    expect(screen.queryByTestId("inbox-item-approve")).toBeNull();
    expect(screen.getByText("Waiting on the client admin.")).toBeInTheDocument();
  });
});

describe("InboxCard: a person's question", () => {
  it("sends an answer, or declines", async () => {
    const onResolve = vi.fn().mockResolvedValue(undefined);
    renderCard({
      item: {
        ...CHANGE,
        kind: "request",
        title: "Is CP/CP Baltic birch a new item?",
        payload: { line: "CP/CP Baltic birch 3/4", nodeId: "ask", mode: "ask" },
      },
      onResolve,
    });
    expect(screen.getByText("Line")).toBeInTheDocument();
    expect(screen.queryByText("Node id")).toBeNull();
    const send = screen.getByTestId("inbox-item-answer-send");
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByTestId("inbox-item-answer-input"), "Yes, new");
    await userEvent.click(send);
    expect(onResolve).toHaveBeenCalledWith({ decision: "approve", answer: "Yes, new" });
    await userEvent.click(screen.getByTestId("inbox-item-decline"));
    expect(onResolve).toHaveBeenLastCalledWith({ decision: "reject" });
  });
});
