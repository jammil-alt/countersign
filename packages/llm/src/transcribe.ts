// Voice typing (docs/plan.md §1.109): a recording written out as text by OpenAI's speech-to-text.
// Plain fetch, no SDK, Worker-safe. The audio is passed through and never kept; the caller checks
// the client's compliance mode (HIPAA) before it calls.
//
// DECISION (the owner, 2026-11-15: "Ok to use open ai for voice"): `gpt-4o-mini-transcribe` on
// Mezonas' OpenAI key; the model, its endpoint and its price are unchecked (../NOTES.md).

export const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
const TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";

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
  transcribe(request: TranscribeRequest, options?: { signal?: AbortSignal }): Promise<string>;
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

/** OpenAI's speech-to-text over `fetch`. */
export function createOpenAITranscriber(options: {
  apiKey: string;
  fetch?: typeof fetch;
  model?: string;
}): Transcriber {
  const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return {
    async transcribe(request, call) {
      const type = request.type.split(";")[0]?.trim().toLowerCase() ?? "";
      const form = new FormData();
      form.append("model", options.model ?? TRANSCRIBE_MODEL);
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
      const body = (await res.json().catch(() => null)) as { text?: unknown } | null;
      if (typeof body?.text !== "string") {
        throw new TranscribeError("OpenAI's answer had no text", res.status);
      }
      return body.text.trim();
    },
  };
}
