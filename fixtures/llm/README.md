# Recorded model responses

One `<request hash>.json` per model call (`packages/llm/src/record.ts`). Tests replay them
(`LLM_MODE=replay`, the default) and fail loudly on a miss.

## Hand-written answers (re-record them)

The three golden invoice extractions (`fixtures/invoices/*`) were **written by hand**, not recorded:
this environment cannot reach the Anthropic API. Each carries `"handWritten": true`, and its answer
is the invoice's `*.expected.json`, so the golden test proves the pipeline (request, replay, schema,
validation, rows) but not the model's reading. They were made by
`packages/documents/scripts/write-invoice-fixtures.ts` from the same request builder the documents
capability uses.

Re-record them with a key, then delete the hand-written files whose hashes no longer appear:

```sh
LLM_MODE=record ANTHROPIC_API_KEY=… COUNTERSIGN_REQUIRE_DB=1 \
  pnpm --filter @countersign/documents exec vitest run src/documents.test.ts -t golden
```

A recorded answer that misses the tolerance (header exact; qty and prices within $0.01;
descriptions ≥ 0.9 similar) fails the golden test: that is the point of it.
