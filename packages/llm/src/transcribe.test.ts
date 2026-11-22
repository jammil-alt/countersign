// Voice typing's client (docs/plan.md §1.109) against a fake OpenAI: what it sends, what it reads
// back (the words, and what the call used and cost: H5, §1.196), and that a refusal passes on only
// its status.
import { describe, expect, it } from "vitest";
import {
  createOpenAITranscriber,
  TRANSCRIBE_MODEL,
  TranscribeError,
  transcribeCostOf,
  transcribeUsageOf,
} from "./transcribe";

describe("createOpenAITranscriber", () => {
  it("sends the recording with the model and our words, and reads the text", async () => {
    const sent: { url: string; auth: string | null; form: FormData }[] = [];
    const t = createOpenAITranscriber({
      apiKey: "sk-test",
      fetch: async (input, init) => {
        sent.push({
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
          form: init?.body as FormData,
        });
        return new Response(
          JSON.stringify({
            text: "  Add a step that emails AP.  ",
            usage: {
              type: "tokens",
              input_tokens: 120,
              input_token_details: { text_tokens: 20, audio_tokens: 100 },
              output_tokens: 10,
              total_tokens: 130,
            },
          }),
          { status: 200 },
        );
      },
    });
    const out = await t.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      type: "audio/webm;codecs=opus",
      language: "en",
    });
    expect(out.text).toBe("Add a step that emails AP.");
    // What it used and cost, with the platform's model id: 100 x $3 + 20 x $1.25 + 10 x $5 per
    // million tokens.
    expect(out.model).toBe(`openai:${TRANSCRIBE_MODEL}`);
    expect(out.usage).toEqual({
      inputTokens: 120,
      audioTokens: 100,
      outputTokens: 10,
      seconds: null,
    });
    expect(out.costUsd).toBe("0.000375");
    expect(sent[0]?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(sent[0]?.auth).toBe("Bearer sk-test");
    const form = sent[0]?.form as FormData;
    expect(form.get("model")).toBe(TRANSCRIBE_MODEL);
    expect(form.get("language")).toBe("en");
    expect(String(form.get("prompt"))).toContain("QuickBooks");
    const file = form.get("file") as File;
    expect(file.name).toBe("dictation.webm");
    expect(file.type).toBe("audio/webm");
    expect(file.size).toBe(3);
  });

  it("passes on a refusal's status, never its body", async () => {
    const t = createOpenAITranscriber({
      apiKey: "sk-test",
      fetch: async () => new Response('{"error":"secret details"}', { status: 429 }),
    });
    const err = await t
      .transcribe({ audio: new Uint8Array([1]), type: "audio/mp4" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(TranscribeError);
    expect(err.status).toBe(429);
    expect(err.message).not.toContain("secret");
  });

  it("gives no cost when the answer says nothing of what it used", async () => {
    const t = createOpenAITranscriber({
      apiKey: "sk-test",
      fetch: async () => new Response(JSON.stringify({ text: "Hi" }), { status: 200 }),
    });
    const out = await t.transcribe({ audio: new Uint8Array([1]), type: "audio/ogg" });
    expect([out.text, out.usage, out.costUsd]).toEqual(["Hi", null, null]);
  });
});

describe("transcription cost", () => {
  it("prices tokens in decimal, input with no split as audio", () => {
    const usage = transcribeUsageOf({ type: "tokens", input_tokens: 1_000_000, output_tokens: 0 });
    expect(usage).toEqual({
      inputTokens: 1_000_000,
      audioTokens: 1_000_000,
      outputTokens: 0,
      seconds: null,
    });
    expect(transcribeCostOf(TRANSCRIBE_MODEL, usage as never)).toBe("3.000000");
    // A tenth of a cent's tenth stays exact: no float rounding.
    const tiny = transcribeUsageOf({
      input_tokens: 3,
      input_token_details: { audio_tokens: 1 },
      output_tokens: 1,
    });
    expect(transcribeCostOf(TRANSCRIBE_MODEL, tiny as never)).toBe("0.000011");
  });

  it("prices an answer counted in seconds by the minute", () => {
    const usage = transcribeUsageOf({ type: "duration", seconds: 30 });
    expect(usage?.seconds).toBe(30);
    expect(transcribeCostOf(TRANSCRIBE_MODEL, usage as never)).toBe("0.001500");
  });

  it("gives no price for a model it doesn't know, and no usage for an empty block", () => {
    expect(
      transcribeCostOf("whisper-9", {
        inputTokens: 1,
        audioTokens: 1,
        outputTokens: 1,
        seconds: null,
      }),
    ).toBeNull();
    expect(transcribeUsageOf({})).toBeNull();
    expect(transcribeUsageOf(null)).toBeNull();
  });
});
