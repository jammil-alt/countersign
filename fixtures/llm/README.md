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

The four plain-words question answers (`apps/api/src/runs-ask/ask.test.ts`, v0.12 W2-F) are
hand-written too, for a fixed client and day. Rebuild them after changing the question prompt or
`RunFilter`, then delete the files whose hashes no longer appear:

```sh
WRITE_ASK_FIXTURES=1 pnpm --filter @countersign/api exec vitest run src/runs-ask/ask.test.ts
```

## The skill model's Read document (hand-written)

The three answers to the `docs.read-document` skill (an AI task skill that reads the attached
invoice, Skill model 2026-11-10) for the golden invoices are **written by hand** too, each the
invoice's `*.expected.json` as the skill's `finish` answer, marked `"handWritten": true`. The test
gives the documents fixed ids, since the request carries the input JSON. Rebuild them after
changing the skill's instructions or schema, or the task prompt, then delete the files whose
hashes no longer appear:

```sh
WRITE_SKILL_FIXTURES=1 COUNTERSIGN_REQUIRE_DB=1 \
  pnpm --filter @countersign/agents exec vitest run src/log/docs-split.test.ts
```

## xAI and Gemini (hand-written, in each provider's own format)

`providers/xai/*.json` and `providers/gemini/*.json` are answers as xAI's Responses API and the
Gemini API's generateContent send them (a plain answer, a tool call, the answer after its result,
and errors), **written by hand** from the official formats: there are no keys here. Each carries
`"handWritten": true`. `packages/llm/src/providers.fixtures.test.ts` puts them through the real
transports and replays the translated answers from six `<hash>.json` files here, also marked
`"handWritten": true`. Rebuild those after changing the test's requests or a translation, then
delete the files whose hashes no longer appear:

```sh
WRITE_PROVIDER_FIXTURES=1 pnpm --filter @countersign/llm exec vitest run src/providers.fixtures.test.ts
```

What is unchecked about each provider is in `packages/llm/NOTES.md`. Once a key exists, replace
the provider-format answers with real ones from a live call.
