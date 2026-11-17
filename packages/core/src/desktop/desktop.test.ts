import { describe, expect, it } from "vitest";
import { formatXlsxRange, parseXlsxRange, xlsxColumnLetters, xlsxColumnNumber } from "./a1";
import {
  DesktopRelativePath,
  desktopFileType,
  folderGrantProblem,
  isWithin,
  normaliseDevicePath,
  relativePathProblem,
} from "./paths";
import {
  DesktopJobRequest,
  DesktopJobResult,
  desktopRequestText,
  padXlsxGrid,
  sameXlsxCell,
} from "./protocol";

const FOLDER = "7b0f6c1e-2d7a-4a8e-9a1f-1c2b3d4e5f60";

describe("normaliseDevicePath", () => {
  it("normalises Mac paths and refuses relative ones and dot segments", () => {
    expect(normaliseDevicePath("/Users/ana//Documents/", "mac")).toBe("/Users/ana/Documents");
    expect(normaliseDevicePath("Users/ana", "mac")).toBeNull();
    expect(normaliseDevicePath("/Users/ana/../bob", "mac")).toBeNull();
    expect(normaliseDevicePath("/Users/ana/\u0007x", "mac")).toBeNull();
  });

  it("normalises Windows drive paths and refuses shares and streams", () => {
    expect(normaliseDevicePath("c:/Users/ana\\Documents\\", "windows")).toBe(
      "C:\\Users\\ana\\Documents",
    );
    expect(normaliseDevicePath("\\\\server\\share\\x", "windows")).toBeNull();
    expect(normaliseDevicePath("C:\\Users\\ana\\a.txt:secret", "windows")).toBeNull();
    expect(normaliseDevicePath("C:relative", "windows")).toBeNull();
  });
});

describe("isWithin", () => {
  it("compares whole segments, ignoring case", () => {
    expect(isWithin("/Users/ana/Docs", "/users/ana/docs/a.pdf", "mac")).toBe(true);
    expect(isWithin("/Users/ana/Docs", "/Users/ana/Docs2/a.pdf", "mac")).toBe(false);
    expect(isWithin("C:\\Data", "C:\\data\\x.xlsx", "windows")).toBe(true);
  });
});

describe("folderGrantProblem", () => {
  const macHome = "/Users/ana";
  const winHome = "C:\\Users\\ana";

  it("allows a work folder inside home, or on another drive", () => {
    expect(folderGrantProblem("/Users/ana/Documents/Accounting", "mac", macHome)).toBeNull();
    expect(folderGrantProblem("/Volumes/Shared/Invoices", "mac", macHome)).toBeNull();
    expect(folderGrantProblem("C:\\Users\\ana\\Documents\\Books", "windows", winHome)).toBeNull();
    expect(folderGrantProblem("D:\\Accounting", "windows", winHome)).toBeNull();
  });

  it("refuses home, anything above it and the top of a drive", () => {
    expect(folderGrantProblem("/Users/ana", "mac", macHome)).toMatch(/home folder/);
    expect(folderGrantProblem("/Users", "mac", macHome)).toMatch(/home folder/);
    expect(folderGrantProblem("/", "mac", macHome)).toMatch(/whole drive/);
    expect(folderGrantProblem("/Volumes", "mac", macHome)).toMatch(/whole drive/);
    expect(folderGrantProblem("C:\\", "windows", winHome)).toMatch(/whole drive/);
    expect(folderGrantProblem("C:\\Users", "windows", winHome)).toMatch(/home folder/);
  });

  it("refuses system, hidden and other apps' folders", () => {
    expect(folderGrantProblem("/System/Library", "mac", macHome)).toMatch(/System/);
    expect(folderGrantProblem("/private/tmp", "mac", macHome)).toMatch(/System/);
    expect(folderGrantProblem("/Users/ana/.ssh", "mac", macHome)).toMatch(/Hidden/);
    expect(folderGrantProblem("/Users/ana/Library/Keychains", "mac", macHome)).toMatch(/Library/);
    expect(folderGrantProblem("C:\\Windows\\System32", "windows", winHome)).toMatch(/System/);
    expect(folderGrantProblem("c:\\program files\\x", "windows", winHome)).toMatch(/System/);
    expect(folderGrantProblem("C:\\Users\\ana\\AppData\\Roaming", "windows", winHome)).toMatch(
      /AppData/,
    );
  });
});

