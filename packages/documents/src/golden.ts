// The golden invoices' tolerance (fixtures/invoices, docs/plan.md M2): header exact; each line's qty
// and prices within $0.01; descriptions fuzzy >= 0.9. Pure, so another package's golden test (the
// skill model's Read document, then Check totals) judges a reading by the same rule.

import { dec, type InvoiceExtraction } from "@countersign/core";

/** Levenshtein similarity, 1 = identical (case and spacing ignored). */
export function similarity(a: string, b: string): number {
  const x = a.toLowerCase().replace(/\s+/g, " ").trim();
  const y = b.toLowerCase().replace(/\s+/g, " ").trim();
  if (x === y) return 1;
  const prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let diag = prev[0] as number;
    prev[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const up = prev[j] as number;
      prev[j] = Math.min(
        up + 1,
        (prev[j - 1] as number) + 1,
        diag + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
      diag = up;
    }
  }
  return 1 - (prev[y.length] as number) / Math.max(x.length, y.length);
}

const close = (a: string, b: string) => dec(a).minus(dec(b)).abs().lessThanOrEqualTo("0.01");

/** Every way `actual` misses `expected` under the golden tolerance; empty when it passes. */
export function goldenProblems(actual: InvoiceExtraction, expected: InvoiceExtraction): string[] {
  const p: string[] = [];
  const h = actual.header;
  const e = expected.header;
  for (const k of [
    "vendorName",
    "invoiceNumber",
    "invoiceDate",
    "dueDate",
    "poNumber",
    "currency",
  ] as const) {
    if (h[k] !== e[k]) p.push(`header.${k}: ${String(h[k])} ≠ ${String(e[k])}`);
  }
  for (const k of ["subtotal", "freight", "tax", "total"] as const) {
    if (!dec(actual[k]).equals(dec(expected[k]))) p.push(`${k}: ${actual[k]} ≠ ${expected[k]}`);
  }
  const sur = (x: InvoiceExtraction) =>
    x.surcharges.reduce((s, c) => s.plus(dec(c.amount)), dec("0")).toFixed(2);
  if (sur(actual) !== sur(expected)) p.push(`surcharges: ${sur(actual)} ≠ ${sur(expected)}`);
  if (actual.lines.length !== expected.lines.length) {
    p.push(`lines: ${actual.lines.length} ≠ ${expected.lines.length}`);
    return p;
  }
  expected.lines.forEach((el, i) => {
    const al = actual.lines[i];
    if (!al) return;
    for (const k of ["qty", "unitPrice", "extPrice"] as const) {
      if (!close(al[k], el[k])) p.push(`line ${i + 1} ${k}: ${al[k]} ≠ ${el[k]}`);
    }
    const s = similarity(al.description, el.description);
    if (s < 0.9) p.push(`line ${i + 1} description ${s.toFixed(2)}: "${al.description}"`);
  });
  return p;
}
