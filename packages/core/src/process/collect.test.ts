import { describe, expect, it } from "vitest";
import {
  CollectItem,
  checkReport,
  collectDurableEstimate,
  collectOutput,
  collectProblems,
  linkClosesAt,
  linkWindow,
  type ReportFile,
  reportFormatOf,
  reportPeriod,
  requestPurpose,
} from "./collect";
import { CollectStep } from "./schema";
import { whoRefsOfStep } from "./seats";
import { validateProcess } from "./validate";

const CSV = "text/csv";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function item(over: Record<string, unknown> = {}) {
  return CollectItem.parse({
    id: "bank",
    name: "Bank statement",
    owner: "seat:controller",
    due: "3 days",
    followUp: { after: "1 day", every: "2 days" },
    ...over,
  });
}

describe("a report's schema", () => {
  it("defaults to a required monthly PDF or spreadsheet, two follow-ups, business hours", () => {
    expect(item()).toMatchObject({
      required: true,
      frequency: "monthly",
      formats: ["pdf", "spreadsheet"],
      hours: "business",
      followUp: { max: 2 },
    });
  });

  it("caps follow-ups at five", () => {
    expect(
      CollectItem.safeParse({ ...item(), followUp: { after: "1 day", every: "1 day", max: 6 } })
        .success,
    ).toBe(false);
  });

  it("parses a step with an escalation and defaults ifMissing to stop", () => {
    const step = CollectStep.parse({
      id: "c1",
      name: "Collect the month's reports",
      kind: "collect",
      items: [item()],
      escalate: { to: "client_admin", after: "5 days", deadline: { after: "2 days" } },
    });
    expect(step.ifMissing).toBe("stop");
    expect(step.escalate?.hours).toBe("business");
    expect(step.escalate?.deadline.ifNoAnswer).toBe("stop");
  });
});

describe("the period a report covers", () => {
  // Monday 2026-12-07, 15:00 UTC (09:00 in Chicago).
  const at = new Date("2026-12-07T15:00:00.000Z");

  it("is the last whole period before the step starts", () => {
    expect(reportPeriod("monthly", at)).toEqual({
      from: "2026-11-01",
      to: "2026-11-30",
      label: "November 2026",
    });
    expect(reportPeriod("daily", at)).toEqual({
      from: "2026-12-06",
      to: "2026-12-06",
      label: "2026-12-06",
    });
    expect(reportPeriod("weekly", at)).toEqual({
      from: "2026-11-30",
      to: "2026-12-06",
      label: "the week of 2026-11-30",
    });
    expect(reportPeriod("quarterly", at)).toEqual({
      from: "2026-07-01",
      to: "2026-09-30",
      label: "Q3 2026",
    });
    expect(reportPeriod("yearly", at)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
      label: "2025",
    });
    expect(reportPeriod("once", at)).toBeNull();
  });

  it("goes back a year from January, and counts the day in the client's zone", () => {
    expect(reportPeriod("monthly", new Date("2027-01-02T12:00:00Z"))?.label).toBe("December 2026");
    expect(reportPeriod("quarterly", new Date("2027-01-02T12:00:00Z"))?.label).toBe("Q4 2026");
    // 03:00 UTC on 1 December is still 30 November in Chicago.
    const late = new Date("2026-12-01T03:00:00.000Z");
    expect(reportPeriod("monthly", late, "America/Chicago")?.label).toBe("October 2026");
    expect(reportPeriod("monthly", late, "UTC")?.label).toBe("November 2026");
  });
});

describe("follow-up timing", () => {
  const now = new Date("2026-12-01T00:00:00.000Z");
  const dueAt = new Date("2026-12-04T00:00:00.000Z");
  const followUp = { after: "1 day", every: "2 days" };

  it("keeps the first link open until the first follow-up, each follow-up for `every`", () => {
    expect(
      linkClosesAt({ now, dueAt, followUp, first: true, escalateAt: null }).toISOString(),
    ).toBe("2026-12-05T00:00:00.000Z");
    expect(
      linkClosesAt({ now: dueAt, dueAt, followUp, first: false, escalateAt: null }).toISOString(),
    ).toBe("2026-12-06T00:00:00.000Z");
  });

  it("closes no later than the escalation", () => {
    const escalateAt = new Date("2026-12-04T12:00:00.000Z");
    expect(linkClosesAt({ now, dueAt, followUp, first: true, escalateAt }).toISOString()).toBe(
      escalateAt.toISOString(),
    );
  });

  it("gives forms a window of an hour to 30 days", () => {
    expect(linkWindow(10_000)).toBe("60 minutes");
    expect(linkWindow(90 * 86_400_000)).toBe(`${30 * 24 * 60} minutes`);
    expect(linkWindow(2 * 3_600_000 + 1)).toBe("121 minutes");
  });
});

