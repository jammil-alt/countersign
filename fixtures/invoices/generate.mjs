// Generates the synthetic millwork invoices and their expected extractions from one source, so the
// figures printed and the figures expected can't drift. Run from the repo root:
//   node fixtures/invoices/generate.mjs
// Needs Playwright's Chromium (pre-installed in cloud sessions; `npx playwright install chromium`
// elsewhere). The committed PDFs and PNG are the fixtures: regenerating changes their bytes (and
// so the recorded LLM fixtures' hashes), so only regenerate on purpose, then re-record.
//
// Amounts are computed in integer ten-thousandths, never JS floats.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// require, not import: a globally installed Playwright resolves through NODE_PATH, which ESM ignores.
const { chromium } = createRequire(import.meta.url)("playwright");

const here = dirname(fileURLToPath(import.meta.url));

const toUnits = (s) => {
  const [i, f = ""] = s.split(".");
  return BigInt(i) * 10000n + BigInt((f + "0000").slice(0, 4));
};
const round2 = (units) => ((units + 50n) / 100n) * 100n; // half up, positive amounts
const fmt = (units, places = 2) => {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const whole = u / 10000n;
  const frac = (u % 10000n).toString().padStart(4, "0").slice(0, places);
  return `${neg ? "-" : ""}${whole}${places ? `.${frac}` : ""}`;
};
const money = (units) => {
  const [whole, frac] = fmt(units).split(".");
  return `${whole.replace(/\B(?=(\d{3})+$)/g, ",")}.${frac}`;
};
const qtyText = (q) => (q.includes(".") ? q : q);

