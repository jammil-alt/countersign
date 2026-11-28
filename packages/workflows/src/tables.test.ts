// Read table → Reshape data → Write table end to end in the executor (docs/plan.md §1.164): a
// client's spreadsheet read with the agent's columns (which type the rows for the validator and
// Reshape's proposer), its rows mapped to the fields another system takes, and laid out for a new
// .xlsx in that system's columns, naming the file it came from. The executor hands each step to
// the agent port; the port here runs core's rules as the runtime's handlers do
// (`tableFiles.tableFromGrid`, `evaluateReshape`, `tableForWriting`). The bytes of the files (the
// XLSX reader and writer) are tested in packages/connectors and packages/agents.
import {
  type JsonSchema,
  processes,
  type SkillDefinition,
  schemaAtPath,
  TableColumns,
  tableFiles,
  type XlsxCell,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import { FakeStepRunner } from "./fake-runner";
import { executeProcess, Harness } from "./fakes.test-helper";
import type { SkillStepRequest } from "./ports";

const DOC = "0190a1b2-0000-7000-8000-0000000000d1";
const MADE = "0190a1b2-0000-7000-8000-0000000000d2";

function builtIn(
  id: string,
  name: string,
  handler: string,
  io: { input: JsonSchema; output: JsonSchema },
  parameters: readonly NonNullable<SkillDefinition["parameters"]>[number][] = [],
): SkillDefinition {
  return {
    schemaVersion: 1,
    id,
    name,
    description: name,
    category: "data",
    mode: "tool",
    handler,
    tools: [handler],
    ...io,
    parameters: [...parameters],
    settings: [],
    requiresConnectors: [],
    requiresPacks: [],
    producesAlerts: false,
  };
}

/** The three built-ins as packages/agents defines them (their parameters and schemas). */
const READ = builtIn(
  processes.READ_TABLE_SKILL,
  "Read table",
  processes.READ_TABLE_TOOL,
  {
    input: {
      type: "object",
      properties: { documentId: { type: "string" } },
      required: ["documentId"],
    },
    output: processes.readTableOutputSchema([]),
  },
  processes.READ_TABLE_PARAMETERS,
);
const RESHAPE = builtIn(processes.RESHAPE_SKILL, "Reshape data", processes.RESHAPE_TOOL, {
  input: { type: "object", additionalProperties: true },
  output: { type: "object", additionalProperties: true },
});
const WRITE = builtIn(
  processes.WRITE_TABLE_SKILL,
  "Write table",
  processes.WRITE_TABLE_TOOL,
  {
    input: {
      type: "object",
      properties: {
        rows: { type: "array", items: { type: "object", additionalProperties: {} } },
        sources: { type: "array", items: { type: "string" } },
        filename: { type: "string" },
      },
      required: ["rows"],
    },
    output: processes.WRITE_TABLE_OUTPUT,
  },
  processes.WRITE_TABLE_PARAMETERS,
);
const skills: Record<string, SkillDefinition> = {
  [READ.id]: READ,
  [RESHAPE.id]: RESHAPE,
  [WRITE.id]: WRITE,
};

/** The agent's columns for Read table, set once in its Settings. */
const COLUMNS = [
  { field: "vendor", headers: ["Vendor", "Supplier"], type: "text", required: true },
  { field: "total", headers: ["Amount due", "Total"], type: "money", required: true },
  { field: "date", headers: ["Invoice date"], type: "date", dateStyle: "mdy" },
];
const agentSkills = [
  { skill: READ.id, parameters: { columns: COLUMNS } },
  { skill: RESHAPE.id },
  { skill: WRITE.id },
];
const typing = { skills, agentSkills };

/** Write table's own parameters on its step: the other system's columns, as .xlsx. */
const OUTPUT = {
  format: "xlsx",
  sheet: "Import",
  columns: [
    { field: "Company", headers: ["Company"], type: "text", required: true },
    { field: "Amount", headers: ["Amount"], type: "money", required: true },
    { field: "Closing_Date", headers: ["Closing Date"], type: "date", dateStyle: "iso" },
  ],
};

/** The client's sheet as the XLSX reader gives it: a title, other headers, a total row. */
const SHEET: XlsxCell[][] = [
  ["Open invoices"],
  [],
  ["Supplier", "Total", "Invoice date", "Notes"],
  ["Cascade Lumber", 1616.6, "2026-10-28", "rush"],
  ["Keystone Hardware", "12.00", "11/14/2026", null],
  ["Total", 1628.6, null, null],
];

/** What the runtime's Read table handler does with the file's cells and its parameters. */
function readSheet(documentId: string, parameters: Record<string, unknown>) {
  const options = tableFiles.readTableOptions(parameters);
  if (!options.ok) throw new Error(options.error);
  const r = tableFiles.tableFromGrid(SHEET, options.options, "Invoices");
  if (r.failure) throw new Error(`invoices.xlsx: ${r.failure}`);
  return {
    columns: r.columns,
    rows: r.rows,
    rowCount: r.rows.length,
    sheet: r.sheet,
    problems: r.problems,
    sources: [documentId],
  };
}

function tableProcess(): processes.Process {
  const base = processes.Process.parse({
    schemaVersion: 4,
    triggers: [
      {
        id: "t",
        on: {
          type: "manual",
          input: { type: "object", properties: { documentId: { type: "string" } } },
        },
      },
    ],
    steps: [
      {
        id: "read",
        kind: "skill",
        name: "Read table",
        skill: READ.id,
        input: { documentId: "{{trigger.documentId}}" },
        // The step's own parameter over the agent's: the headers are on row 3.
        customize: { parameters: { header_row: 3 } },
      },
      {
        id: "shape",
        kind: "skill",
        name: "Reshape data",
        skill: RESHAPE.id,
        input: {},
        reshape: { fields: [] },
      },
      {
        id: "write",
        kind: "skill",
        name: "Write table",
        skill: WRITE.id,
        input: {},
        customize: { parameters: OUTPUT },
      },
    ],
  });
  const context = processes.reshapeContext(base, "shape", typing);
  if (!context) throw new Error("no context");
  // Read table's rows are typed by the agent's columns: Reshape sees each field.
  const source = context.sources.find((s) => s.key === "readTable");
  expect(schemaAtPath(source?.schema, ["rows", "0", "total"])).toEqual({
    ok: true,
    schema: processes.columnValueSchema("money"),
  });
  const p = processes.proposeReshape({ context });
  // The rows go to the other system's names, field by field; the sources pass through.
  const mapping: processes.ReshapeMapping = {
    fields: p.mapping.fields.map((f) =>
      f.name === "rows"
        ? {
            ...f,
            from: {
              mapList: {
                list: { input: "readTable.rows" },
                fields: {
                  Company: { item: "vendor" },
                  Amount: { item: "total" },
                  Closing_Date: { item: "date" },
                },
              },
            },
          }
        : f,
    ),
  };
  return processes.Process.parse({
    ...base,
    steps: base.steps.map((s) => {
      if (s.id === "shape") {
        return { ...s, input: { readTable: "{{steps.read.output}}" }, reshape: mapping };
      }
      if (s.id === "write") {
        return {
          ...s,
          input: {
            rows: "{{steps.shape.output.rows}}",
            sources: "{{steps.shape.output.sources}}",
            filename: "Import",
          },
        };
      }
      return s;
    }),
  });
}

describe("Read table → Reshape data → Write table", () => {
  it("validates, then runs: the rows reach the other system's columns, naming their source", async () => {
    const process = tableProcess();
    const shape = process.steps[1];
    expect(shape?.kind === "skill" && shape.reshape?.fields.map((f) => [f.name, f.from])).toEqual([
      ["rows", expect.objectContaining({ mapList: expect.anything() })],
      ["sources", { input: "readTable.sources" }],
      ["filename", undefined],
    ]);
    expect(
      processes.validateProcess(process, {
        ...typing,
        agent: {
          skills: agentSkills.map((s) => ({ ...s, settings: {} })),
          extraTools: [],
          canCommand: [],
        },
      }).errors,
    ).toEqual([]);

    const h = new Harness();
    let laid: tableFiles.WriteGrid | null = null;
    h.handlers.read = (req) => {
      const { input, customize } = req as SkillStepRequest;
      const { documentId } = input as { documentId: string };
      // The runtime gives the handler the agent's parameter values under the step's own.
      return {
        kind: "done",
        output: readSheet(documentId, { columns: COLUMNS, ...customize?.parameters }),
      };
    };
    h.handlers.shape = (req) => {
      const { reshape, input } = req as SkillStepRequest;
      const r = processes.evaluateReshape(reshape as processes.ReshapeMapping, input, {
        today: "2026-11-20",
      });
      return r.problems.length > 0
        ? { kind: "failed", error: r.problems.map((x) => x.message).join("; ") }
        : { kind: "done", output: r.output };
    };
    h.handlers.write = (req) => {
      const { customize, input } = req as SkillStepRequest;
      const { rows, sources, filename } = input as {
        rows: Record<string, unknown>[];
        sources: string[];
        filename: string;
      };
      // The step's own parameters reach the runtime with its customization.
      const params = customize?.parameters ?? {};
      const r = tableFiles.tableForWriting(rows, TableColumns.parse(params.columns ?? []));
      if (!r.ok) return { kind: "failed", error: r.error };
      laid = r.grid;
      return {
        kind: "done",
        output: {
          documentId: MADE,
          filename: `${filename}.${String(params.format)}`,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          rowCount: r.grid.rows.length,
          created: true,
          sources: [MADE, ...sources],
        },
      };
    };

    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ catalog: { skills } }),
      process,
      { documentId: DOC },
    );
    expect(result.status).toBe("succeeded");
    expect(h.row("read")?.output).toMatchObject({
      rows: [
        { vendor: "Cascade Lumber", total: "1616.6", date: "2026-10-28" },
        { vendor: "Keystone Hardware", total: "12.00", date: "2026-11-14" },
      ],
      sources: [DOC],
    });
    expect(h.row("write")?.output).toMatchObject({
      filename: "Import.xlsx",
      rowCount: 2,
      sources: [MADE, DOC],
    });
    expect(laid).toEqual({
      headers: ["Company", "Amount", "Closing Date"],
      rows: [
        [
          { kind: "text", value: "Cascade Lumber" },
          { kind: "money", value: "1616.6" },
          { kind: "date", value: "2026-10-28", style: "iso" },
        ],
        [
          { kind: "text", value: "Keystone Hardware" },
          { kind: "money", value: "12.00" },
          { kind: "date", value: "2026-11-14", style: "iso" },
        ],
      ],
    });
  });

  it("stops at Read table, naming the column a file is missing", async () => {
    const h = new Harness();
    h.handlers.read = () => {
      try {
        readSheet(DOC, {
          header_row: 3,
          columns: [
            ...COLUMNS,
            { field: "po", headers: ["PO number"], type: "text", required: true },
          ],
        });
        return { kind: "done", output: {} };
      } catch (error) {
        return { kind: "failed", error: (error as Error).message };
      }
    };
    const result = await executeProcess(
      new FakeStepRunner(),
      h.context({ catalog: { skills } }),
      tableProcess(),
      { documentId: DOC },
    );
    expect(result.status).toBe("failed");
    expect(h.row("read")?.error).toBe(
      'invoices.xlsx: the file has no column for po (or "PO number")',
    );
    expect(h.agentCalls.some((c) => c.step.id === "write")).toBe(false);
  });
});
