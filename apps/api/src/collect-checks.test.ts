// Collect reports (owner, 2026-11-24): what a report's owner sent, checked in code against the
// report's columns and period; a document of another client is never read.
import { DEV_USER_HEADER } from "@countersign/auth";
import { ContentStore } from "@countersign/connectors";
import { processes } from "@countersign/core";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { collectChecks } from "./collect/checks";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

const item = processes.CollectItem.parse({
  id: "bank",
  name: "Bank statement",
  owner: "seat:controller",
  formats: ["spreadsheet"],
  columns: [
    { field: "date", headers: ["Date"], type: "date", required: true },
    { field: "amount", headers: ["Amount"], type: "money", required: true },
  ],
  dates: { field: "date" },
  minRows: 2,
  due: "3 days",
  followUp: { after: "1 day", every: "2 days" },
});
const period = processes.reportPeriod("monthly", new Date("2026-12-07T15:00:00Z"));

describe.skipIf(!h)("checking a report's files", () => {
  const H = h as ApiHarness;

  async function upload(who: string, name: string, text: string): Promise<string> {
    const form = new FormData();
    form.append("files", new File([text], name, { type: "text/csv" }));
    const res = await H.app.request(
      "/api/uploads",
      { method: "POST", headers: { [DEV_USER_HEADER]: who }, body: form },
      H.env,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
        props: {},
      } as unknown as ExecutionContext,
    );
    expect(res.status).toBe(200);
    return j(await res.json()).results[0].document.id;
  }

  const check = (tenantId: string, documentIds: string[]) =>
    collectChecks({ db: H.db, content: new ContentStore(H.objects) }).check({
      tenantId,
      runId: "0192f7a0-0000-7000-8000-00000000a001",
      nodeId: "c1:0:r1",
      item,
      period,
      documentIds,
    });

  it("passes a spreadsheet with its columns and every date in November", async () => {
    const id = await upload(
      admin("a"),
      "bank-nov.csv",
      "Date,Amount,Memo\n2026-11-02,10.00,a\n2026-11-28,5.50,b\n",
    );
    expect(await check(H.A.tenantId, [id])).toEqual({
      ok: true,
      problems: [],
      documents: [id],
      // Read by the report's columns: what the next step reads, without the file again.
      rows: [
        { date: "2026-11-02", amount: "10.00" },
        { date: "2026-11-28", amount: "5.50" },
      ],
    });
  });

  it("names a missing column and dates outside the period", async () => {
    const noAmount = await upload(
      admin("a"),
      "bank-a.csv",
      "Date,Memo\n2026-11-02,a\n2026-11-03,b\n",
    );
    const r1 = await check(H.A.tenantId, [noAmount]);
    expect(r1.ok).toBe(false);
    expect(r1.problems[0]).toMatch(/^bank-a\.csv: the file has no column fo/);
    const december = await upload(
      admin("a"),
      "bank-b.csv",
      "Date,Amount\n2026-11-30,1.00\n2026-12-01,2.00\n",
    );
    expect((await check(H.A.tenantId, [december])).problems).toEqual([
      "bank-b.csv has 1 row dated outside November 2026 (2026-11-01 to 2026-11-30), the first 2026-12-01.",
    ]);
  });

  it("never reads another client's document", async () => {
    const theirs = await upload(
      admin("b"),
      "bank-b.csv",
      "Date,Amount\n2026-11-02,1\n2026-11-03,2\n",
    );
    expect(await check(H.A.tenantId, [theirs])).toEqual({
      ok: false,
      problems: ["No file came with the Bank statement."],
      documents: [],
      rows: [],
    });
  });
});

describe.skipIf(!h)("a report's sample file in the builder", () => {
  const H = h as ApiHarness;
  const b64 = (text: string) => btoa(text);

  it("reads a spreadsheet's columns and a PDF's format, and stores nothing", async () => {
    const template = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "report-collector",
      bundle: testBundle("Report collector"),
      releaseNote: "First",
    });
    expect(template.status, JSON.stringify(template.json)).toBe(200);
    const id = j(template.json).agent.id;
    const path = `/api/ops/agents/${id}/collect/sample`;
    const sheet = await H.call(OPERATOR, "POST", path, {
      file: {
        filename: "bank.csv",
        mimeType: "text/csv",
        base64: b64("Date,Amount,Memo\n2026-11-02,10.00,a\n2026-11-28,5.50,b\n"),
      },
    });
    expect(sheet.status, JSON.stringify(sheet.json)).toBe(200);
    expect(sheet.json).toMatchObject({
      format: "spreadsheet",
      rowCount: 2,
      failure: null,
      columns: [
        { field: "date", headers: ["Date"], type: "date", dateStyle: "iso", required: true },
        { field: "amount", headers: ["Amount"], type: "money", required: true },
        { field: "memo", headers: ["Memo"], type: "text", required: true },
      ],
    });
    const pdf = await H.call(OPERATOR, "POST", path, {
      file: { filename: "statement.pdf", mimeType: "application/pdf", base64: b64("%PDF-1.4") },
    });
    expect(pdf.json).toMatchObject({ format: "pdf", columns: [] });
    // Back office only (invariant 11).
    const portal = await H.call(admin("a"), "POST", path, {
      file: { filename: "bank.csv", mimeType: "text/csv", base64: b64("A\n1\n") },
    });
    expect(portal.status).toBe(403);
  });
});
