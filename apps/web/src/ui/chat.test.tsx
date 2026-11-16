// Conversations with an agent: a reply's Markdown habits read as plain words with its lists kept,
// Enter sends and Shift+Enter starts a new line, and the agent at work says for how long.
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatInput, ChatText, chatBlocks, plainWords, Thinking } from "./chat";

describe("ChatText", () => {
  it("drops bold and headings, keeps paragraphs and lists", () => {
    const text = [
      "## Runs",
      "Sloan has 9 runs. All **succeeded**.",
      "",
      "**Demo client** (UTC): 5 runs",
      "- Nov 15: run 2496b2c1",
      "- Nov 14: run ca8218a3",
      "  about 5 seconds",
      "",
      "1. First",
      "2. Second",
      "Want me to open them?",
    ].join("\n");
    expect(chatBlocks(text)).toEqual([
      { kind: "p", lines: ["Runs", "Sloan has 9 runs. All succeeded."] },
      { kind: "p", lines: ["Demo client (UTC): 5 runs"] },
      { kind: "ul", items: ["Nov 15: run 2496b2c1", "Nov 14: run ca8218a3 about 5 seconds"] },
      { kind: "ol", items: ["First", "Second"] },
      { kind: "p", lines: ["Want me to open them?"] },
    ]);
    render(<ChatText text={text} testId="reply" />);
    const reply = screen.getByTestId("reply");
    expect(reply).not.toHaveTextContent("**");
    expect(reply.querySelectorAll("ul li")).toHaveLength(2);
    expect(reply.querySelectorAll("ol li")).toHaveLength(2);
  });

  it("keeps a numbered list one list when its items are a blank line apart", () => {
    // Feedback (2026-11-16): the Builder's six problems all read "1.".
    const text = "Here are the problems.\n\n1. First\n\n2. Second\n\n3. Third\n\nThen publish.";
    expect(chatBlocks(text)).toEqual([
      { kind: "p", lines: ["Here are the problems."] },
      { kind: "ol", items: ["First", "Second", "Third"] },
      { kind: "p", lines: ["Then publish."] },
    ]);
    render(<ChatText text={text} testId="loose" />);
    expect(screen.getByTestId("loose").querySelectorAll("ol")).toHaveLength(1);
    // A list that starts past 1 keeps its number.
    expect(chatBlocks("4. Fourth\n5. Fifth")).toEqual([
      { kind: "ol", items: ["Fourth", "Fifth"], start: 4 },
    ]);
  });

  it("leaves snake_case, single stars and plain sentences alone", () => {
    expect(plainWords("runs_list read 2 * 3 rows")).toBe("runs_list read 2 * 3 rows");
    expect(plainWords("`clients_list` and __this__")).toBe("clients_list and this");
  });
});

function Box({ onSend }: { onSend(text: string): void }) {
  const [text, setText] = useState("");
  return (
    <ChatInput
      aria-label="Message"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onSend={() => {
        onSend(text);
        setText("");
      }}
    />
  );
}

describe("ChatInput", () => {
  it("sends on Enter and starts a new line on Shift+Enter", async () => {
    const sent: string[] = [];
    render(<Box onSend={(t) => sent.push(t)} />);
    const box = screen.getByLabelText("Message");
    await userEvent.type(box, "First line{Shift>}{Enter}{/Shift}second line");
    expect(box).toHaveValue("First line\nsecond line");
    expect(sent).toEqual([]);
    await userEvent.type(box, "{Enter}");
    expect(sent).toEqual(["First line\nsecond line"]);
    expect(box).toHaveValue("");
  });
});

describe("Thinking", () => {
  afterEach(() => vi.useRealTimers());

  it("says how long once it's more than a few seconds", () => {
    vi.useFakeTimers();
    const since = Date.now();
    render(<Thinking label="Reggie is looking into it" since={since} testId="thinking" />);
    const el = screen.getByTestId("thinking");
    expect(el).toHaveAttribute("role", "status");
    // The design system's thinking loop (agent motion); Drafting unless told otherwise.
    expect(el.querySelector(".mz-think--drafting")).not.toBeNull();
    expect(el).toHaveTextContent("Reggie is looking into it");
    expect(el).not.toHaveTextContent(" s");
    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(el).toHaveTextContent("Reggie is looking into it · 7 s");
  });
});
