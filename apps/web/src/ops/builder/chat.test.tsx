// The Builder conversation's pending line (feedback, 2026-11-15: "it looks like it is stuck").
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Composer, Turns } from "./chat";

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

describe("Composer", () => {
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
