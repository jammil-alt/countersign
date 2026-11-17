import { describe, expect, it } from "vitest";
import type { ConnectionRef } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { captureBefore, executeWrite, runReadTool, standInOutput, ToolCallError } from "../invoke";
import { noopLogger } from "../logger";
import { ConnectorRegistry } from "../registry";
import { fakeDesktop } from "./fake";
import { createDesktopConnector, DESKTOP_TOOLS, DesktopUnavailableError } from "./index";

const TENANT = "0192f7a0-0000-7000-8000-000000000001";
const BOOKS = "0192f7a0-0000-7000-8000-0000000000b1";
const SCANS = "0192f7a0-0000-7000-8000-0000000000b2";
const OTHER = "0192f7a0-0000-7000-8000-0000000000b3";
const NOW = new Date("2026-11-17T10:00:00Z");
const KEY = "run-1:step-1:0";

function setup() {
  const connector = createDesktopConnector();
  const desktop = fakeDesktop();
  desktop.put(BOOKS, "Costs.xlsx", {
    kind: "xlsx",
    sheets: [
      {
        name: "Costs",
        cells: [
          ["Date", "Vendor", "Amount"],
          ["Oct 1", "Northside Lumber", 412.5],
          ["Oct 3", "Hardwood Supply", "=B2*2"],
        ],
      },
      { name: "Notes", cells: [["hello"]] },
    ],
  });
  desktop.put(SCANS, "list.csv", { kind: "text", text: "a,b\n1,2" });
  const connection: ConnectionRef = {
    id: "0192f7a0-0000-7000-8000-000000000005",
    tenantId: TENANT,
    connector: "desktop",
    status: "connected",
    externalAccountId: null,
    config: {
      deviceId: "0192f7a0-0000-7000-8000-0000000000d1",
      name: "Front office PC",
      platform: "windows",
      folders: [
        {
          id: BOOKS,
          path: "C:\\Users\\ana\\Documents\\Books",
          label: "Books",
          access: "read_write",
          ingest: false,
        },
        {
          id: SCANS,
          path: "C:\\Users\\ana\\Documents\\Scans",
          label: "Scans",
          access: "read",
          ingest: true,
        },
      ],
    },
    permissions: {},
  };
  const ctx = {
    tenantId: TENANT,
    connection,
    credentials: memoryCredentials({}),
    logger: noopLogger,
    now: () => NOW,
    services: { desktop },
    idempotencyKey: KEY,
  };
  return { connector, desktop, ctx };
}

