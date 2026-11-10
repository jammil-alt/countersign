// R5 (ARCHITECTURE §10.14 "Undo"): an answer after the run went ahead, on its item. A late no to a
// write that can be taken back offers Undo, which only the press runs; a write that can't be taken
// back says so; the portal never shows the tool's id or the server's English reasons.

import type { UndoChangeResult } from "@countersign/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { InboxCard, type InboxCardItem } from "./InboxCard";
import { LateAnswer } from "./LateAnswer";

const LATE_NO = {
  at: "2026-11-10T15:00:00.000Z",
  by: "00000000-0000-4000-8000-0000000000u1",
  approved: false,
  actionId: "a1",
  actionStatus: "done",
};
const OFFER = {
  actionId: "a1",
  tool: "testkit.record.update",
  text: "Can be taken back with testkit.record.restore, if nobody changed it since.",
  for: [LATE_NO.by],
  lead: true,
  status: "offered",
};

function late(payload: Record<string, unknown>, onUndo: (() => Promise<UndoChangeResult>) | null) {
  return render(
    <I18nProvider locale="en" browser={["en-US"]}>
      <LateAnswer payload={payload} surface="portal" onUndo={onUndo} />
    </I18nProvider>,
  );
}

describe("LateAnswer", () => {
  it("shows nothing on an item answered in time", () => {
    late({ tool: "x" }, null);
    expect(screen.queryByTestId("inbox-late")).toBeNull();
  });

  it("offers the undo and runs it only when pressed", async () => {
    const undo = vi.fn(
      async (): Promise<UndoChangeResult> => ({
        itemId: "i1",
        undo: { status: "done", undoActionId: "a2" },
      }),
    );
    late({ lateAnswer: LATE_NO, undo: OFFER }, undo);
    expect(screen.getByTestId("inbox-late-answer").textContent).toMatch(
      /^Answered no at .+, after we had gone ahead\.$/,
    );
    expect(screen.getByTestId("inbox-late-state").textContent).toBe(
      "We can put the change back, if nobody has changed it since.",
    );
    // The portal never shows the tool's id.
    expect(screen.getByTestId("inbox-late").textContent).not.toContain("testkit");
    expect(undo).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("inbox-late-undo"));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("inbox-late-state").textContent).toBe(
      "Undone. We put the change back.",
    );
    expect(screen.queryByTestId("inbox-late-undo")).toBeNull();
  });

  it("says why a refused undo left the record as it is, in the client's words", async () => {
    late({ lateAnswer: LATE_NO, undo: OFFER }, async () => ({
      itemId: "i1",
      undo: {
        status: "refused",
        code: "changed_since",
        reason: "the record changed after our write",
      },
    }));
    await userEvent.click(screen.getByTestId("inbox-late-undo"));
    expect(screen.getByTestId("inbox-late-refused").textContent).toBe(
      "Someone changed it after us, so we left it as it is.",
    );
    // The offer stays open.
    expect(screen.getByTestId("inbox-late-undo")).toBeTruthy();
  });

  it("explains that a sent message can't be undone", () => {
    late({ lateAnswer: LATE_NO }, async () => {
      throw new Error("never called");
    });
    expect(screen.getByTestId("inbox-late").getAttribute("data-state")).toBe("none");
    expect(screen.getByTestId("inbox-late-state").textContent).toContain(
      "Sent messages can't be taken back",
    );
    expect(screen.queryByTestId("inbox-late-undo")).toBeNull();
  });

  it("reads a done offer as done, and a late yes as nothing to do", () => {
    const { unmount } = late({ lateAnswer: LATE_NO, undo: { ...OFFER, status: "done" } }, null);
    expect(screen.getByTestId("inbox-late").getAttribute("data-state")).toBe("done");
    unmount();
    late({ lateAnswer: { ...LATE_NO, approved: true } }, null);
    expect(screen.getByTestId("inbox-late-state").textContent).toBe("Nothing more to do.");
  });

  it("speaks the client's language", () => {
    render(
      <I18nProvider locale="es" browser={["es-ES"]}>
        <LateAnswer payload={{ lateAnswer: LATE_NO, undo: OFFER }} surface="portal" onUndo={null} />
      </I18nProvider>,
    );
    expect(screen.getByTestId("inbox-late-state").textContent).toBe(
      "Podemos deshacer el cambio, si nadie lo ha modificado desde entonces.",
    );
  });
});

describe("InboxCard with a late no (back office)", () => {
  const item: InboxCardItem = {
    id: "00000000-0000-4000-8000-0000000f0009",
    kind: "review",
    title: "Answered after we went ahead: Update the bill",
    payload: {
      reason: "They said no after we went ahead without their answer.",
      sourceItemId: "i0",
      actionId: "a1",
      lateAnswer: LATE_NO,
      undo: OFFER,
    },
    status: "open",
    runId: null,
    dueAt: null,
    createdAt: "2026-11-10T15:00:00.000Z",
    resolvedAt: null,
  };

  it("shows the tool's undo line and presses the surface's route", async () => {
    const undo = vi.fn(
      async (): Promise<UndoChangeResult> => ({
        itemId: item.id,
        undo: { status: "failed", undoActionId: "a2", reason: "QuickBooks said no" },
      }),
    );
    render(
      <MemoryRouter>
        <InboxCard item={item} onResolve={null} onUndoChange={undo} surface="ops" />
      </MemoryRouter>,
    );
    // The payload's plumbing is not listed as facts.
    expect(screen.queryByText("Late answer")).toBeNull();
    expect(screen.getByTestId("inbox-late-tool").textContent).toContain("testkit.record.restore");
    await userEvent.click(screen.getByTestId("inbox-late-undo"));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("inbox-late").getAttribute("data-state")).toBe("failed");
    expect(screen.getByText("QuickBooks said no")).toBeTruthy();
  });
});
