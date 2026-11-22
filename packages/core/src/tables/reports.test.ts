import { describe, expect, it } from "vitest";
import { ReportExpected, ReportProfile } from "../schemas/report-profile";
import { readTableOptions, tableFromGrid } from "./files";
import {
  checkControlTotal,
  filenameMatches,
  lastDue,
  proposeColumns,
  reportMissing,
  senderMatches,
} from "./reports";

const GRID = [
  ["CR2 Daily Sales Report"],
  ["Store: 014", "Run: 11/20/2026"],
  [],
  ["Ticket", "Date", "Customer", "Net Sales"],
  ["T-1", "11/19/2026", "Harbor Decks", "214.56"],
  ["T-2", "11/19/2026", "Walk-in", "89.97"],
  [null, null, "Total", "304.53"],
];

const read = (params: Record<string, unknown>) => {
  const o = readTableOptions(params);
  if (!o.ok) throw new Error(o.error);
  return tableFromGrid(GRID, o.options);
};

const COLUMNS = [
  { field: "ticket", headers: ["Ticket"], type: "text", required: true },
  { field: "date", headers: ["Date"], type: "date", dateStyle: "mdy" },
  { field: "netSales", headers: ["Net Sales"], type: "money", required: true },
];

describe("report rules (§1.213)", () => {
  it("keeps each row's place in the file and the total row apart", () => {
    const r = read({ header_row: 4, columns: COLUMNS });
    expect(r.failure).toBeNull();
    expect(r.rows).toHaveLength(2);
    expect(r.rowNumbers).toEqual([5, 6]);
    expect(r.totals).toEqual([{ row: 7, values: { netSales: "304.53" } }]);
  });

  it("checks the control total when the file has one", () => {
    expect(checkControlTotal(read({ header_row: 4, columns: COLUMNS }), "netSales")).toEqual({
      status: "ok",
      field: "netSales",
      expected: "304.53",
      found: "304.53",
      totalRow: 7,
    });
    const short = tableFromGrid(
      GRID.slice(0, 5).concat([[null, null, "Total", "300.00"]]),
      (readTableOptions({ header_row: 4, columns: COLUMNS }) as { ok: true; options: never })
        .options,
    );
    expect(checkControlTotal(short, "netSales").status).toBe("mismatch");
    const none = tableFromGrid(
      GRID.slice(0, 6),
      (readTableOptions({ header_row: 4, columns: COLUMNS }) as { ok: true; options: never })
        .options,
    );
    expect(checkControlTotal(none, "netSales")).toEqual({ status: "none" });
  });

  it("matches file names and senders", () => {
    expect(filenameMatches("cr2-daily-sales-*.csv", "CR2-Daily-Sales-2026-11-19.CSV")).toBe(true);
    expect(filenameMatches("cr2-daily-sales-*.csv", "cr2-daily-sales.xlsx")).toBe(false);
    expect(filenameMatches("a.b(1).csv", "a.b(1).csv")).toBe(true);
    expect(senderMatches([], null)).toBe(true);
    expect(senderMatches(["pinecrest.example"], "reports@mail.pinecrest.example")).toBe(true);
    expect(senderMatches(["cr2@pinecrest.example"], "ap@pinecrest.example")).toBe(false);
    expect(senderMatches(["pinecrest.example"], null)).toBe(false);
  });

  it("finds the last due time by the client's day", () => {
    const daily = ReportExpected.parse({ every: "day", byHour: 8 });
    const tz = "America/Chicago";
    // 2026-11-20 10:00 in Chicago (UTC-6).
    const now = new Date("2026-11-20T16:00:00Z");
    expect(lastDue(daily, now, tz)).toEqual({
      due: new Date("2026-11-20T14:00:00Z"),
      previous: new Date("2026-11-19T14:00:00Z"),
    });
    // 07:00 in Chicago: today's isn't due yet.
    expect(lastDue(daily, new Date("2026-11-20T13:00:00Z"), tz).due).toEqual(
      new Date("2026-11-19T14:00:00Z"),
    );
    const weekly = ReportExpected.parse({ every: "week", weekday: 1, byHour: 9 });
    // Friday 2026-11-20: the Monday before, 2026-11-16.
    expect(lastDue(weekly, now, "UTC").due).toEqual(new Date("2026-11-16T09:00:00Z"));
    const monthly = ReportExpected.parse({ every: "month", day: 25, byHour: 9 });
    expect(lastDue(monthly, now, "UTC")).toEqual({
      due: new Date("2026-10-25T09:00:00Z"),
      previous: new Date("2026-09-25T09:00:00Z"),
    });
  });

  it("says a report is missing only past its grace, after the profile, with none for the period", () => {
    const daily = ReportExpected.parse({ every: "day", byHour: 8, graceHours: 2 });
    const base = { timezone: "UTC", since: new Date("2026-11-01T00:00:00Z"), lastLandedAt: null };
    expect(reportMissing(daily, { ...base, now: new Date("2026-11-20T09:00:00Z") }).missing).toBe(
      false,
    );
    expect(reportMissing(daily, { ...base, now: new Date("2026-11-20T10:00:00Z") })).toEqual({
      missing: true,
      due: new Date("2026-11-20T08:00:00Z"),
    });
    expect(
      reportMissing(daily, {
        ...base,
        now: new Date("2026-11-20T10:00:00Z"),
        lastLandedAt: new Date("2026-11-20T07:30:00Z"),
      }).missing,
    ).toBe(false);
    expect(
      reportMissing(daily, {
        ...base,
        now: new Date("2026-11-20T10:00:00Z"),
        since: new Date("2026-11-20T09:00:00Z"),
      }).missing,
    ).toBe(false);
  });

  it("proposes a first profile's columns from a file's headers and values", () => {
    const r = read({ header_row: 4 });
    expect(proposeColumns(r)).toEqual([
      { field: "ticket", headers: ["Ticket"], type: "text", required: true },
      { field: "date", headers: ["Date"], type: "date", dateStyle: "mdy", required: true },
      { field: "customer", headers: ["Customer"], type: "text", required: true },
      { field: "netSales", headers: ["Net Sales"], type: "money", required: true },
    ]);
    // A proposed profile is a valid one.
    expect(
      ReportProfile.safeParse({
        id: "cr2-daily-sales",
        name: "CR2 daily sales",
        read: { header_row: 4, columns: proposeColumns(r) },
      }).success,
    ).toBe(true);
  });
});