const INVOICES = [
  {
    file: "northline-20418",
    format: "pdf",
    vendor: {
      name: "Northline Panel Supply",
      address: "4410 Industrial Pkwy, Dayton, OH 45414",
      phone: "(937) 555-0142",
    },
    invoiceNumber: "20418",
    invoiceDate: "2026-10-28",
    dueDate: "2026-11-27",
    poNumber: "J-1182",
    billTo: ["Hollis Millwork Co.", "880 Commerce Dr", "Springfield, OH 45502"],
    terms: "Net 30",
    lines: [
      ["BB34-55", "Baltic Birch Plywood 3/4\" 5x5 BB/BB", "40", "SHT", "68.5000"],
      ["BB12-55", "Baltic Birch Plywood 1/2\" 5x5 BB/BB", "25", "SHT", "52.7500"],
      ["MPF34-48", "Maple Plywood 3/4\" 4x8 Prefinished UV 2S", "30", "SHT", "94.2000"],
      ["MDF34-49", "MDF 3/4\" 49x97 Industrial", "20", "SHT", "41.9000"],
      ["MEL34-WH", "Melamine Panel 3/4\" 4x8 White 2S", "36", "SHT", "48.3500"],
      ["HB14-48", "Hardboard 1/4\" 4x8 Tempered", "15", "SHT", "18.6000"],
    ],
    freight: "0",
    surcharges: [],
    taxRate: null,
    note: "Resale certificate on file. Thank you for your business.",
  },
  {
    file: "cedar-ridge-7731",
    format: "png",
    vendor: {
      name: "Cedar Ridge Hardwoods",
      address: "12 Mill Road, Lewisburg, PA 17837",
      phone: "(570) 555-0187",
    },
    invoiceNumber: "CR-7731",
    invoiceDate: "2026-10-30",
    dueDate: "2026-11-29",
    poNumber: "J-1185",
    billTo: ["Hollis Millwork Co.", "880 Commerce Dr", "Springfield, OH 45502"],
    terms: "Net 30",
    lines: [
      ["HM44-FAS", "4/4 Hard Maple FAS S2S 13/16\"", "220", "BF", "6.8500"],
      ["WO84-FAS", "8/4 White Oak Qtr Sawn FAS Rough", "140", "BF", "11.4000"],
      ["WN44-SEL", "4/4 Black Walnut Select & Better S2S", "90", "BF", "13.2500"],
      ["PO54-FAS", "5/4 Poplar FAS S2S 1-1/16\"", "160", "BF", "3.1500"],
      ["CH44-FAS", "4/4 Cherry FAS Rough", "75", "BF", "8.9000"],
    ],
    freight: "185.00",
    surcharges: [["Fuel surcharge 3.5%", null]],
    taxRate: null,
    note: "Lumber is sold by the board foot. Report shortages within 5 days.",
  },
  {
    file: "keystone-55102",
    format: "pdf",
    vendor: {
      name: "Keystone Hardware & Finishes",
      address: "300 Route 22 West, Easton, PA 18042",
      phone: "(610) 555-0119",
    },
    invoiceNumber: "55102",
    invoiceDate: "2026-11-02",
    dueDate: "2026-12-02",
    poNumber: "J-1190",
    billTo: ["Hollis Millwork Co.", "880 Commerce Dr", "Springfield, OH 45502"],
    terms: "Net 30",
    lines: [
      ["71B3550", "Blum Clip Top Blumotion 110 Hinge Full Overlay", "200", "EA", "6.4200"],
      ["173L6100", "Blum Clip Mounting Plate 0mm", "200", "EA", "1.3800"],
      ["563H5330B", "Blum Tandem 563H 21\" Full Ext Soft Close Slide", "48", "PR", "38.9500"],
      ["T51.1901R", "Blum Tandem Locking Device Right", "48", "EA", "2.1500"],
      ["T51.1901L", "Blum Tandem Locking Device Left", "48", "EA", "2.1500"],
      ["SQ8125", "#8 x 1-1/4\" Square Drive Pan Head Screw", "2000", "EA", "0.0425"],
      ["SQ858", "#8 x 5/8\" Square Drive Wafer Head Screw", "3000", "EA", "0.0310"],
      ["CF114", "Confirmat Screw 7x50mm Zinc", "1000", "EA", "0.0890"],
      ["PL128SS", "Bar Pull 128mm Brushed Stainless", "60", "EA", "4.7500"],
      ["PL160BK", "Bar Pull 160mm Matte Black", "40", "EA", "5.3000"],
      ["KN30SN", "Round Knob 30mm Satin Nickel", "24", "EA", "2.8800"],
      ["SP5MM", "Shelf Pin 5mm Nickel Spoon", "1000", "EA", "0.0600"],
      ["LEG4", "Adjustable Cabinet Leg 4\" w/ Clip", "64", "EA", "1.9500"],
      ["EB78MP", "Edgebanding Maple 7/8\" Pre-glued 250' Roll", "6", "RL", "21.4000"],
      ["EB1PVCW", "Edgebanding PVC White 15/16\" x 600'", "4", "RL", "38.7500"],
      ["TB3-GAL", "Titebond III Ultimate Wood Glue 1 gal", "6", "GAL", "39.9000"],
      ["PVAC-5G", "Cross-Link PVA Glue 5 gal", "1", "PL", "142.0000"],
      ["CAT-SAT5", "Pre-Catalyzed Lacquer Satin 5 gal", "3", "PL", "289.0000"],
      ["SLR-SAN5", "Vinyl Sanding Sealer 5 gal", "2", "PL", "198.5000"],
      ["LT-THN5", "Lacquer Thinner 5 gal", "2", "PL", "64.0000"],
      ["STN-ECG", "Wiping Stain Early American 1 gal", "4", "GAL", "46.2500"],
      ["STN-ESP", "Wiping Stain Espresso 1 gal", "2", "GAL", "46.2500"],
      ["SD150-5", "Sanding Disc 5\" 150 Grit Hook & Loop (box 100)", "8", "BX", "24.9000"],
      ["SD220-5", "Sanding Disc 5\" 220 Grit Hook & Loop (box 100)", "8", "BX", "24.9000"],
      ["SD320-5", "Sanding Disc 5\" 320 Grit Hook & Loop (box 100)", "4", "BX", "26.4000"],
      ["TACK-12", "Tack Cloth (pack 12)", "6", "PK", "9.6000"],
      ["MSK-2IN", "Masking Tape 2\" x 60yd", "24", "RL", "5.7500"],
      ["FLT-2020", "Spray Booth Filter 20x20", "40", "EA", "3.4500"],
      ["NTR-LG", "Nitrile Gloves Large (box 100)", "6", "BX", "14.9500"],
      ["DOW-8X30", "Fluted Dowel 8x30mm (bag 1000)", "2", "BG", "27.5000"],
      ["CAM-15", "Cam Lock 15mm Zinc w/ Bolt", "200", "EA", "0.3900"],
      ["LMP-PUCK", "LED Puck Light 2.5W Warm White", "12", "EA", "11.8000"],
    ],
    freight: "48.50",
    surcharges: [],
    taxRate: "0.0725",
    note: "Hazmat items shipped ground. Returns accepted within 30 days with receipt.",
  },
];

