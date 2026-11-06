import { LOCALES, type WeeklyTableView } from "@countersign/core";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { paperFor, weeklyPdf, winAnsi } from "./pdf";

const table: WeeklyTableView = {
  id: "0190f0a0-0000-7000-8000-000000000001",
  weekStart: "2026-11-02",
  status: "sent",
  stats: {
    weekStart: "2026-11-02",
    from: "2026-11-02T06:00:00.000Z",
    to: "2026-11-09T06:00:00.000Z",
    runs: { done: 12, lastWeek: 15, change: -3, sources: [] },
    changes: { automatic: 2, signed: 5, sources: [] },
    signatures: { given: 5, sources: [] },
    documents: { read: 9, sources: [] },
    agents: [{ id: "a", name: "Pia", runsDone: 12, kpis: [] }],
    computedAt: "2026-11-09T13:00:00.000Z",
  },
  note: "Gute Woche. Ça va. 東京 ✓ −3 «ok»\nSecond line.",
  noteBy: { id: "u", name: "Ana Lima" },
  decisions: [
    {
      id: "d",
      title: "Switch supplier?",
      body: "Two quotes.",
      options: ["Yes", "No"],
      sources: [],
    },
  ],
  nextWeek: "Freight.",
  setup: {
    items: [{ kind: "connect", agentId: "a", agentName: "Pia", connector: "amex", tool: "Amex" }],
  },
  sentAt: "2026-11-09T13:00:00.000Z",
  updatedAt: "2026-11-09T13:00:00.000Z",
};

describe("the Weekly Table's PDF", () => {
  it("replaces what WinAnsi can't draw and keeps what it can", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    expect(winAnsi(font, "Ça va «ok» é ü ß ñ ã")).toBe("Ça va «ok» é ü ß ñ ã");
    expect(winAnsi(font, "東京 ✓ −3")).toBe("?? ? -3");
  });

  it("renders in every language, on Letter or A4, with the same bytes for the same row", async () => {
    for (const locale of LOCALES) {
      const bytes = await weeklyPdf({ table, clientName: "Millwork Co", locale, paper: "a4" });
      const doc = await PDFDocument.load(bytes);
      expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
      expect(Math.round(doc.getPage(0).getWidth())).toBe(595);
    }
    const a = await weeklyPdf({ table, clientName: "Millwork Co", locale: "en", paper: "letter" });
    const b = await weeklyPdf({ table, clientName: "Millwork Co", locale: "en", paper: "letter" });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(Math.round((await PDFDocument.load(a)).getPage(0).getWidth())).toBe(612);
  });

  it("long notes flow onto more pages", async () => {
    const long = { ...table, note: "A sentence that goes on. ".repeat(600) };
    const doc = await PDFDocument.load(
      await weeklyPdf({ table: long, clientName: "Millwork Co", locale: "en", paper: "a4" }),
    );
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it("paper by the client's language and zone", () => {
    expect(paperFor({ language: "en", timezone: "America/Chicago" })).toBe("letter");
    expect(paperFor({ language: null, timezone: "America/New_York" })).toBe("letter");
    expect(paperFor({ language: "es", timezone: "America/Mexico_City" })).toBe("a4");
    expect(paperFor({ language: "en", timezone: "Europe/London" })).toBe("a4");
  });
});