describe("checking what came in", () => {
  const period = reportPeriod("monthly", new Date("2026-12-07T15:00:00Z"));
  const sheet = (rows: Record<string, unknown>[], failure: string | null = null): ReportFile => ({
    documentId: "d1",
    filename: "bank.csv",
    mimeType: CSV,
    table: { failure, rows },
  });
  const columns = [
    { field: "date", headers: ["Date"], type: "date" as const, required: true },
    { field: "amount", headers: ["Amount"], type: "money" as const, required: true },
  ];
  const withDates = item({ columns, dates: { field: "date" }, minRows: 2 });

  it("tells formats apart", () => {
    expect(reportFormatOf("application/pdf")).toBe("pdf");
    expect(reportFormatOf("image/png")).toBe("image");
    expect(reportFormatOf(CSV)).toBe("spreadsheet");
    expect(reportFormatOf(XLSX)).toBe("spreadsheet");
    expect(reportFormatOf("application/json")).toBeNull();
  });

  it("passes a spreadsheet with its columns, enough rows and every date in the period", () => {
    const r = checkReport(withDates, period, [
      sheet([
        { date: "2026-11-01", amount: "10.00" },
        { date: "2026-11-30", amount: "5.00" },
      ]),
    ]);
    expect(r).toEqual({
      ok: true,
      problems: [],
      documents: ["d1"],
      // The rows are handed on as they were read.
      rows: [
        { date: "2026-11-01", amount: "10.00" },
        { date: "2026-11-30", amount: "5.00" },
      ],
    });
  });

  it("refuses nothing sent, the wrong format, a missing column, too few rows, dates outside", () => {
    expect(checkReport(withDates, period, []).problems).toEqual([
      "No file came with the Bank statement.",
    ]);
    expect(
      checkReport(item({ formats: ["spreadsheet"] }), period, [
        { documentId: "d2", filename: "bank.pdf", mimeType: "application/pdf" },
      ]).problems,
    ).toEqual(["bank.pdf isn't a spreadsheet (.csv or .xlsx)."]);
    expect(
      checkReport(withDates, period, [sheet([], 'the column "Amount" is missing')]).problems,
    ).toEqual(['bank.csv: the column "Amount" is missing']);
    const short = checkReport(withDates, period, [sheet([{ date: "2026-11-03" }])]);
    expect(short.ok).toBe(false);
    expect(short.problems).toEqual(["bank.csv has 1 row; we need at least 2."]);
    const outside = checkReport(withDates, period, [
      sheet([{ date: "2026-11-03" }, { date: "2026-12-02" }, { date: "2026-10-31" }]),
    ]);
    expect(outside.problems).toEqual([
      "bank.csv has 2 rows dated outside November 2026 (2026-11-01 to 2026-11-30), the first 2026-12-02.",
    ]);
    expect(outside.documents).toEqual([]);
    expect(
      checkReport(withDates, period, [sheet([{ amount: "1" }, { amount: "2" }])]).problems,
    ).toEqual(["bank.csv has no dates in Date."]);
  });

  it("passes a PDF on its format alone", () => {
    expect(
      checkReport(item(), period, [
        { documentId: "d3", filename: "bank.pdf", mimeType: "application/pdf" },
      ]).ok,
    ).toBe(true);
  });
});

describe("what the owner is asked", () => {
  it("says what, for which dates, in which format; a follow-up and a resend say so", () => {
    const i = item({
      columns: [{ field: "date", headers: ["Date"], type: "date", required: true }],
    });
    const period = reportPeriod("monthly", new Date("2026-12-07T15:00:00Z"));
    expect(requestPurpose({ item: i, period, send: 1 })).toBe(
      "Please send us the Bank statement for November 2026. Send a PDF or a spreadsheet (.csv or .xlsx) with the columns Date.",
    );
    expect(requestPurpose({ item: i, period, send: 2 })).toMatch(/^A reminder: we still need/);
    expect(requestPurpose({ item: i, period, send: 2, problems: ["bank.csv has 1 row."] })).toMatch(
      /^The file we got for the Bank statement for November 2026 didn't pass our checks: bank\.csv has 1 row\. Please send it again\./,
    );
  });
});

describe("the step's output", () => {
  const base = {
    owner: "seat:controller",
    required: true,
    period: null,
    dueAt: "2026-12-04T00:00:00.000Z",
    problems: [],
    sends: 1,
    escalations: 0,
  };
  it("is complete when every required report is in", () => {
    const out = collectOutput([
      { ...base, id: "a", name: "Bank", status: "received", documents: ["d1"] },
      { ...base, id: "b", name: "Card", required: false, status: "missing", documents: [] },
    ]);
    expect(out).toMatchObject({
      complete: true,
      documents: ["d1"],
      received: 1,
      missing: 1,
      summary: "1 of 2 reports in; missing: Card",
      sources: ["d1"],
    });
    expect(
      collectOutput([{ ...base, id: "a", name: "Bank", status: "skipped", documents: [] }])
        .complete,
    ).toBe(false);
  });
});

