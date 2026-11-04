// Writes HAND-WRITTEN model answers for the golden invoices into fixtures/llm/, in the recorded
// format, from each invoice's `*.expected.json`. The request (and so the hash) is built by the
// same `extractionCall` the documents capability uses, so replay finds them.
//
// They stand in until the answers are recorded from the live model:
//   LLM_MODE=record ANTHROPIC_API_KEY=… pnpm --filter @countersign/documents test golden
// (which overwrites these files with real answers). Run this script only to rebuild the
// hand-written ones, e.g. after changing the extraction prompt:
//   pnpm --filter @countersign/documents exec tsx scripts/write-invoice-fixtures.ts

import { readFileSync } from "node:fs";
import { createLlmClient, fakeMessage, withRecording } from "@countersign/llm";
import { fileFixtureStore } from "@countersign/llm/node";
import { extractionCall } from "../src/extract";
import { GOLDEN_INVOICES, invoicePath } from "../src/golden.test-helper";

const store = fileFixtureStore();
for (const inv of GOLDEN_INVOICES) {
  const bytes = new Uint8Array(readFileSync(invoicePath(inv.file)));
  const expected = JSON.parse(readFileSync(invoicePath(`${inv.stem}.expected.json`), "utf8"));
  const pages = expected.header.pageCount as number;
  const transport = withRecording(
    {
      async create(request) {
        const msg = fakeMessage(
          request.model,
          [
            {
              type: "tool_use",
              id: `toolu_handwritten_${inv.stem}`,
              name: "record_invoice",
              input: expected,
              caller: { type: "direct" },
            } as never,
          ],
          "tool_use",
          { input: 2400 * pages + 1200, output: 90 * expected.lines.length + 400 },
        );
        return { ...msg, id: `msg_handwritten_${inv.stem}` };
      },
    },
    {
      mode: "record",
      store: {
        read: store.read,
        // Marked so nobody mistakes them for recorded answers.
        write: (call) => store.write({ ...call, handWritten: true } as typeof call),
      },
    },
  );
  const llm = createLlmClient({ transport });
  await llm.callTool(extractionCall(inv.mimeType, bytes));
  console.log(`${inv.stem}: written`);
}