describe("relative paths", () => {
  it("allows plain paths inside a folder", () => {
    expect(relativePathProblem("Invoices/2026/Northside 1042.pdf")).toBeNull();
    expect(DesktopRelativePath.safeParse("Budget.xlsx").success).toBe(true);
  });

  it("refuses anything that could leave the folder or confuse Windows", () => {
    for (const p of [
      "",
      "/etc/passwd",
      "../x",
      "a/../../x",
      "a//b",
      "a\\b",
      "C:x",
      "a/b.",
      "a/b ",
      "con.txt",
      "LPT1",
      "a*?",
    ]) {
      expect(relativePathProblem(p), p).not.toBeNull();
    }
  });
});

describe("desktopFileType", () => {
  it("sends documents and office files, never lock files, hidden files or programs", () => {
    expect(desktopFileType("Invoices/a.PDF")).toBe("application/pdf");
    expect(desktopFileType("Budget.xlsx")).toContain("spreadsheetml");
    expect(desktopFileType("~$Budget.xlsx")).toBeNull();
    expect(desktopFileType(".DS_Store")).toBeNull();
    expect(desktopFileType("setup.exe")).toBeNull();
    expect(desktopFileType("macro.xlsm")).toBeNull();
    expect(desktopFileType("README")).toBeNull();
  });
});

describe("A1", () => {
  it("converts columns both ways within Excel's grid", () => {
    expect(xlsxColumnNumber("A")).toBe(1);
    expect(xlsxColumnNumber("xfd")).toBe(16_384);
    expect(xlsxColumnNumber("XFE")).toBeNull();
    expect(xlsxColumnLetters(28)).toBe("AB");
  });

  it("parses ranges and puts corners in order", () => {
    expect(parseXlsxRange("C10:A1")).toEqual({ startCol: 1, startRow: 1, endCol: 3, endRow: 10 });
    expect(parseXlsxRange("A2:D")).toEqual({ startCol: 1, startRow: 2, endCol: 4, endRow: null });
    expect(parseXlsxRange("A:C")).toEqual({ startCol: 1, startRow: 1, endCol: 3, endRow: null });
    expect(parseXlsxRange("B4")).toEqual({ startCol: 2, startRow: 4, endCol: 2, endRow: 4 });
    expect(parseXlsxRange("A:C5")).toBeNull();
    expect(parseXlsxRange("A0")).toBeNull();
    expect(parseXlsxRange("A1:B2:C3")).toBeNull();
    expect(formatXlsxRange({ startCol: 1, startRow: 2, endCol: 4, endRow: null })).toBe("A2:D");
  });
});

describe("jobs", () => {
  it("takes each kind with its defaults", () => {
    const r = DesktopJobRequest.parse({ kind: "xlsx.read", folderId: FOLDER, path: "Q4.xlsx" });
    expect(r).toMatchObject({ render: "values", limit: 200 });
    const list = DesktopJobRequest.parse({ kind: "files.list", folderId: FOLDER });
    expect(list).toMatchObject({ depth: 1, limit: 200 });
  });

  it("refuses a path out of the folder and a range too wide", () => {
    expect(
      DesktopJobRequest.safeParse({ kind: "file.read", folderId: FOLDER, path: "../x.csv" })
        .success,
    ).toBe(false);
    expect(
      DesktopJobRequest.safeParse({
        kind: "xlsx.read",
        folderId: FOLDER,
        path: "a.xlsx",
        range: "A1:ZZ2",
      }).success,
    ).toBe(false);
  });

  it("results carry a fixed error code", () => {
    expect(
      DesktopJobResult.safeParse({ ok: false, error: { code: "file_open", message: "x" } }).success,
    ).toBe(true);
    expect(
      DesktopJobResult.safeParse({ ok: false, error: { code: "whatever", message: "x" } }).success,
    ).toBe(false);
  });
});

describe("signed requests", () => {
  it("are fixed lines with the method upper-cased", () => {
    expect(
      desktopRequestText({
        deviceId: "d",
        method: "post",
        path: "/api/desktop/files",
        bodySha256: "h",
        at: "2026-11-17T10:00:00.000Z",
      }),
    ).toBe("mezonas-desktop:v1\nd\nPOST\n/api/desktop/files\nh\n2026-11-17T10:00:00.000Z");
  });
});

describe("grids", () => {
  it("pads and compares cells, empty text and null alike", () => {
    expect(padXlsxGrid([[1]], 2, 2)).toEqual([
      [1, null],
      [null, null],
    ]);
    expect(sameXlsxCell("", null)).toBe(true);
    expect(sameXlsxCell(1, "1")).toBe(false);
  });
});
