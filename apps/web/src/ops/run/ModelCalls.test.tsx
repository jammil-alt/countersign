import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ModelCalls } from "./RunControls";

const STEP = "00000000-0000-4000-8000-0000000f2001";

describe("ModelCalls", () => {
  it("names a step's model use that wasn't recorded call by call, never 'no model calls'", () => {
    render(
      <ModelCalls
        calls={[]}
        names={new Map([[STEP, "Read the invoice"]])}
        unrecorded={[
          { stepRunId: STEP, nodeId: "read", tokensIn: 20000, tokensOut: 2400, costUsd: "0.1100" },
        ]}
      />,
    );
    const card = screen.getByTestId("ops-run-model-calls-unrecorded");
    expect(card).toHaveTextContent("Read the invoice: 22,400 tokens");
    expect(card).toHaveTextContent("$0.11");
    expect(screen.queryByText("This run made no model calls.")).toBeNull();
  });

  it("says a run made no model calls when nothing is missing either", () => {
    render(<ModelCalls calls={[]} names={new Map()} />);
    expect(screen.getByText("This run made no model calls.")).toBeInTheDocument();
  });
});
