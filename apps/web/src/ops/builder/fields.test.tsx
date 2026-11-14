import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { NO_ERRORS, ReferenceNames, SchemaForm } from "./fields";

const names = (id: string) => (id === "match" ? "Find the bill" : null);

function Form({ initial }: { initial: Record<string, unknown> }) {
  const [value, setValue] = useState(initial);
  return (
    <ReferenceNames.Provider value={names}>
      <SchemaForm
        schema={{
          type: "object",
          properties: {
            ids: { type: "array", items: { type: "string" } },
            memo: { type: "string" },
          },
        }}
        value={value}
        onChange={setValue}
        paths={[
          { path: "steps.match.output.bill.recordId", schema: { type: "string" }, stepId: "match" },
        ]}
        prefix="input"
        errors={NO_ERRORS}
        testPrefix="f"
      />
      <output data-testid="value">{JSON.stringify(value)}</output>
    </ReferenceNames.Provider>
  );
}

describe("builder fields", () => {
  it("shows a reference by its step's name, and its raw text while editing", async () => {
    const user = userEvent.setup();
    render(<Form initial={{ memo: "Bill {{steps.match.output.bill.recordId}}" }} />);
    const view = screen.getByTestId("f-memo-view");
    expect(within(view).getByTestId("builder-ref-chip")).toHaveTextContent(
      "Find the bill · bill record id",
    );
    expect(view).toHaveTextContent("Bill");
    await user.click(view);
    expect(screen.getByTestId("f-memo")).toHaveFocus();
    expect(screen.queryByTestId("f-memo-view")).toBeNull();
    expect(screen.getByTestId("f-memo")).toHaveValue("Bill {{steps.match.output.bill.recordId}}");
  });

  it("edits a list of ids one field each, a reference picked by name", async () => {
    const user = userEvent.setup();
    render(<Form initial={{}} />);
    await user.click(screen.getByTestId("f-ids-add"));
    await user.click(screen.getByTestId("f-ids-0-pick"));
    const pick = screen.getByTestId("f-ids-0-path-steps.match.output.bill.recordId");
    expect(pick).toHaveTextContent("Find the bill · bill record id");
    await user.click(pick);
    expect(screen.getByTestId("value")).toHaveTextContent(
      '{"ids":["{{steps.match.output.bill.recordId}}"]}',
    );
    expect(screen.getByTestId("f-ids-0-view")).toHaveTextContent("Find the bill · bill record id");
    await user.click(screen.getByTestId("f-ids-0-remove"));
    expect(screen.getByTestId("value")).toHaveTextContent("{}");
  });
});
