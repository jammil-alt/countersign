// The golden invoices (fixtures/invoices) and the tolerance they are judged by (docs/plan.md M2):
// the tolerance is in ./golden.ts.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export { goldenProblems, similarity } from "./golden";

export const INVOICE_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../fixtures/invoices",
);

export const GOLDEN_INVOICES = [
  { stem: "northline-20418", file: "northline-20418.pdf", mimeType: "application/pdf" },
  { stem: "cedar-ridge-7731", file: "cedar-ridge-7731.png", mimeType: "image/png" },
  { stem: "keystone-55102", file: "keystone-55102.pdf", mimeType: "application/pdf" },
] as const;

export const invoicePath = (name: string) => resolve(INVOICE_DIR, name);
