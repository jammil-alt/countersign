// Read table (docs/plan.md §1.164) in the back office: the columns editor (field, headers it
// accepts, type and style, required) and the builder's sample-file check, on a fake API: the file
// goes to the server with the step and the agent's columns; the answer shows which header each
// column took, what is missing and the first rows.
import { type ProcessAgentBundle, processes, type ReadTableSampleView } from "@countersign/core";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/useApi";
import { fakeApi } from "../../test/fixtures";
import { ParameterValueInput, parameterText } from "../skills/parameters";
import { ReadTableSample } from "./read-table-step";

const AGENT_ID = "00000000-0000-4000-8000-00000000b401";
const COLUMNS = [
  { field: "vendor", headers: ["Vendor", "Supplier"], type: "text", required: true },
  { field: "total", headers: ["Total"], type: "money", required: true },
  { field: "po", headers: ["PO"], type: "text" },
];

function Columns({ onValue }: { onValue(v: unknown): void }) {
  const [value, setValue] = useState<unknown>([]);
  return (
    <ParameterValueInput
      param={{ name: "columns", label: "Expected columns", type: "columns" }}
      value={value}
      testId="cols"
      onChange={(v) => {
        setValue(v);
        onValue(v);
      }}
    />
  );
}

describe("the columns parameter", () => {
  it("edits a column: field, the headers it accepts, its type and date style, required", async () => {
    let last: unknown;
    const user = userEvent.setup();
    render(<Columns onValue={(v) => (last = v)} />);
    await user.click(screen.getByTestId("cols-add"));
    await user.type(screen.getByTestId("cols-0-field"), "invoiceDate");
    await user.type(screen.getByTestId("cols-0-headers"), "Date, Invoice date");
    await user.selectOptions(screen.getByTestId("cols-0-type"), "date");
    await user.selectOptions(screen.getByTestId("cols-0-style"), "mdy");
    await user.click(screen.getByTestId("cols-0-required"));
    expect(last).toEqual([
      {
        field: "invoiceDate",
        headers: ["Date", "Invoice date"],
        type: "date",
        dateStyle: "mdy",
        required: true,
      },
    ]);
    expect(parameterText("columns", last)).toBe("invoiceDate*");
    expect(parameterText("columns", [])).toBe("none: every header, as it is");
    expect(parameterText("boolean", false)).toBe("off");
  });
});

describe("Read table's sample-file check", () => {
  it("sends the file with the step and the agent's columns, and shows what matched", async () => {
    const sent: Record<string, unknown>[] = [];
    const answer: ReadTableSampleView = {
      kind: "csv",
      sheet: null,
      sheets: [],
      columns: [
        { field: "vendor", header: "Supplier", column: "A", type: "text", required: true },
        { field: "total", header: null, column: null, type: "money", required: true },
        { field: "po", header: null, column: null, type: "text", required: false },
      ],
      unmatched: [{ header: "Amount", column: "B" }],
      rows: [],
      rowCount: 0,
      problems: [],
      problemCount: 0,
      failure: "the file has no column for total",
    };
    const api = fakeApi({
      [`POST /api/ops/agents/${AGENT_ID}/read-table/sample`]: ({ init }) => {
        sent.push(JSON.parse(String(init.body)));
        return answer;
      },
    });
    const workflow = processes.Process.parse({
      schemaVersion: 4,
      triggers: [{ id: "t", on: { type: "manual", input: { type: "object" } } }],
      steps: [
        {
          id: "read",
          kind: "skill",
          name: "Read table",
          skill: processes.READ_TABLE_SKILL,
          input: {},
        },
      ],
    });
    const step = workflow.steps[0];
    if (step?.kind !== "skill") throw new Error("no step");
    const bundle = {
      definition: {
        skills: [
          { skill: processes.READ_TABLE_SKILL, settings: {}, parameters: { columns: COLUMNS } },
        ],
      },
    } as unknown as ProcessAgentBundle;
    const user = userEvent.setup();
    render(
      <ApiProvider client={api.client}>
        <ReadTableSample step={step} workflow={workflow} bundle={bundle} agentId={AGENT_ID} />
      </ApiProvider>,
    );
    await user.upload(
      screen.getByTestId("builder-read-table-file"),
      new File(["Supplier,Amount\nCascade,12.00\n"], "november.csv", { type: "text/csv" }),
    );
    expect(await screen.findByTestId("builder-read-table-summary")).toHaveTextContent(
      "This file would stop the step: the file has no column for total.",
    );
    expect(sent[0]).toMatchObject({
      stepId: "read",
      agentSkills: [{ skill: processes.READ_TABLE_SKILL, parameters: { columns: COLUMNS } }],
      file: { filename: "november.csv", mimeType: "text/csv" },
    });
    const file = sent[0]?.file as { base64: string } | undefined;
    expect(atob(String(file?.base64))).toBe("Supplier,Amount\nCascade,12.00\n");
    expect(screen.getByTestId("builder-read-table-column-vendor")).toHaveTextContent(
      "A: “Supplier”",
    );
    expect(screen.getByTestId("builder-read-table-missing-total")).toHaveTextContent(
      "Missing, required",
    );
    expect(screen.getByTestId("builder-read-table-missing-po")).toHaveTextContent(
      "Not in this file",
    );
    expect(screen.getByTestId("builder-read-table-unmatched")).toHaveTextContent("B: “Amount”");
  });
});
