// The export writers (docs/plan.md §1.35 "Exports"): ZIP archives other tools open (checked with
// Node's zlib CRC and, where Python is installed, its zipfile module), and safe CSV.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { csvCell, csvFile, documentPath, jsonCell, safeFileName, scrubForExport } from "./csv";
import { crc32, planZip, zipSync } from "./zip";
import { csvRecords, readZip, text } from "./zip.test-helper";

const enc = new TextEncoder();
const files = [
  { name: "README.txt", bytes: enc.encode("hello") },
  { name: "documents/ab12cd34-Rechnung März.pdf", bytes: enc.encode("%PDF-1.4 fake") },
  { name: "empty.csv", bytes: new Uint8Array() },
];

/** Python's zipfile, when there is a Python: its own reader and CRC check of the archive. */
function pythonCheck(zip: Uint8Array): string[] | null {
  const probe = spawnSync("python3", ["--version"]);
  if (probe.status !== 0) return null;
  const dir = mkdtempSync(join(tmpdir(), "zip-"));
  try {
    const path = join(dir, "a.zip");
    writeFileSync(path, zip);
    const r = spawnSync("python3", [
      "-I",
      "-c",
      "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\nprint('\\n'.join(z.namelist()))",
      path,
    ]);
    if (r.status !== 0) throw new Error(String(r.stderr));
    return String(r.stdout).trim().split("\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("zip", () => {
  it("computes the ZIP CRC-32, also across pieces", () => {
    const a = enc.encode("first page,");
    const b = enc.encode("second page");
    expect(crc32(a)).toBe(zlibCrc32(a) >>> 0);
    const both = new Uint8Array([...a, ...b]);
    expect(crc32(b, crc32(a))).toBe(zlibCrc32(both) >>> 0);
  });

  for (const zip64 of ["auto", "always"] as const) {
    it(`writes an archive others read back (zip64 ${zip64})`, () => {
      const zip = zipSync(files, new Date("2026-11-06T10:00:00Z"), { zip64 });
      const read = readZip(zip);
      expect([...read.keys()]).toEqual(files.map((f) => f.name));
      for (const f of files) expect(read.get(f.name)).toEqual(f.bytes);
      expect(zip.length).toBe(
        planZip(
          files.map((f) => ({ name: f.name, size: f.bytes.length, crc: crc32(f.bytes) })),
          new Date(),
          { zip64 },
        ).size,
      );
      const names = pythonCheck(zip);
      if (names) expect(names).toEqual(files.map((f) => f.name));
    });
  }
});

describe("csv", () => {
  it("quotes what needs quoting and guards formulas, not numbers", () => {
    expect(csvCell('say "hi", then\nbye')).toBe('"say ""hi"", then\nbye"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-12.5000")).toBe("-12.5000");
    expect(csvCell(null)).toBe("");
    expect(csvCell(new Date("2026-11-06T00:00:00Z"))).toBe("2026-11-06T00:00:00.000Z");
    expect(csvCell(["a", "b"])).toBe("a; b");
    const rows = csvRecords(text(csvFile(["a", "b"], [["x,y", 1]])));
    expect(rows).toEqual([{ a: "x,y", b: "1" }]);
  });

  it("drops forbidden fields at any depth from JSON cells", () => {
    const value = {
      amount: "12.00",
      accessToken: "t",
      nested: [{ instructions: "do x", prompt: "p", costUsd: "1", keep: 1 }],
      credentials: { password: "x" },
    };
    expect(scrubForExport(value)).toEqual({ amount: "12.00", nested: [{ keep: 1 }] });
    expect(jsonCell(null)).toBeNull();
  });

  it("names files safely and documents the same way everywhere", () => {
    expect(safeFileName('../a/b:c*"d".pdf')).toBe("_a_b_c__d_.pdf");
    expect(safeFileName("")).toBe("document");
    expect(
      documentPath({ id: "0193a1b2-0000-7000-8000-00000000abcd", filename: "inv/1.pdf" }),
    ).toBe("documents/0000abcd-inv_1.pdf");
  });
});