function compute(inv) {
  const lines = inv.lines.map(([sku, description, qty, uom, unitPrice], i) => {
    const ext = round2(toUnits(qty) * toUnits(unitPrice) / 10000n);
    return { lineNo: i + 1, sku, description, qty, uom, unitPrice, ext };
  });
  const subtotal = lines.reduce((s, l) => s + l.ext, 0n);
  const freight = toUnits(inv.freight);
  const surcharges = inv.surcharges.map(([label, amount]) => ({
    label,
    // A percentage surcharge is on the merchandise subtotal: 3.5% here.
    amount: amount ? toUnits(amount) : round2((subtotal * 35n) / 1000n),
  }));
  const tax = inv.taxRate ? round2((subtotal * toUnits(inv.taxRate)) / 10000n) : 0n;
  const total = subtotal + freight + surcharges.reduce((s, c) => s + c.amount, 0n) + tax;
  return { lines, subtotal, freight, surcharges, tax, total };
}

const PER_PAGE = 22;

function html(inv, c) {
  const pages = [];
  for (let i = 0; i < c.lines.length; i += PER_PAGE) pages.push(c.lines.slice(i, i + PER_PAGE));
  const pageCount = inv.format === "png" ? 1 : pages.length;
  const head = `
    <div class="top">
      <div><div class="vendor">${inv.vendor.name}</div><div>${inv.vendor.address}</div><div>${inv.vendor.phone}</div></div>
      <div class="meta"><div class="title">INVOICE</div>
        <table><tr><td>Invoice #</td><td>${inv.invoiceNumber}</td></tr>
        <tr><td>Invoice date</td><td>${us(inv.invoiceDate)}</td></tr>
        <tr><td>Due date</td><td>${us(inv.dueDate)}</td></tr>
        <tr><td>Customer PO</td><td>${inv.poNumber}</td></tr>
        <tr><td>Terms</td><td>${inv.terms}</td></tr></table></div>
    </div>
    <div class="bill"><b>Bill to</b><br>${inv.billTo.join("<br>")}</div>`;
  const row = (l) =>
    `<tr><td>${l.sku}</td><td>${esc(l.description)}</td><td class="n">${qtyText(l.qty)}</td><td>${l.uom}</td><td class="n">${fmt(toUnits(l.unitPrice), l.unitPrice.endsWith("00") ? 2 : 4)}</td><td class="n">${money(l.ext)}</td></tr>`;
  const table = (ls) =>
    `<table class="lines"><thead><tr><th>Item</th><th>Description</th><th class="n">Qty</th><th>U/M</th><th class="n">Unit price</th><th class="n">Amount</th></tr></thead><tbody>${ls.map(row).join("")}</tbody></table>`;
  const totals = `<table class="totals">
      <tr><td>Subtotal</td><td class="n">${money(c.subtotal)}</td></tr>
      <tr><td>Freight</td><td class="n">${money(c.freight)}</td></tr>
      ${c.surcharges.map((s) => `<tr><td>${s.label}</td><td class="n">${money(s.amount)}</td></tr>`).join("")}
      <tr><td>Sales tax${inv.taxRate ? ` (${fmt(toUnits(inv.taxRate) * 100n, 2)}%)` : ""}</td><td class="n">${money(c.tax)}</td></tr>
      <tr class="due"><td>Total due (USD)</td><td class="n">$${money(c.total)}</td></tr></table>
    <p class="note">${inv.note}</p>`;
  const body =
    inv.format === "png"
      ? `<section>${head}${table(c.lines)}${totals}</section>`
      : pages
          .map(
            (ls, i) =>
              `<section class="page">${i === 0 ? head : `<div class="cont">${inv.vendor.name} · Invoice ${inv.invoiceNumber} (continued)</div>`}${table(ls)}${i === pages.length - 1 ? totals : '<p class="more">Continued on next page</p>'}<div class="foot">Page ${i + 1} of ${pageCount}</div></section>`,
          )
          .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font:12px/1.35 Helvetica,Arial,sans-serif;color:#111;margin:0}
    section{padding:36px 40px;position:relative}
    .page{height:1000px;page-break-after:always;box-sizing:border-box}
    .page:last-child{page-break-after:auto}
    .top{display:flex;justify-content:space-between}.vendor{font-size:20px;font-weight:bold}
    .title{font-size:22px;font-weight:bold;letter-spacing:2px;text-align:right}
    .meta table td{padding:1px 6px}.bill{margin:18px 0}
    table.lines{width:100%;border-collapse:collapse;margin-top:8px}
    .lines th{border-bottom:1.5px solid #111;text-align:left;padding:4px}
    .lines td{border-bottom:1px solid #ccc;padding:4px}.n{text-align:right}
    .totals{margin-left:auto;margin-top:12px}.totals td{padding:2px 8px}
    .due td{font-weight:bold;border-top:1.5px solid #111}
    .note{margin-top:18px;color:#444}.foot{position:absolute;bottom:24px;right:40px;color:#555}
    .cont{font-weight:bold;margin-bottom:8px}.more{text-align:right;color:#555}
  </style></head><body>${body}</body></html>`;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const us = (d) => {
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
};

function expected(inv, c) {
  const pageCount = inv.format === "png" ? 1 : Math.ceil(c.lines.length / PER_PAGE);
  return {
    header: {
      vendorName: inv.vendor.name,
      vendorAddress: inv.vendor.address,
      invoiceNumber: inv.invoiceNumber,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate,
      poNumber: inv.poNumber,
      currency: "USD",
      pageCount,
      confidence: { vendorName: 0.99, invoiceNumber: 0.99, invoiceDate: 0.98, total: 0.99 },
    },
    lines: c.lines.map((l) => ({
      lineNo: l.lineNo,
      vendorSku: l.sku,
      description: l.description,
      qty: l.qty,
      uom: l.uom,
      unitPrice: fmt(toUnits(l.unitPrice), l.unitPrice.endsWith("00") ? 2 : 4),
      extPrice: fmt(l.ext),
      discount: null,
      page: inv.format === "png" ? 1 : Math.floor((l.lineNo - 1) / PER_PAGE) + 1,
    })),
    subtotal: fmt(c.subtotal),
    freight: fmt(c.freight),
    surcharges: c.surcharges.map((s) => ({ label: s.label, amount: fmt(s.amount) })),
    tax: fmt(c.tax),
    total: fmt(c.total),
    confidence: 0.97,
  };
}

const browser = await chromium.launch();
try {
  for (const inv of INVOICES) {
    const c = compute(inv);
    const page = await browser.newPage({ viewport: { width: 816, height: 1056 }, deviceScaleFactor: 1.5 });
    await page.setContent(html(inv, c));
    if (inv.format === "pdf") {
      await page.pdf({ path: join(here, `${inv.file}.pdf`), format: "Letter", printBackground: true });
    } else {
      await page.screenshot({ path: join(here, `${inv.file}.png`), fullPage: true });
    }
    await page.close();
    writeFileSync(join(here, `${inv.file}.expected.json`), `${JSON.stringify(expected(inv, c), null, 2)}\n`);
    console.log(inv.file, "total", fmt(c.total));
  }
} finally {
  await browser.close();
}
