// The Builder conversation's pending line (feedback, 2026-11-15: "it looks like it is stuck").

import type { BuilderTurnView } from "@countersign/core";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Composer, Turns, threadsOf } from "./chat";

describe("Turns", () => {
  it("shows the Drafting loop while the Builder answers, and says so in words", () => {
    render(<Turns turns={[]} pending="Build me an invoice agent" />);
    const line = screen.getByTestId("builder-thinking");
    expect(line).toHaveAttribute("role", "status");
    expect(line).toHaveTextContent("The Builder is working on it…");
    expect(line.querySelector(".mz-think--drafting")).not.toBeNull();
  });

  it("shows no loop when nothing is pending", () => {
    render(<Turns turns={[]} pending={null} empty={<p>Nothing yet</p>} />);
    expect(screen.queryByTestId("builder-thinking")).toBeNull();
  });
});

// Owner, 2026-11-21 (docs/plan.md §1.177): "hard to tell what the builder is talking about, maybe
// we can keep threads per step? Maybe collapsible?"
describe("threads", () => {
  const t = (seq: number, over: Partial<BuilderTurnView> = {}): BuilderTurnView => ({
    id: `t${seq}`,
    seq,
    role: seq % 2 === 1 ? "operator" : "builder",
    text: `turn ${seq}`,
    command: null,
    changes: [],
    questions: [],
    gaps: [],
    notes: [],
    errors: [],
    savedVersionId: null,
    costUsd: "0",
    undoneAt: null,
    createdAt: "2026-11-21T10:00:00.000Z",
    ...over,
  });
  const onA = { focus: { stepId: "a", name: "Read the bill" } };
  const onB = { focus: { stepId: "b", name: "Ask the owner" } };
  const change = { id: "step:a", label: "~ step", undone: false };
  const turns = [
    t(1),
    t(2),
    t(3, onA),
    t(4, { changes: [change] }),
    t(5, onA),
    t(6),
    t(7, onB),
    t(8),
    // An Undo, sent with no step, of the change made on Read the bill.
    t(9, {
      command: "/undo",
      changes: [{ ...change, undoes: { turnId: "t4", changeId: "step:a" } }],
    }),
  ];

  it("groups the conversation by what each turn was about, an Undo with its change", () => {
    expect(threadsOf(turns).map((x) => [x.stepId, x.turns.map((y) => y.seq)])).toEqual([
      [null, [1, 2]],
      ["a", [3, 4, 5, 6]],
      ["b", [7, 8]],
      ["a", [9]],
    ]);
  });

  it("opens the step's own thread and folds the others to a line each", async () => {
    const user = userEvent.setup();
    render(<Turns turns={turns} thread={{ stepId: "b" }} />);
    expect(screen.getByTestId("builder-turn-7")).toBeInTheDocument();
    expect(screen.queryByTestId("builder-turn-3")).toBeNull();
    const folded = screen.getAllByTestId("builder-thread-toggle");
    expect(folded.map((b) => b.textContent)).toEqual([
      "About the whole workflow · 2 messages",
      "On “Read the bill” · 4 messages",
      "On “Read the bill” · 1 message",
    ]);
    await user.click(folded[1] as HTMLElement);
    expect(screen.getByTestId("builder-turn-3")).toBeInTheDocument();
    await user.click(folded[1] as HTMLElement);
    expect(screen.queryByTestId("builder-turn-3")).toBeNull();
  });

  it("on the whole workflow, keeps the newest thread open so the last answer shows", () => {
    render(<Turns turns={turns.slice(0, 8)} thread={{ stepId: null }} />);
    expect(screen.getByTestId("builder-turn-1")).toBeInTheDocument();
    expect(screen.queryByTestId("builder-turn-3")).toBeNull();
    expect(screen.getByTestId("builder-turn-8")).toBeInTheDocument();
  });

  it("says what to do when nothing was said about this step yet", () => {
    render(
      <Turns turns={turns.slice(0, 4)} thread={{ stepId: "b" }} empty={<p>Ask about it</p>} />,
    );
    expect(screen.getByText("Ask about it")).toBeInTheDocument();
  });
});

describe("Composer", () => {
  it("leaves the /command chips out of the small box of a step", () => {
    const { rerender } = render(
      <Composer placeholder="x" busy={false} onSend={async () => true} />,
    );
    expect(screen.getByTestId("builder-composer-skill")).toBeInTheDocument();
    rerender(<Composer compact placeholder="x" busy={false} onSend={async () => true} />);
    expect(screen.queryByTestId("builder-composer-skill")).toBeNull();
  });

  /** A send the test finishes by hand. */
  function deferred() {
    let finish: (ok: boolean) => void = () => {};
    const sends: string[] = [];
    const onSend = (text: string) => {
      sends.push(text);
      return new Promise<boolean>((resolve) => {
        finish = resolve;
      });
    };
    return { onSend, sends, finish: (ok: boolean) => finish(ok) };
  }

  it("empties the box as soon as the message goes (feedback, 2026-11-11)", async () => {
    const d = deferred();
    render(<Composer placeholder="Ask" busy={false} onSend={d.onSend} testId="c" />);
    await userEvent.type(screen.getByTestId("c-input"), "Add a step");
    await userEvent.click(screen.getByTestId("c-send"));
    expect(d.sends).toEqual(["Add a step"]);
    expect(screen.getByTestId("c-input")).toHaveValue("");
    await act(async () => d.finish(true));
    expect(screen.getByTestId("c-input")).toHaveValue("");
  });

  it("puts the text back when the turn fails", async () => {
    const d = deferred();
    render(<Composer placeholder="Ask" busy={false} onSend={d.onSend} testId="c" />);
    await userEvent.type(screen.getByTestId("c-input"), "Add a step");
    await userEvent.click(screen.getByTestId("c-send"));
    await act(async () => d.finish(false));
    expect(screen.getByTestId("c-input")).toHaveValue("Add a step");
  });
});
