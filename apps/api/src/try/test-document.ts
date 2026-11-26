// A made-up document for Try it (docs/plan.md §1.186, rebuilt 2026-11-26): the model's contents of
// a receipt, an invoice or a bill (core's `TestDocument`) drawn as a one-page PDF with pdf-lib
// (pure JavaScript, works in Workers), standard Helvetica. It looks like the plain documents small
// vendors send, so the workflow's Read a document step reads it as it would a real one. Marked
// "Test document" in its footer: it is never anyone's real record.
import type { TestDocument } from "@countersign/core";
import { PageSizes, PDFDocument, type PDFFont, rgb, StandardFonts } from "pdf-lib";
import { INK, MUTED, winAnsi } from "../weekly/pdf";

const MARGIN = 56;
const LINE = rgb(0xdc / 255, 0xdf / 255, 0xe2 / 255);

function money(v: number | string | undefined, currency: string): string {
  if (v === undefined || v === "") return "";
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(n)) return String(v);
  const sign = currency === "USD" || currency === "CAD" ? "$" : `${currency} `;
  return `${n < 0 ? "-" : ""}${sign}${Math.abs(n).toFixed(2)}`;
}

export async function renderTestDocument(doc: TestDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(`${doc.kind} ${doc.number ?? ""}`.trim());
  pdf.setProducer("Mezonas (test document)");
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const page = pdf.addPage(PageSizes.Letter);
  const [width, height] = PageSizes.Letter;
  let y = height - MARGIN;

  const text = (s: string, x: number, at: number, size = 10, f: PDFFont = font, color = INK) =>
    page.drawText(winAnsi(f, s), { x, y: at, size, font: f, color });
  const right = (s: string, xRight: number, at: number, size = 10, f: PDFFont = font) => {
    const t = winAnsi(f, s);
    page.drawText(t, {
      x: xRight - f.widthOfTextAtSize(t, size),
      y: at,
      size,
      font: f,
      color: INK,
    });
  };
  const lines = (s: string | undefined) => (s ? s.split(/\n|,\s*(?=\S)/).slice(0, 4) : []);

  // Who issued it, and the kind, number and dates.
  text(doc.from.name, MARGIN, y, 16, bold);
  right(doc.kind.toUpperCase(), width - MARGIN, y, 16, bold);
  y -= 18;
  let left = y;
  for (const l of lines(doc.from.address)) {
    text(l, MARGIN, left, 9, font, MUTED);
    left -= 12;
  }
  let r = y;
  const facts: [string, string | undefined][] = [
    ["No.", doc.number],
    ["Date", doc.date],
    ["Due", doc.dueDate],
  ];
  for (const [k, v] of facts) {
    if (!v) continue;
    right(`${k} ${v}`, width - MARGIN, r, 9);
    r -= 12;
  }
  y = Math.min(left, r) - 16;

  if (doc.to) {
    text("Bill to", MARGIN, y, 8, bold, MUTED);
    y -= 12;
    text(doc.to.name, MARGIN, y, 10);
    y -= 12;
    for (const l of lines(doc.to.address)) {
      text(l, MARGIN, y, 9, font, MUTED);
      y -= 12;
    }
    y -= 10;
  }

  // The lines.
  const cols = { qty: width - MARGIN - 230, price: width - MARGIN - 110, amount: width - MARGIN };
  page.drawLine({
    start: { x: MARGIN, y: y + 4 },
    end: { x: width - MARGIN, y: y + 4 },
    thickness: 1,
    color: LINE,
  });
  y -= 10;
  text("Description", MARGIN, y, 8, bold, MUTED);
  right("Qty", cols.qty, y, 8, bold);
  right("Unit price", cols.price, y, 8, bold);
  right("Amount", cols.amount, y, 8, bold);
  y -= 14;
  for (const l of doc.lines) {
    if (y < MARGIN + 120) break;
    const what = l.sku ? `${l.description} (${l.sku})` : l.description;
    text(what.slice(0, 70), MARGIN, y, 10);
    right(
      l.quantity === undefined ? "" : `${l.quantity}${l.unit ? ` ${l.unit}` : ""}`,
      cols.qty,
      y,
    );
    right(money(l.unitPrice, doc.currency), cols.price, y);
    right(money(l.amount, doc.currency), cols.amount, y);
    y -= 16;
  }
  page.drawLine({
    start: { x: MARGIN, y: y + 8 },
    end: { x: width - MARGIN, y: y + 8 },
    thickness: 1,
    color: LINE,
  });
  y -= 8;

  // The totals.
  const totals: [string, number | string | undefined, PDFFont][] = [
    ["Subtotal", doc.subtotal, font],
    ["Tax", doc.tax, font],
    ["Total", doc.total, bold],
  ];
  for (const [k, v, f] of totals) {
    if (v === undefined || v === "") continue;
    right(k, cols.price, y, 10, f);
    right(money(v, doc.currency), cols.amount, y, 10, f);
    y -= 16;
  }
  if (doc.paid) {
    y -= 6;
    text(`Paid: ${doc.paid}`, MARGIN, y, 10);
    y -= 14;
  }
  if (doc.notes) {
    y -= 6;
    text(doc.notes.slice(0, 110), MARGIN, y, 9, font, MUTED);
  }
  text(
    "Test document made up by Mezonas to try a workflow. Not a real record.",
    MARGIN,
    32,
    7,
    font,
    MUTED,
  );
  return pdf.save();
}
