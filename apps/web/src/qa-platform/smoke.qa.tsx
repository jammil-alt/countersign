// Harness smoke check for the platform QA web repros: jsdom and testing-library come up.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

describe("qa web harness", () => {
  it("QA-SMOKE: renders in jsdom", () => {
    render(<p>ready</p>);
    expect(screen.getByText("ready")).toBeInTheDocument();
  });
});
