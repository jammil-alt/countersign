// P-6: in a conversation's transcript, what a person did (took it over, ended it, changed a
// message) carries copper, like a person's own words; the agent's messages stay ink (brand book).
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Transcript } from "./transcript";

describe("Transcript", () => {
  it("shows a person's action and edit in copper, the agent's message in ink", () => {
    render(
      <Transcript
        testId="t"
        lines={[
          { key: "a", direction: "out", who: "Sent", text: "Which hinges?" },
          {
            key: "b",
            direction: "out",
            who: "Sent",
            text: "Which hinges, Sam?",
            meta: "We changed this before it went",
            metaPerson: true,
          },
          {
            key: "c",
            direction: "out",
            who: "We took the conversation over",
            text: "",
            person: true,
          },
        ]}
      />,
    );
    const [agent, edited, action] = within(screen.getByTestId("t")).getAllByRole("listitem");
    expect(agent?.className).toContain("border-line");
    expect(within(agent as HTMLElement).getByText("Sent").className).toContain("text-ink");
    expect(
      within(edited as HTMLElement).getByText("We changed this before it went").className,
    ).toContain("text-copper-ink");
    expect(action?.className).toContain("border-copper");
    expect(
      within(action as HTMLElement).getByText("We took the conversation over").className,
    ).toContain("text-copper-ink");
  });
});