describe("desktop connector", () => {
  it("registers six tools: three reads and three writes, with no delete", () => {
    const { connector } = setup();
    new ConnectorRegistry([connector]);
    expect(connector.manifest.tools.map((t) => [t.id, t.verb, t.sideEffect, t.undo])).toEqual([
      [DESKTOP_TOOLS.list, "read", "none", undefined],
      [DESKTOP_TOOLS.read, "read", "none", undefined],
      [DESKTOP_TOOLS.xlsxRead, "read", "none", undefined],
      [DESKTOP_TOOLS.xlsxAppend, "create", "external", { kind: "none" }],
      [DESKTOP_TOOLS.xlsxUpdate, "update", "external", { kind: "restore" }],
      [DESKTOP_TOOLS.create, "create", "external", { kind: "none" }],
    ]);
    expect(connector.manifest.auth).toBe("none");
  });

  it("reads cells and text through one job each", async () => {
    const { connector, desktop, ctx } = setup();
    const read = await runReadTool(
      connector,
      DESKTOP_TOOLS.xlsxRead,
      { folderId: BOOKS, path: "Costs.xlsx", range: "A1:C2" },
      ctx,
    );
    expect(read.output).toMatchObject({
      sheet: "Costs",
      values: [
        ["Date", "Vendor", "Amount"],
        ["Oct 1", "Northside Lumber", 412.5],
      ],
      lastRow: 3,
    });
    const text = await runReadTool(
      connector,
      DESKTOP_TOOLS.read,
      { folderId: SCANS, path: "list.csv" },
      ctx,
    );
    expect(text.output).toMatchObject({ text: "a,b\n1,2" });
    expect(desktop.jobs.map((j) => j.kind)).toEqual(["xlsx.read", "file.read"]);
  });

  it("refuses a folder the computer doesn't give before any job is sent", async () => {
    const { connector, desktop, ctx } = setup();
    await expect(
      runReadTool(connector, DESKTOP_TOOLS.xlsxRead, { folderId: OTHER, path: "x.xlsx" }, ctx),
    ).rejects.toThrow(/isn't one Front office PC gives/);
    expect(desktop.jobs).toEqual([]);
  });

  it("refuses a write to a folder given for reading only", async () => {
    const { connector, desktop, ctx } = setup();
    await expect(
      captureBefore(
        connector,
        DESKTOP_TOOLS.create,
        { folderId: SCANS, path: "out.csv", text: "x" },
        ctx,
      ),
    ).rejects.toThrow(/reading only/);
    expect(desktop.jobs).toEqual([]);
  });

  it("refuses paths out of the folder and files that aren't workbooks", async () => {
    const { connector, ctx } = setup();
    await expect(
      runReadTool(connector, DESKTOP_TOOLS.xlsxRead, { folderId: BOOKS, path: "../x.xlsx" }, ctx),
    ).rejects.toThrow(ToolCallError);
    await expect(
      runReadTool(connector, DESKTOP_TOOLS.xlsxRead, { folderId: BOOKS, path: "x.xlsm" }, ctx),
    ).rejects.toThrow(ToolCallError);
  });

  it("appends rows once: the approver sees the last row, a retry returns what was written", async () => {
    const { connector, desktop, ctx } = setup();
    const input = { folderId: BOOKS, path: "Costs.xlsx", rows: [["Oct 7", "Acme", 99]] };
    const { before } = await captureBefore(connector, DESKTOP_TOOLS.xlsxAppend, input, ctx);
    expect(before).toMatchObject({
      folder: { label: "Books", computer: "Front office PC" },
      sheet: "Costs",
      lastRow: 3,
      adding: 1,
    });
    const first = await executeWrite(connector, DESKTOP_TOOLS.xlsxAppend, input, ctx);
    expect(first.output).toMatchObject({ range: "A4:C4", firstRow: 4, alreadyDone: false });
    const again = await executeWrite(connector, DESKTOP_TOOLS.xlsxAppend, input, ctx);
    expect(again.output).toMatchObject({ range: "A4:C4", alreadyDone: true });
    const book = desktop.get(BOOKS, "Costs.xlsx");
    expect(book?.kind === "xlsx" && book.sheets[0]?.cells.length).toBe(4);
  });

  it("asks the person to close an open workbook", async () => {
    const { connector, desktop, ctx } = setup();
    desktop.open.add("Costs.xlsx");
    await expect(
      executeWrite(
        connector,
        DESKTOP_TOOLS.xlsxAppend,
        { folderId: BOOKS, path: "Costs.xlsx", rows: [["x"]] },
        ctx,
      ),
    ).rejects.toThrow(/is open/);
  });

  it("updates cells only if they still hold what the approver saw, and undoes by restoring them", async () => {
    const { connector, desktop, ctx } = setup();
    const input = { folderId: BOOKS, path: "Costs.xlsx", range: "C2:C2", values: [[450]] };
    const { before } = await captureBefore(connector, DESKTOP_TOOLS.xlsxUpdate, input, ctx);
    expect(before).toMatchObject({ range: "C2:C2", values: [[412.5]] });
    const book = desktop.get(BOOKS, "Costs.xlsx");
    if (book?.kind !== "xlsx") throw new Error("no book");
    // Someone typed into the cell after the change was proposed.
    (book.sheets[0]?.cells[1] ?? [])[2] = 415;
    await expect(
      executeWrite(connector, DESKTOP_TOOLS.xlsxUpdate, input, {
        ...ctx,
        proposedBefore: before,
      }),
    ).rejects.toThrow(/changed since/);
    (book.sheets[0]?.cells[1] ?? [])[2] = 412.5;
    const done = await executeWrite(connector, DESKTOP_TOOLS.xlsxUpdate, input, {
      ...ctx,
      proposedBefore: before,
    });
    expect(done.output).toMatchObject({ updatedCells: 1, alreadyDone: false });
    const handler = connector.tools[DESKTOP_TOOLS.xlsxUpdate];
    if (handler?.kind !== "write") throw new Error("not a write");
    expect(handler.undoInput?.({ input, before, output: done.output, current: null })).toEqual({
      folderId: BOOKS,
      path: "Costs.xlsx",
      sheet: "Costs",
      range: "C2:C2",
      values: [[412.5]],
    });
  });

  it("never replaces a formula, and an undo over one is left to a person", async () => {
    const { connector, ctx } = setup();
    const input = { folderId: BOOKS, path: "Costs.xlsx", range: "C3:C3", values: [[1]] };
    const { before } = await captureBefore(connector, DESKTOP_TOOLS.xlsxUpdate, input, ctx);
    await expect(
      executeWrite(connector, DESKTOP_TOOLS.xlsxUpdate, input, { ...ctx, proposedBefore: before }),
    ).rejects.toThrow(/formula/);
    const handler = connector.tools[DESKTOP_TOOLS.xlsxUpdate];
    if (handler?.kind !== "write") throw new Error("not a write");
    expect(handler.undoInput?.({ input, before, output: {}, current: null })).toBeNull();
  });

  it("refuses an update whose values don't fit the range", async () => {
    const { connector, ctx } = setup();
    await expect(
      captureBefore(
        connector,
        DESKTOP_TOOLS.xlsxUpdate,
        { folderId: BOOKS, path: "Costs.xlsx", range: "B2:C3", values: [[1, 2]] },
        ctx,
      ),
    ).rejects.toThrow(ToolCallError);
  });

  it("creates a new file, never over one that is there", async () => {
    const { connector, desktop, ctx } = setup();
    const input = { folderId: BOOKS, path: "Reports/Week 46.csv", text: "a,b" };
    const r = await executeWrite(connector, DESKTOP_TOOLS.create, input, ctx);
    expect(r.output).toMatchObject({ path: "Reports/Week 46.csv", alreadyDone: false });
    expect(desktop.get(BOOKS, "Reports/Week 46.csv")).toEqual({ kind: "text", text: "a,b" });
    await expect(
      executeWrite(connector, DESKTOP_TOOLS.create, input, { ...ctx, idempotencyKey: "other-key" }),
    ).rejects.toThrow(/already there/);
  });

  it("says plainly when the computer is off, and when the folder was taken back on it", async () => {
    const { connector, desktop, ctx } = setup();
    desktop.offline = true;
    await expect(
      runReadTool(connector, DESKTOP_TOOLS.list, { folderId: BOOKS }, ctx),
    ).rejects.toThrow(DesktopUnavailableError);
    desktop.offline = false;
    desktop.revoked.add(BOOKS);
    await expect(
      runReadTool(connector, DESKTOP_TOOLS.list, { folderId: BOOKS }, ctx),
    ).rejects.toThrow(/no longer gives/);
  });

  it("refuses when the deployment has no desktop service, or the computer isn't paired", async () => {
    const { connector, ctx } = setup();
    await expect(
      runReadTool(connector, DESKTOP_TOOLS.list, { folderId: BOOKS }, { ...ctx, services: {} }),
    ).rejects.toThrow(/isn't set up/);
    await expect(
      runReadTool(
        connector,
        DESKTOP_TOOLS.list,
        { folderId: BOOKS },
        { ...ctx, connection: { ...ctx.connection, config: {} } },
      ),
    ).rejects.toThrow(/isn't paired/);
  });

  it("checks the computer's answer like any provider's", async () => {
    const { connector, ctx } = setup();
    const services = { desktop: { run: async () => ({ ok: true as const, output: { x: 1 } }) } };
    await expect(
      runReadTool(connector, DESKTOP_TOOLS.list, { folderId: BOOKS }, { ...ctx, services }),
    ).rejects.toThrow(/expected shape/);
  });

  it("gives test runs a stand-in for each write", () => {
    const { connector } = setup();
    expect(
      standInOutput(connector, DESKTOP_TOOLS.xlsxAppend, {
        folderId: BOOKS,
        path: "Costs.xlsx",
        rows: [["a", "b"]],
      }),
    ).toMatchObject({ range: "A2:B2", rows: 1 });
  });
});
