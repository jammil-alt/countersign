// The Weekly Table as a PDF (ARCHITECTURE §11.4, docs/plan.md §1.37): the stored row rendered on
// request with pdf-lib (pure JavaScript, works in Workers), standard Helvetica, nothing stored.
// Characters outside WinAnsi are replaced. Words from core's WEEKLY_WORDS in the client's language.

import { type Locale, WEEKLY_WORDS, type WeeklyTableView } from "@countersign/core";
import { PageSizes, PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";

// The design system's ink, muted ink and slate (packages/design-system/tokens.css).
const INK = rgb(0x15 / 255, 0x1a / 255, 0x21 / 255);
const MUTED = rgb(0x53 / 255, 0x5b / 255, 0x65 / 255);
const SLATE = rgb(0x23 / 255, 0x41 / 255, 0x5e / 255);
const LINE = rgb(0xdc / 255, 0xdf / 255, 0xe2 / 255);

const MARGIN = 56;

/** Letter where the client works in English in the Americas, else A4. */
// DECISION: "A4/Letter by the client's locale" is read as Letter for clients whose language is
// English (or unset) with an America/* time zone (the US and Canada), A4 for everyone else.
export function paperFor(input: { language: Locale | null; timezone: string }): "letter" | "a4" {
  const english = input.language === null || input.language === "en";
  return english && input.timezone.startsWith("America/") ? "letter" : "a4";
}

const REPLACE: Record<string, string> = {
  "\u2212": "-", // minus
  "\u2010": "-", // hyphen
  "\u2011": "-", // non-breaking hyphen
  "\u00a0": " ", // no-break space
  "\u202f": " ", // narrow no-break space (French number groups)
  "\t": " ",
};

/** Text Helvetica's WinAnsi can draw: known look-alikes swapped, anything else as `?`. */
export function winAnsi(font: PDFFont, text: string): string {
  let out = "";
  for (const raw of text.normalize("NFC")) {
    const ch = REPLACE[raw] ?? raw;
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

class Writer {
  private page: PDFPage;
  private y: number;
  constructor(
    private readonly doc: PDFDocument,
    private readonly size: [number, number],
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.page = doc.addPage(size);
    this.y = size[1] - MARGIN;
  }

  private get width() {
    return this.size[0] - 2 * MARGIN;
  }

  private room(h: number) {
    if (this.y - h < MARGIN) {
      this.page = this.doc.addPage(this.size);
      this.y = this.size[1] - MARGIN;
    }
  }

  private wrap(text: string, font: PDFFont, size: number): string[] {
    const lines: string[] = [];
    for (const para of winAnsi(font, text).split(/\r?\n/)) {
      let line = "";
      for (const word of para.split(" ")) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) <= this.width || !line) line = next;
        else {
          lines.push(line);
          line = word;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  text(
    text: string,
    opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; gap?: number } = {},
  ) {
    const size = opts.size ?? 11;
    const font = opts.bold ? this.bold : this.font;
    for (const line of this.wrap(text, font, size)) {
      this.room(size * 1.4);
      this.page.drawText(line, {
        x: MARGIN,
        y: this.y - size,
        size,
        font,
        color: opts.color ?? INK,
      });
      this.y -= size * 1.4;
    }
    this.y -= opts.gap ?? 4;
  }

  heading(text: string) {
    this.y -= 8;
    this.room(30);
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: MARGIN + this.width, y: this.y },
      thickness: 0.5,
      color: LINE,
    });
    this.y -= 10;
    this.text(text, { size: 13, bold: true, color: SLATE });
  }
}

export async function weeklyPdf(input: {
  table: WeeklyTableView;
  clientName: string;
  locale: Locale;
  paper: "letter" | "a4";
}): Promise<Uint8Array> {
  const { table, locale } = input;
  const w = WEEKLY_WORDS[locale];
  const doc = await PDFDocument.create();
  doc.setTitle(`${w.title}: ${input.clientName}, ${table.weekStart}`);
  doc.setProducer("Mezonas");
  doc.setCreator("Mezonas");
  // Fixed dates keep the bytes the same for the same row.
  const at = new Date(table.sentAt ?? table.updatedAt);
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const out = new Writer(
    doc,
    input.paper === "letter" ? PageSizes.Letter : PageSizes.A4,
    font,
    bold,
  );
  const num = new Intl.NumberFormat(locale);
  const week = new Intl.DateTimeFormat(locale, { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(`${table.weekStart}T00:00:00Z`),
  );
  const s = table.stats;

  out.text(input.clientName, { size: 10, color: MUTED, gap: 2 });
  out.text(w.title, { size: 20, bold: true, gap: 2 });
  out.text(w.weekOf(week), { size: 12, color: MUTED, gap: 8 });

  out.text(
    `${w.runsDone}: ${num.format(s.runs.done)} (${w.versusLastWeek(s.runs.change, num.format(Math.abs(s.runs.change)))})`,
  );
  out.text(
    `${w.changes}: ${num.format(s.changes.automatic + s.changes.signed)} (${num.format(s.changes.automatic)} ${w.automatic}, ${num.format(s.changes.signed)} ${w.signed})`,
  );
  out.text(`${w.signatures}: ${num.format(s.signatures.given)}`);
  out.text(`${w.documents}: ${num.format(s.documents.read)}`);

  if (s.agents.length > 0) {
    out.heading(w.agents);
    for (const a of s.agents) {
      out.text(`${a.name}: ${num.format(a.runsDone)} ${w.runsDone.toLowerCase()}`);
      for (const k of a.kpis)
        out.text(`  ${k.label}: ${k.value}${k.unit ? ` ${k.unit}` : ""}`, { color: MUTED });
    }
  }
  if (table.note) {
    out.heading(w.note(table.noteBy?.name ?? null));
    out.text(table.note);
  }
  if (table.decisions.length > 0) {
    out.heading(w.decisions);
    for (const d of table.decisions) {
      out.text(d.title, { bold: true, gap: 2 });
      if (d.body) out.text(d.body);
      if (d.options.length > 0)
        out.text(`${w.options}: ${d.options.join(" / ")}`, { color: MUTED });
      if (d.reply) out.text(w.replied, { color: MUTED });
    }
  }
  if (table.nextWeek) {
    out.heading(w.nextWeek);
    out.text(table.nextWeek);
  }
  if (table.setup.items.length > 0) {
    out.heading(w.setup);
    for (const i of table.setup.items) out.text(w.connect(i.tool, i.agentName));
  }
  return doc.save();
}
