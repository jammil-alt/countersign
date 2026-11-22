// Voice typing (docs/plan.md §1.109): a recording written out as text by OpenAI's speech-to-text.
// Plain fetch, no SDK, Worker-safe. The audio is passed through and never kept; the caller checks
// the client's compliance mode (HIPAA) before it calls.
//
// DECISION (the owner, 2026-11-15: "Ok to use open ai for voice"): `gpt-4o-mini-transcribe` on
// Mezonas' OpenAI key; the model, its endpoint and its price are unchecked (../NOTES.md).

import { Decimal, MODEL_PREFIXES } from "@countersign/core";
import { COST_PLACES } from "./pricing";

export const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

/** The platform's id of a speech-to-text model (`openai:` and OpenAI's name), as usage keeps it. */
export function transcribeModelId(model: string = TRANSCRIBE_MODEL): string {
  return `${MODEL_PREFIXES.openai}${model}`;
}

/** USD, as decimal strings: per million tokens of each kind, and per minute of audio. */
export interface TranscribePrice {
  readonly audioInPerMtok: string;
  readonly textInPerMtok: string;
  readonly outputPerMtok: string;
  /** For an answer that counts seconds of audio rather than tokens. */
  readonly perMinute: string;
}

// H5 (docs/plan.md §1.196). DECISION: OpenAI's list prices for gpt-4o-mini-transcribe as we know
// them ($3 per million audio tokens in, $1.25 text in, $5 out; about $0.003 a minute), unverified
// like every price in ./pricing.ts (../NOTES.md). Kept apart from PRICES: those are the models a
// skill or a step may name, and this one is not.
export const TRANSCRIBE_PRICES: Readonly<Record<string, TranscribePrice>> = {
  [TRANSCRIBE_MODEL]: {
    audioInPerMtok: "3.00",
    textInPerMtok: "1.25",
    outputPerMtok: "5.00",
    perMinute: "0.003",
  },
};

/** What one call used, from OpenAI's `usage` block. */
export interface TranscribeUsage {
  /** Input tokens, audio and text (our list of words) together. */
  readonly inputTokens: number;
  /** The audio's part of `inputTokens`. */
  readonly audioTokens: number;
  readonly outputTokens: number;
  /** Seconds of audio, when the answer counts the call that way instead of in tokens. */
  readonly seconds: number | null;
}

/** One recording written out: the words, and what the call used and cost. */
export interface Transcription {
  readonly text: string;
  /** The platform's model id (`openai:gpt-4o-mini-transcribe`). */
  readonly model: string;
  /** Null when the answer said nothing of what it used. */
  readonly usage: TranscribeUsage | null;
  /** USD, `COST_PLACES` places; null when the model has no price or the answer no usage. */
  readonly costUsd: string | null;
  readonly durationMs: number;
}

/** Words a recording may hold that a general model spells wrong: ours and the tools clients use. */
const VOCABULARY =
  "Mezonas, Sloan, Reggie, Builder, QuickBooks, Gmail, Outlook, Google Drive, Twilio, WhatsApp, Desk, Worksheet, Receipts.";

export interface TranscribeRequest {
  readonly audio: Uint8Array;
  /** The recording's type, e.g. audio/webm. */
  readonly type: string;
  /** ISO 639-1, when the speaker's language is known; else the model detects it. */
  readonly language?: string | undefined;
}

export interface Transcriber {
  transcribe(
    request: TranscribeRequest,
    options?: { signal?: AbortSignal },
  ): Promise<Transcription>;
}

export class TranscribeError extends Error {
  override name = "TranscribeError";
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

const EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
};

const count = (n: unknown): number =>
  typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;