describe("validation", () => {
  const processOf = (steps: unknown[]) => ({
    schemaVersion: 4,
    triggers: [{ id: "t1", on: { type: "schedule", cron: "0 9 1 * *" } }],
    steps,
  });
  const step = (over: Record<string, unknown> = {}) => ({
    id: "c1",
    name: "Collect the month's reports",
    kind: "collect",
    items: [
      {
        id: "bank",
        name: "Bank statement",
        owner: "seat:controller",
        due: "3 days",
        followUp: { after: "1 day", every: "2 days" },
      },
    ],
    escalate: { to: "client_admin", after: "5 days", deadline: { after: "2 days" } },
    ...over,
  });
  const codes = (p: unknown) => validateProcess(p).errors.map((e) => e.code);

  it("accepts a collect step", () => {
    expect(codes(processOf([step()]))).toEqual([]);
  });

  it("refuses spreadsheet checks on a PDF-only report, a dates field that isn't a date column", () => {
    const bad = step({
      items: [
        {
          ...step().items[0],
          formats: ["pdf"],
          dates: { field: "posted" },
          columns: [{ field: "posted", type: "text" }],
        },
      ],
    });
    expect(codes(processOf([bad]))).toEqual(
      expect.arrayContaining(["collect_columns_format", "collect_dates_column"]),
    );
  });

  it("refuses an owner who isn't a seat or a contact, a templated name, two ids alike", () => {
    const first = step().items[0] as Record<string, unknown>;
    const bad = step({
      items: [
        { ...first, owner: "client_admin", name: "{{trigger.x}}" },
        { ...first, name: "Card statement" },
      ],
    });
    expect(codes(processOf([bad]))).toEqual(
      expect.arrayContaining(["collect_owner", "input_not_fixed", "collect_item_ids"]),
    );
  });

  it("types each report's rows by its columns for the steps after it", () => {
    const withColumns = step({
      items: [
        {
          ...(step().items[0] as Record<string, unknown>),
          formats: ["spreadsheet"],
          columns: [
            { field: "date", headers: ["Date"], type: "date", required: true },
            { field: "amount", headers: ["Amount"], type: "money", required: true },
          ],
        },
      ],
    });
    const reads = (path: string) =>
      processOf([
        withColumns,
        {
          id: "n1",
          kind: "notify",
          name: "Tell",
          notify: { to: ["client_admin"], message: `{{steps.c1.output.reports.${path}}}` },
        },
      ]);
    expect(codes(reads("bank.rows.0.amount"))).toEqual([]);
    expect(codes(reads("bank.rowCount"))).toEqual([]);
    expect(codes(reads("bank.rows.0.vendor"))).not.toEqual([]);
    expect(codes(reads("card.rows"))).not.toEqual([]);
  });

  it("refuses a list that could take too many steps", () => {
    const items = Array.from({ length: 20 }, (_, i) => ({
      ...(step().items[0] as Record<string, unknown>),
      id: `r${i}`,
      followUp: { after: "1 day", every: "1 day", max: 5 },
    }));
    expect(codes(processOf([step({ items })]))).toContain("collect_too_big");
    expect(
      collectDurableEstimate({ items: items.map((i) => CollectItem.parse(i)) }),
    ).toBeGreaterThan(900);
  });

  it("names its owners as seats to reach, its escalation as a seat to ask", () => {
    const refs = whoRefsOfStep(
      CollectStep.parse(step({ escalate: { ...step().escalate, to: "seat:cfo" } })),
    );
    expect(refs).toEqual(
      expect.arrayContaining([
        { who: "seat:controller", use: "reach", field: "items.0.owner" },
        { who: "seat:cfo", use: "escalate", field: "escalate.to" },
      ]),
    );
  });

  it("reports the problems collectProblems finds", () => {
    expect(
      collectProblems({
        items: [item({ followUp: { after: "10 minutes", every: "2 days" } })],
      }).map((p) => p.code),
    ).toEqual(["collect_window"]);
  });
});

describe("a sample spreadsheet", () => {
  it("suggests one required column per header, typed from its rows", async () => {
    const { columnsFromSample } = await import("./collect");
    const cols = columnsFromSample(
      [
        { field: "Posted Date", header: "Posted Date" },
        { field: "Amount", header: "Amount" },
        { field: "Qty", header: "Qty" },
        { field: "Memo", header: "Memo" },
        { field: "#", header: "#" },
        { field: "Day", header: "Day" },
      ],
      [
        {
          "Posted Date": "2026-11-02",
          Amount: "$1,200.50",
          Qty: "3",
          Memo: "rent",
          "#": 1,
          Day: "25/11/2026",
        },
        {
          "Posted Date": "2026-11-03",
          Amount: "(40.00)",
          Qty: "4",
          Memo: "fee",
          "#": 2,
          Day: "01/12/2026",
        },
      ],
    );
    expect(cols).toEqual([
      {
        field: "posted_date",
        headers: ["Posted Date"],
        type: "date",
        dateStyle: "iso",
        required: true,
      },
      { field: "amount", headers: ["Amount"], type: "money", required: true },
      { field: "qty", headers: ["Qty"], type: "number", required: true },
      { field: "memo", headers: ["Memo"], type: "text", required: true },
      { field: "column_5", headers: ["#"], type: "number", required: true },
      { field: "day", headers: ["Day"], type: "date", dateStyle: "dmy", required: true },
    ]);
  });
});
