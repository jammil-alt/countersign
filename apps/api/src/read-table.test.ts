// Data in and out of files (docs/plan.md §1.164) through the API: a client uploads a .xlsx and a
// .csv that isn't a purchases export, both kept as documents and never read by a model; and the
// builder's sample-file check for a Read table step reads a file with the step's and the agent's
// columns, operator only and audited, keeping nothing.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_USER_HEADER } from "@countersign/auth";
import { processes, XLSX_MIME_TYPE } from "@countersign/core";
import { auditEvent, docExtraction, document } from "@countersign/db";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const XLSX = readFileSync(resolve(DEFAULT_FIXTURE_DIR, "../tables/vendor-invoices.xlsx"));

const h = await createApiHarness();
afterAll(() => h?.close());

/** A draft with one Read table step that sets its own header row. */
const draft = {
  schemaVersion: 5,
  triggers: [
    {
      id: "t1",
      on: {
        type: "manual",
        input: { type: "object", properties: { documentId: { type: "string" } } },
      },
    },
  ],
  outputs: [{ id: "out-done", name: "Done", kind: "nothing" }],
  steps: [
    {
      id: "read",
      name: "Read table",
      kind: "do",
      doneBy: "rules",
      uses: { type: "skill", skill: processes.READ_TABLE_SKILL },
      input: { documentId: "{{trigger.documentId}}" },
      rules: { values: { header_row: 1 } },
    },
    { id: "end", kind: "end", name: "Done", outputs: ["out-done"] },
  ],
};

const COLUMNS = [
  { field: "vendor", headers: ["Supplier"], type: "text", required: true },
  { field: "total", headers: ["Amount due"], type: "money", required: true },
  { field: "po", headers: ["PO"], type: "text" },
];

describe.skipIf(!h)("Read table through the API", () => {
  const H = h as ApiHarness;
  let templateId = "";

  beforeAll(async () => {
    const template = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "table-reader",
      bundle: testBundle("Table reader"),
      releaseNote: "First",
    });
    expect(template.status, JSON.stringify(template.json)).toBe(200);
    templateId = j(template.json).agent.id;
  });

  it("keeps an .xlsx and a CSV that isn't purchases as documents, never read by a model", async () => {
    const form = new FormData();
    form.append("files", new File([XLSX], "vendor-invoices.xlsx", { type: "" }));
    form.append(
      "files",
      new File(["Lead,Email\nAda,ada@example.com\n"], "leads.csv", { type: "text/csv" }),
    );
    form.append("files", new File(["not really a spreadsheet"], "fake.xlsx", { type: "" }));
    const deferred: Promise<unknown>[] = [];
    const res = await H.app.request(
      "/api/uploads",
      { method: "POST", headers: { [DEV_USER_HEADER]: admin("a") }, body: form },
      H.env,
      {
        waitUntil: (p: Promise<unknown>) => void deferred.push(p),
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    while (deferred.length > 0) await Promise.all(deferred.splice(0));
    expect(res.status).toBe(200);
    const [xlsx, csv, fake] = j(await res.json()).results;
    expect(xlsx).toMatchObject({ kind: "document", created: true });
    expect(csv).toMatchObject({ kind: "document", created: true, purchases: null });
    expect(fake).toMatchObject({ kind: "refused", error: "The file is not what its type says." });
    const ids = [xlsx.document.id, csv.document.id];
    const rows = await H.t.db.select().from(document).where(inArray(document.id, ids));
    expect(rows.map((r) => r.mimeType).sort()).toEqual([XLSX_MIME_TYPE, "text/csv"].sort());
    const read = await H.t.db
      .select()
      .from(docExtraction)
      .where(inArray(docExtraction.documentId, ids));
    expect(read).toEqual([]);
  });

  it("reads a sample file with the agent's columns: what matched, what is missing, the rows", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${templateId}/read-table/sample`, {
      process: draft,
      stepId: "read",
      agentSkills: [{ skill: processes.READ_TABLE_SKILL, parameters: { columns: COLUMNS } }],
      file: {
        filename: "vendor-invoices.xlsx",
        mimeType: XLSX_MIME_TYPE,
        base64: XLSX.toString("base64"),
      },
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toMatchObject({
      kind: "xlsx",
      sheet: "Invoices",
      sheets: ["Invoices"],
      columns: [
        { field: "vendor", header: "Supplier", column: "A", required: true },
        { field: "total", header: "Amount due", column: "C", required: true },
        { field: "po", header: null, column: null, required: false },
      ],
      unmatched: [
        { header: "Invoice #", column: "B" },
        { header: "Invoice date", column: "D" },
        { header: "Paid", column: "E" },
      ],
      rows: [
        { vendor: "Cascade Lumber", total: "1616.6" },
        { vendor: "Northline Panel Supply", total: "980.1" },
        { vendor: "Keystone Hardware", total: "12" },
      ],
      rowCount: 3,
      failure: null,
    });
    const audits = await H.t.db
      .select()
      .from(auditEvent)
      .where(eq(auditEvent.action, "POST /api/ops/agents/:id/read-table/sample"));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("says why a file would stop the step, refuses what isn't a table, and is operator only", async () => {
    const call = (file: { filename: string; mimeType: string; base64: string }, as = OPERATOR) =>
      H.call(as, "POST", `/api/ops/agents/${templateId}/read-table/sample`, {
        process: draft,
        stepId: "read",
        agentSkills: [
          {
            skill: processes.READ_TABLE_SKILL,
            parameters: { columns: [COLUMNS[0], COLUMNS[1], { ...COLUMNS[2], required: true }] },
          },
        ],
        file,
      });
    const csv = Buffer.from("Supplier,Amount due\nCascade,12.00\n").toString("base64");
    const missing = await call({ filename: "a.csv", mimeType: "text/csv", base64: csv });
    expect(missing.status).toBe(200);
    expect(j(missing.json).failure).toBe("the file has no column for po");
    const pdf = await call({ filename: "a.pdf", mimeType: "application/pdf", base64: csv });
    expect(pdf.status).toBe(422);
    expect(j(pdf.json).error.code).toBe("unreadable_file");
    const client = await call({ filename: "a.csv", mimeType: "text/csv", base64: csv }, admin("a"));
    expect(client.status).toBe(403);
  });
});
