// Invariant 9 (Opus review of stream E, 2026-11-25): a skill driven by a model reads untrusted
// documents (a vendor's quote, a bank statement), so none may be offered a tool that records a
// reading on a document, or that takes a reading from its caller. Injected text in a document must
// not be able to plant a reading on another one.
import { afterAll, describe, expect, it } from "vitest";
import { createApiHarness } from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());
const RECORDS_A_READING = ["docs.reading.record", "docs.extract"];

describe.skipIf(!h)("model-driven skills and readings", () => {
  const platform = () => (h as NonNullable<typeof h>).platform;
  const driven = () =>
    platform()
      .catalog.list()
      .filter((s) => s.mode === "agent" || s.mode === "task");

  it("there are model-driven skills that read documents", () => {
    const readers = driven().filter((s) => s.tools.includes("docs.read"));
    expect(readers.map((s) => s.id)).toEqual(
      expect.arrayContaining(["materials.read-quote", "bookkeeping.read-statement"]),
    );
  });

  it("none is offered a tool that records a reading", () => {
    for (const s of driven()) {
      for (const t of RECORDS_A_READING) expect(s.tools, `${s.id} → ${t}`).not.toContain(t);
    }
  });

  it("docs.read takes no reading from its caller", () => {
    const spec = platform().tools.get("docs.read")?.spec;
    const keys = Object.keys((spec?.input as { properties: object }).properties).sort();
    expect(keys).toEqual(["as", "documentId"]);
  });
});
