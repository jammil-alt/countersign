# Model providers: notes

Written 2026-11-10 (Models: xAI and Gemini) without network access to xAI's or Google's
documentation and without keys for either. The facts below are what we know of xAI's API and the
Gemini API; everything marked **UNCHECKED** must be checked on the providers' own pages (and with a
first live call on staging) before an agent is set to one of these models for a client. The tests
answer in these shapes (`fixtures/llm/providers/`, hand-written), so a wrong fact is fixed here, in
the transport and in those fixtures.

Every price in `src/pricing.ts` is unverified, Anthropic's and OpenAI's included
(`PRICES_CHECKED_ON = "unverified"`). The ids and prices below were given to the owner from
third-party sites, which disagree with each other.

## Model ids and prices

| Platform id | Provider's id | Price we use (USD per 1M tokens) | Status |
|---|---|---|---|
| `xai:grok-4.7` | `grok-4.7` | $2 in, $6 out, $0.50 cached in; prompts over 200K tokens at $4 / $12 / $1 | **UNCHECKED**: the id, every rate, and the long-prompt rates (we doubled every rate; xAI has priced long prompts that way before). Check https://docs.x.ai/docs/models |
| `google:gemini-3.1-pro` | `gemini-3.1-pro` | $2 in, $12 out, $0.20 cached in; prompts over 200K at $4 / $18 / $0.40 | **UNCHECKED**: the id (Google often serves new Pro models as `…-preview` first) and every rate. Check https://ai.google.dev/gemini-api/docs/models and /pricing |
| `google:gemini-3.5-flash-lite` | `gemini-3.5-flash-lite` | $0.30 in, $2.50 out, $0.03 cached in | **UNCHECKED**: the id and every rate. The rates look like an older Flash's, not a Flash-Lite's; check before relying on them |

Neither provider charges for writing its cache (both cache by themselves), so cache writes are
priced as fresh input; the transports report no cache writes. Google's hourly storage charge is
for caches made on purpose (`cachedContents`), which we never make. Thinking tokens are billed as
output by both (we count them in output).

