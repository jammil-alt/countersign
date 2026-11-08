// A purchase order as a PDF (docs/plan.md §1.67, `materials.po.document`): the client's name, the
// vendor, the lines of the chosen quote with their amounts and total (decimal, invariant 6), the
// needed-by date, delivery or pickup, and a reference. Rendered with pdf-lib (pure JavaScript, as
// the Weekly Table's PDF is) and stored as one of the client's documents, so a later step can
// attach it to an email or a QuickBooks purchase order. It writes nothing to a client's tool.

import type { ContentStore } from "@countersign/connectors";
import { dec, formatAmount, toNumeric } from "@countersign/core";
import { type Db, document, type Tx, tenant, vendor, withTenant } from "@countersign/db";
import { countPages } from "@countersign/documents";
import { and, eq } from "drizzle-orm";
import { PageSizes, PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import { quoteLines, quoteRow } from "./quotes";
import { type PurchasingContext, PurchasingError, requestLines, requestRow } from "./requests";

// The design system's ink, muted ink, slate and border (packages/design-system/tokens.css).
const INK = rgb(0x15 / 255, 0x1a / 255, 0x21 / 255);
const MUTED = rgb(0x53 / 255, 0x5b / 255, 0x65 / 255);
const SLATE = rgb(0x23 / 255, 0x41 / 255, 0x5e / 255);
const LINE = rgb(0xdc / 255, 0xdf / 255, 0xe2 / 255);
const MARGIN = 56;

export interface PoLine {
  lineNo: number;
  description: string;
  qty: string;
  unit: string | null;
  unitPrice: string;
  amount: string;
}

export interface PoContent {
  reference: string;
  clientName: string;
  vendorName: string;
  /** yyyy-mm-dd: the day the order is dated. */
  date: string;
  neededBy: string | null;
  fulfillment: "delivery" | "pickup" | null;
  deliverTo: string | null;
  currency: string;
  lines: PoLine[];
  total: string;
  notes: string | null;
}

/** Text Helvetica's WinAnsi can draw; anything else as `?`. */
function winAnsi(font: PDFFont, text: string): string {
  let out = "";
  for (const raw of text.normalize("NFC")) {
    const ch = raw === "\t" || raw === " " ? " " : raw;
    try {
      font.encodeText(ch);
      out += ch;
    } catch {
      out += "?";
    }
  }
  return out;
}

function moneyText(amount: string, currency: string): string {
  return currency === "USD" ? `$${formatAmount(amount)}` : `${currency} ${formatAmount(amount)}`;
}

/** A quantity without trailing zeros: `10.0000` → `10`, `2.5000` → `2.5`. */
function qtyText(qty: string): string {
  return dec(qty).toString();
}

/** Renders the order. The same content gives the same bytes (fixed dates and producer). */
export async function renderPurchaseOrder(po: PoContent): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Purchase order ${po.reference}`);
  doc.setProducer("Mezonas");
  doc.setCreator("Mezonas");
  const at = new Date(`${po.date}T12:00:00Z`);
  doc.setCreationDate(at);
  doc.setModificationDate(at);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const size = PageSizes.Letter;
  const width = size[0] - 2 * MARGIN;
  let page: PDFPage = doc.addPage(size);
  let y = size[1] - MARGIN;
  const room = (h: number) => {
    if (y - h < MARGIN) {
      page = doc.addPage(size);
      y = size[1] - MARGIN;
    }
  };
  const text = (
    s: string,
    opts: {
      x?: number;
      size?: number;
      bold?: boolean;
      color?: ReturnType<typeof rgb>;
      right?: number;
    } = {},
  ) => {
    const f = opts.bold ? bold : font;
    const sz = opts.size ?? 10;
    const t = winAnsi(f, s);
    const x =
      opts.right !== undefined ? opts.right - f.widthOfTextAtSize(t, sz) : (opts.x ?? MARGIN);
    page.drawText(t, { x, y: y - sz, size: sz, font: f, color: opts.color ?? INK });
  };
  const rule = () => {
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: MARGIN + width, y },
      thickness: 0.5,
      color: LINE,
    });
  };
  /** Wraps a description to its column. */
  const wrap = (s: string, max: number, sz: number): string[] => {
    const out: string[] = [];
    let line = "";
    for (const word of winAnsi(font, s).split(" ")) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, sz) <= max || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
    return out;
  };

  text(po.clientName, { size: 11, color: MUTED });
  y -= 16;
  text("Purchase order", { size: 20, bold: true });
  text(po.reference, { size: 12, bold: true, color: SLATE, right: MARGIN + width });
  y -= 30;
  const facts: [string, string][] = [
    ["Vendor", po.vendorName],
    ["Date", po.date],
    ...(po.neededBy ? ([["Needed by", po.neededBy]] as [string, string][]) : []),
    ...(po.fulfillment
      ? ([
          [
            po.fulfillment === "pickup" ? "Pickup" : "Deliver to",
            po.deliverTo ?? (po.fulfillment === "pickup" ? "We pick up" : "To be confirmed"),
          ],
        ] as [string, string][])
      : []),
  ];
  for (const [label, value] of facts) {
    room(16);
    text(label, { color: MUTED });
    text(value, { x: MARGIN + 90 });
    y -= 16;
  }
  y -= 10;

  // The lines: description, quantity, unit, unit price, amount.
  const cols = {
    qty: MARGIN + 300,
    unit: MARGIN + 340,
    price: MARGIN + 430,
    amount: MARGIN + width,
  };
  room(24);
  rule();
  y -= 6;
  text("Item", { bold: true, size: 9 });
  text("Qty", { bold: true, size: 9, right: cols.qty });
  text("Unit", { bold: true, size: 9, x: cols.unit });
  text("Unit price", { bold: true, size: 9, right: cols.price });
  text("Amount", { bold: true, size: 9, right: cols.amount });
  y -= 16;
  rule();
  y -= 6;
  for (const l of po.lines) {
    const wrapped = wrap(`${l.lineNo}. ${l.description}`, 280, 10);
    room(14 * wrapped.length + 4);
    text(wrapped[0] ?? "");
    text(qtyText(l.qty), { right: cols.qty });
    text(l.unit ?? "", { x: cols.unit });
    text(moneyText(l.unitPrice, po.currency), { right: cols.price });
    text(moneyText(l.amount, po.currency), { right: cols.amount });
    for (const more of wrapped.slice(1)) {
      y -= 14;
      text(more, { x: MARGIN + 12 });
    }
    y -= 18;
  }
  rule();
  y -= 8;
  room(20);
  text("Total", { bold: true, x: cols.unit });
  text(moneyText(po.total, po.currency), { bold: true, right: cols.amount });
  y -= 28;
  if (po.notes) {
    room(30);
    text("Notes", { bold: true, color: SLATE });
    y -= 16;
    for (const l of wrap(po.notes, width, 10)) {
      room(14);
      text(l);
      y -= 14;
    }
  }
  // Without object streams, so the page objects are plain and anyone can count them.
  return doc.save({ useObjectStreams: false });
}

/** The order's lines from the quote: what the vendor can supply, priced, as quoted. */
async function poContent(
  tx: Tx,
  ctx: PurchasingContext,
  input: {
    requestId: string;
    quoteRequestId: string;
    reference?: string | undefined;
    notes?: string | undefined;
  },
): Promise<{ content: PoContent; vendorId: string; quoteLineIds: string[] }> {
  const r = await requestRow(tx, ctx.tenantId, input.requestId);
  if (r.status === "cancelled" || r.status === "closed") {
    throw new PurchasingError("status", `the request is ${r.status}`);
  }
  const q = await quoteRow(tx, ctx.tenantId, input.quoteRequestId);
  if (q.purchaseRequestId !== r.id) {
    throw new PurchasingError("invalid", "the quote is for another request");
  }
  if (q.status !== "received") {
    throw new PurchasingError("status", `the quote is ${q.status}, not received`);
  }
  const [client] = await tx
    .select({ name: tenant.name })
    .from(tenant)
    .where(eq(tenant.id, ctx.tenantId))
    .limit(1);
  const [v] = await tx
    .select({ name: vendor.name })
    .from(vendor)
    .where(and(eq(vendor.tenantId, ctx.tenantId), eq(vendor.id, q.vendorId)))
    .limit(1);
  const asked = await requestLines(tx, ctx.tenantId, r.id);
  const quoted = await quoteLines(tx, ctx.tenantId, [q.id]);
  const lines: PoLine[] = [];
  const ids: string[] = [];
  let total = dec("0");
  for (const { row } of asked) {
    const ql = quoted.find((x) => x.purchaseRequestLineId === row.id);
    if (!ql?.available || ql.unitPrice === null) continue;
    const qty = ql.qty ?? row.qty;
    // P-9 (0036): a line nobody has said how many of is never ordered.
    if (qty === null) {
      throw new PurchasingError("invalid", `line ${row.lineNo} has no quantity yet`);
    }
    const amount = dec(ql.unitPrice).times(qty);
    total = total.plus(amount);
    ids.push(ql.id);
    lines.push({
      lineNo: lines.length + 1,
      // The client's words for what it buys, with the vendor's beside them when it gave its own.
      description:
        ql.description && ql.description.trim() !== row.description.trim()
          ? `${row.description} (${ql.description})`
          : row.description,
      qty: toNumeric(qty),
      unit: ql.unit,
      unitPrice: toNumeric(ql.unitPrice),
      amount: toNumeric(amount),
    });
  }
  if (lines.length === 0) {
    throw new PurchasingError("invalid", "the quote has no line the vendor can supply at a price");
  }
  // DECISION: the reference is the one given (e.g. the client's PO number), else PO- and the
  // request id's first eight characters; the order is dated the day the quote came in.
  const reference = input.reference ?? `PO-${r.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  return {
    vendorId: q.vendorId,
    quoteLineIds: ids,
    content: {
      reference,
      clientName: client?.name ?? "",
      vendorName: v?.name ?? "Vendor",
      date: (q.receivedAt ?? q.updatedAt).toISOString().slice(0, 10),
      neededBy: r.neededBy,
      fulfillment: r.fulfillment,
      deliverTo: r.deliverTo,
      currency: q.currency,
      lines,
      total: toNumeric(total),
      notes: input.notes ?? null,
    },
  };
}

export interface PoDocument {
  documentId: string;
  filename: string;
  reference: string;
  vendorId: string;
  vendorName: string;
  currency: string;
  total: string;
  lines: number;
  created: boolean;
  sources: string[];
}

/**
 * Renders the order and stores it as the client's document (source `generated`). The same order
 * twice is one document (one per client and sha256). No `document.received` event: the order is
 * ours, not something that came in to be read.
 */
export async function purchaseOrderDocument(
  db: Db,
  content: ContentStore | null,
  ctx: PurchasingContext,
  input: {
    requestId: string;
    quoteRequestId: string;
    reference?: string | undefined;
    notes?: string | undefined;
  },
): Promise<PoDocument> {
  if (!content) throw new PurchasingError("invalid", "document storage isn't available here");
  const made = await withTenant(db, ctx.tenantId, (tx) => poContent(tx, ctx, input));
  const bytes = await renderPurchaseOrder(made.content);
  const filename = `${made.content.reference.replace(/[^A-Za-z0-9._-]/g, "_")}.pdf`;
  const stored = await content.put({
    tenantId: ctx.tenantId,
    bytes,
    contentType: "application/pdf",
    metadata: { filename },
  });
  return withTenant(db, ctx.tenantId, async (tx) => {
    const [row] = await tx
      .insert(document)
      .values({
        tenantId: ctx.tenantId,
        source: "generated",
        connectionId: null,
        storageKey: stored.key,
        mimeType: "application/pdf",
        filename,
        sizeBytes: bytes.length,
        sha256: stored.sha256,
        pageCount: countPages(bytes, "application/pdf"),
        meta: {
          kind: "purchase_order",
          reference: made.content.reference,
          purchaseRequestId: input.requestId,
          quoteRequestId: input.quoteRequestId,
          agentVersionId: ctx.agentVersionId,
          runId: ctx.runId,
          ...(ctx.testRun ? { testRun: true } : {}),
        },
      })
      .onConflictDoNothing({ target: [document.tenantId, document.sha256] })
      .returning({ id: document.id });
    const id =
      row?.id ??
      (
        await tx
          .select({ id: document.id })
          .from(document)
          .where(and(eq(document.tenantId, ctx.tenantId), eq(document.sha256, stored.sha256)))
          .limit(1)
      )[0]?.id;
    if (!id) throw new Error("document vanished after a conflicting insert");
    return {
      documentId: id,
      filename,
      reference: made.content.reference,
      vendorId: made.vendorId,
      vendorName: made.content.vendorName,
      currency: made.content.currency,
      total: made.content.total,
      lines: made.content.lines.length,
      created: row !== undefined,
      sources: [id, input.requestId, input.quoteRequestId, ...made.quoteLineIds],
    };
  });
}
