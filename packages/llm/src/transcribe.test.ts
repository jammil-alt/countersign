// Voice typing's client (docs/plan.md §1.109) against a fake OpenAI: what it sends, what it reads
// back, and that a refusal passes on only its status.
import { describe, expect, it } from "vitest";
import { createOpenAITranscriber, TRANSCRIBE_MODEL, TranscribeError } from "./transcribe";

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
        return new Response(JSON.stringify({ text: "  Add a step that emails AP.  " }), {
          status: 200,
        });
      },
    });
    const text = await t.transcribe({
      audio: new Uint8Array([1, 2, 3]),
      type: "audio/webm;codecs=opus",
      language: "en",
    });
    expect(text).toBe("Add a step that emails AP.");
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
});