A model with no price is refused for these providers (the client's `UnpricedModelError`, and
core's `definitionModelErrors` at validation), so a wrong id in `MODELS` fails loudly rather than
running at no cost.

## xAI (`src/xai.ts`)

Requests go to `POST https://api.x.ai/v1/responses` with `Authorization: Bearer $XAI_API_KEY`,
translated by the shared Responses translation in `src/openai.ts`.

| Fact | Status |
|---|---|
| xAI serves the OpenAI Responses API at `/v1/responses`, taking `input` items (`message`, `function_call`, `function_call_output`), function `tools`, `tool_choice`, `parallel_tool_calls`, `max_output_tokens`, `text.format` json_schema and `store` | Known; **UNCHECKED** that `strict` on a function tool and `parallel_tool_calls` are honoured rather than ignored |
| `instructions` is not supported; the system prompt goes first in `input` as `{type: "message", role: "system"}` | **UNCHECKED** whether newer xAI models now take `instructions` (it would not matter: the system message works either way) |
| Grok 4 models reject `reasoning.effort` (they always reason); we never send it | **UNCHECKED** for grok-4.7 |
| `store: false` keeps nothing at xAI; every request carries its whole transcript | **UNCHECKED** that `store: false` is accepted (xAI documents `store`, default true) |
| The answer: `status`, `incomplete_details.reason` (`max_output_tokens`, `content_filter`), `output` items (`message` with `output_text` or `refusal`, `function_call` with `call_id`, `reasoning`), `usage.input_tokens` (cached included), `usage.input_tokens_details.cached_tokens`, `usage.output_tokens` (reasoning included) | Known as OpenAI's shape; **UNCHECKED** that xAI fills `input_tokens_details.cached_tokens` the same way |
| Errors: HTTP status with `{"code": "<words>", "error": "<message>"}`; 429 when over a rate limit; 401/403 for a bad key; 503 when busy | **UNCHECKED** body shape (we also read OpenAI's `{error: {message, code}}`) |
| PDFs as `input_file` with `file_data` | **UNCHECKED**: xAI may not take inline PDFs. Images (`input_image` data URLs) are documented. Extraction runs on Anthropic, so no current path sends a PDF to xAI |

## Gemini (`src/gemini.ts`)

Requests go to `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
with `x-goog-api-key: $GEMINI_API_KEY`. We use the native API, not Google's OpenAI-compatible
endpoint (Chat Completions, which our translation does not speak, and which carries thought
signatures only in an extension field); see the DECISION in `src/gemini.ts`.

| Fact | Status |
|---|---|
| `systemInstruction`, `contents` (`user` / `model`), parts `text`, `inlineData`, `functionCall {id?, name, args}`, `functionResponse {id?, name, response}` | Known |
| A function response must name its function; an object `response` with `output` (or `error`) is what Google's examples send | Known |
| `tools[].functionDeclarations[].parametersJsonSchema` takes plain JSON Schema (additionalProperties, anyOf); `parameters` takes only the OpenAPI subset | Known for v1beta; **UNCHECKED** for the 3.x models named here |
| `toolConfig.functionCallingConfig.mode` `AUTO` / `ANY` / `NONE`, `allowedFunctionNames` with `ANY` | Known. No switch for parallel calls (we drop `disable_parallel_tool_use`) |
| `generationConfig.responseMimeType: "application/json"` with `responseJsonSchema` for structured output | Known; **UNCHECKED** together with function calling on these models |
| `generationConfig.thinkingConfig.thinkingLevel` `low` / `high` for Gemini 3 | Known for Gemini 3 Pro; **UNCHECKED** for 3.1 Pro and 3.5 Flash-Lite (Flash models may take `minimal` and `medium` too) |
| Thought signatures: Gemini 3 returns `thoughtSignature` on parts (the first function call of a turn, and sometimes text) and requires it back on function calls of the current turn, else 400 | Known. We keep each as an empty Anthropic thinking block (signature `gemini:<sig>`) before its block and send it back on that part |
| A function call Gemini did not make (one the platform wrote to start a loop: confer, converse, oversight) carries the documented placeholder `skip_thought_signature_validator` | **UNCHECKED**: the placeholder value and that it passes for every 3.x model |
| `functionCall.id`: Gemini may leave it out | Known. Without one we make `gemini_call_<responseId>_<n>` for the transcript and never send it back |
| `finishReason`: `STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `LANGUAGE`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `SPII`, `IMAGE_SAFETY`, `MALFORMED_FUNCTION_CALL`, `OTHER`; a blocked prompt has no candidate and `promptFeedback.blockReason` | Known. Safety-type stops and a blocked prompt are refusals; `MAX_TOKENS` is `max_tokens`; the rest end the turn |
| `usageMetadata`: `promptTokenCount` (cached included), `cachedContentTokenCount`, `candidatesTokenCount`, `thoughtsTokenCount` (billed as output), `toolUsePromptTokenCount` | Known |
| Errors: `{error: {code, message, status}}`; 429 `RESOURCE_EXHAUSTED`, 503 `UNAVAILABLE` ("The model is overloaded"), 400 `INVALID_ARGUMENT`, 403 `PERMISSION_DENIED`, 504 `DEADLINE_EXCEEDED` | Known |
| Nothing kept at Google: no `cachedContents`, no session; every request is the whole transcript | Known. **UNCHECKED**: whether the Gemini API's paid tier keeps prompts for abuse monitoring, and for how long (for the subprocessor list and HIPAA) |
| Images by URL | Not sent: only base64 images and PDFs (`inlineData`) |

## Before an agent runs on these for a client

1. Check every row marked **UNCHECKED** above, and the ids and prices, on the providers' pages.
2. Add the key on staging (docs/operations.md, "Model keys"), set a test agent to each model, and
   run one plain answer and one tool loop. Compare the run's model calls' cost with the provider's
   usage page.
3. Re-record the hand-written answers from the live API if their shape differs
   (`fixtures/llm/README.md`).
4. Name xAI and Google on the public subprocessor list (`apps/site`) before a client's data goes to
   them; a client in HIPAA mode is refused both until `xai` / `google` are in `BAA_PROCESSORS`.

## OpenAI embeddings (`src/embeddings.ts`, docs/plan.md §1.88)

Written 2026-11-11 without network access to OpenAI's documentation and without a key. The vendor
catalog embeds master items, vendor items and new lines with `openai:text-embedding-3-large` at
1,024 dimensions (the size of `catalog_item.embedding` and `vendor_item.embedding`). The tests
answer in OpenAI's shape (`fixtures/llm/providers/openai/`, hand-written) and the matching tests
replay hand-written vectors (`fixtures/llm`, marked `handWritten`).

| Fact | Status |
|---|---|
| `POST https://api.openai.com/v1/embeddings` with `Authorization: Bearer $OPENAI_API_KEY`, body `{model, input: string[], dimensions, encoding_format: "float"}` | Known; **UNCHECKED** with a live call |
| The model id `text-embedding-3-large` (platform id `openai:text-embedding-3-large`), and `-3-small` | **UNCHECKED**: check https://platform.openai.com/docs/models that both are still served |
| `dimensions` shortens a `-3` model's vector (3,072 for large) to the size asked; 1,024 is allowed | Known for the `-3` models; **UNCHECKED** that quality at 1,024 holds on our matching goldens |
| The answer: `data[]` with `index` and `embedding` (floats), `model`, `usage.prompt_tokens` | Known; we sort by `index` and refuse an answer whose count or size differs from the request |
| Price: $0.13 per 1M input tokens for `-3-large`, $0.02 for `-3-small`; no output tokens | **UNCHECKED**: check https://openai.com/api/pricing (`EMBEDDING_PRICES`) |
| At most 2,048 inputs and 8,192 tokens per input per call | Known; we send at most 100 short texts per call (`EMBED_BATCH_MAX`) |
| Zero data retention and a BAA are offered for the API (HIPAA clients) | **UNCHECKED** for embeddings specifically; until `openai` is in `BAA_PROCESSORS`, a HIPAA client's embeddings are refused like its OpenAI model calls |