/** OpenAI's `usage` block: tokens (the gpt-4o models) or seconds (whisper); null when neither. */
export function transcribeUsageOf(usage: unknown): TranscribeUsage | null {
  if (!usage || typeof usage !== "object") return null;
  const u = usage as {
    type?: unknown;
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_token_details?: { audio_tokens?: unknown } | null;
    seconds?: unknown;
  };
  if (u.type === "duration") {
    if (typeof u.seconds !== "number" || !Number.isFinite(u.seconds)) return null;
    return { inputTokens: 0, audioTokens: 0, outputTokens: 0, seconds: Math.max(0, u.seconds) };
  }
  if (u.input_tokens === undefined && u.output_tokens === undefined) return null;
  const inputTokens = count(u.input_tokens);
  // With no split given, every input token is priced as audio, the dearer kind.
  const audio = u.input_token_details?.audio_tokens;
  return {
    inputTokens,
    audioTokens: audio === undefined ? inputTokens : Math.min(count(audio), inputTokens),
    outputTokens: count(u.output_tokens),
    seconds: null,
  };
}

/**
 * The cost of one transcription in USD, `COST_PLACES` places, in decimal arithmetic (invariant 6);
 * null when the model (OpenAI's name, no prefix) has no price.
 */
export function transcribeCostOf(
  model: string,
  usage: TranscribeUsage,
  prices: Readonly<Record<string, TranscribePrice>> = TRANSCRIBE_PRICES,
): string | null {
  const price = prices[model];
  if (!price) return null;
  if (usage.seconds !== null) {
    return new Decimal(String(usage.seconds))
      .div(60)
      .mul(price.perMinute)
      .toDecimalPlaces(COST_PLACES)
      .toFixed(COST_PLACES);
  }
  const tokens = (n: number) => new Decimal(String(n));
  return tokens(usage.audioTokens)
    .mul(price.audioInPerMtok)
    .add(tokens(usage.inputTokens - usage.audioTokens).mul(price.textInPerMtok))
    .add(tokens(usage.outputTokens).mul(price.outputPerMtok))
    .div(1_000_000)
    .toDecimalPlaces(COST_PLACES)
    .toFixed(COST_PLACES);
}

/** OpenAI's speech-to-text over `fetch`. */
export function createOpenAITranscriber(options: {
  apiKey: string;
  fetch?: typeof fetch;
  model?: string;
}): Transcriber {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const model = options.model ?? TRANSCRIBE_MODEL;
  return {
    async transcribe(request, call) {
      const started = Date.now();
      const type = request.type.split(";")[0]?.trim().toLowerCase() ?? "";
      const form = new FormData();
      form.append("model", model);
      form.append("response_format", "json");
      form.append("prompt", VOCABULARY);
      if (request.language) form.append("language", request.language);
      form.append(
        "file",
        new Blob([request.audio as Uint8Array<ArrayBuffer>], { type }),
        `dictation.${EXTENSIONS[type] ?? "webm"}`,
      );
      let res: Response;
      try {
        res = await doFetch(TRANSCRIBE_URL, {
          method: "POST",
          headers: { authorization: `Bearer ${options.apiKey}` },
          body: form,
          ...(call?.signal ? { signal: call.signal } : {}),
        });
      } catch (error) {
        throw new TranscribeError(
          `OpenAI couldn't be reached: ${error instanceof Error ? error.message : String(error)}`,
          null,
        );
      }
      if (!res.ok) {
        // The answer's body may echo what was sent; only its status is passed on.
        throw new TranscribeError(`OpenAI answered ${res.status}`, res.status);
      }
      const body = (await res.json().catch(() => null)) as {
        text?: unknown;
        usage?: unknown;
      } | null;
      if (typeof body?.text !== "string") {
        throw new TranscribeError("OpenAI's answer had no text", res.status);
      }
      const usage = transcribeUsageOf(body.usage);
      return {
        text: body.text.trim(),
        model: transcribeModelId(model),
        usage,
        costUsd: usage ? transcribeCostOf(model, usage) : null,
        durationMs: Date.now() - started,
      };
    },
  };
}
