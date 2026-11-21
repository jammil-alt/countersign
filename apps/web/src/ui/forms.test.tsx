import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TextArea } from "./forms";

/** jsdom lays nothing out: the words' height is 20px a line, from the value's newlines. */
function fakeScrollHeight() {
  return vi
    .spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get")
    .mockImplementation(function (this: HTMLTextAreaElement) {
      const lines = Math.max(this.rows || 2, this.value.split("\n").length);
      return lines * 20 + 16;
    });
}

afterEach(() => vi.restoreAllMocks());

describe("TextArea autoSize", () => {
  it("is as tall as its words, with no inner scroll or resize handle", () => {
    fakeScrollHeight();
    function Box() {
      const [text, setText] = useState("one");
      return (
        <>
          <TextArea autoSize rows={2} aria-label="Goal" value={text} onChange={() => {}} />
          <button type="button" onClick={() => setText("1\n2\n3\n4\n5\n6\n7")}>
            Grow
          </button>
        </>
      );
    }
    render(<Box />);
    const box = screen.getByLabelText("Goal") as HTMLTextAreaElement;
    expect(box).toHaveClass("resize-none", "overflow-hidden");
    // Two lines at least (the rows), plus padding; borders are 0 in jsdom.
    expect(box.style.height).toBe("56px");
    fireEvent.click(screen.getByRole("button", { name: "Grow" }));
    // Seven lines: nothing cut off at five, as the old brief was.
    expect(box.style.height).toBe("156px");
  });

  it("leaves a plain TextArea alone", () => {
    fakeScrollHeight();
    render(<TextArea aria-label="Notes" rows={3} defaultValue="a" />);
    const box = screen.getByLabelText("Notes") as HTMLTextAreaElement;
    expect(box).not.toHaveClass("resize-none");
    expect(box.style.height).toBe("");
  });

  it("passes its ref on", () => {
    const seen: (HTMLTextAreaElement | null)[] = [];
    render(
      <TextArea
        autoSize
        aria-label="Hint"
        value=""
        onChange={() => {}}
        ref={(el) => {
          seen.push(el);
        }}
      />,
    );
    expect(seen[0]).toBe(screen.getByLabelText("Hint"));
  });
});
