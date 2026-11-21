// To the point (owner, 2026-11-21): a row's paragraph shows its first sentence, the rest on More.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ShortText, shortOf } from "./short";

describe("shortOf", () => {
  it("is nothing for a text that already fits in one sentence", () => {
    expect(shortOf("The brief names the project manager.")).toBeNull();
    expect(shortOf("  No full stop  ")).toBeNull();
  });

  it("is the first sentence of a longer text", () => {
    expect(
      shortOf("The catalog can read Podio items. It cannot list Podio's built-in tasks."),
    ).toBe("The catalog can read Podio items.");
    expect(shortOf("Which app holds the tasks?\nThe agent reads it every run.")).toBe(
      "Which app holds the tasks?",
    );
  });

  it("cuts a long first sentence on a word", () => {
    const long = `${"word ".repeat(60).trim()}.`;
    const short = shortOf(long) as string;
    expect(short.length).toBeLessThanOrEqual(141);
    expect(short.endsWith("word…")).toBe(true);
  });
});

describe("ShortText", () => {
  it("opens the whole text on More, and closes it on Less", async () => {
    const text = "Tasks are app items. Each person is linked by their Podio user.";
    render(<ShortText text={text} testId="t" />);
    expect(screen.getByTestId("t")).toHaveTextContent("Tasks are app items. More");
    await userEvent.click(screen.getByTestId("t-more"));
    expect(screen.getByTestId("t")).toHaveTextContent(`${text} Less`);
    await userEvent.click(screen.getByTestId("t-more"));
    expect(screen.getByTestId("t")).toHaveTextContent("Tasks are app items. More");
  });

  it("shows a short text as it is, with nothing to open", () => {
    render(<ShortText text="One sentence." testId="t" />);
    expect(screen.getByTestId("t")).toHaveTextContent("One sentence.");
    expect(screen.queryByTestId("t-more")).toBeNull();
  });
});
