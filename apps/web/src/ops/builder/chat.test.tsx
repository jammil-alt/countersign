// The Builder conversation's pending line (feedback, 2026-11-15: "it looks like it is stuck").
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Turns } from "./chat";

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
