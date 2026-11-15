// Voice typing's upload (docs/plan.md §1.109): the recording as the body, the client it's about on
// the back office's route, the server's refusal as an ApiError, and the portal's own words.
import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { transcribe, voiceFor } from "./voice";

const audio = new Blob([new Uint8Array([1, 2])], { type: "audio/webm" });

describe("transcribe", () => {
  it("posts the recording, naming the client in the back office", async () => {
    const calls: { url: string; type: string | null; body: unknown }[] = [];
    const text = await transcribe("ops", audio, "c-1", async (input, init) => {
      calls.push({
        url: String(input),
        type: new Headers(init?.headers).get("content-type"),
        body: init?.body,
      });
      return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
    });
    expect(text).toBe("hello");
    expect(calls).toEqual([
      { url: "/api/ops/transcribe?client=c-1", type: "audio/webm", body: audio },
    ]);
  });

  it("throws the server's refusal", async () => {
    const err = await transcribe(
      "portal",
      audio,
      null,
      async () =>
        new Response(JSON.stringify({ error: { code: "hipaa", message: "no BAA" } }), {
          status: 409,
        }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect([err.status, err.code, err.message]).toEqual([409, "hipaa", "no BAA"]);
  });

  it("gives the portal its own words for a failure", async () => {
    const voice = voiceFor("portal", null, { failed: "Das konnten wir nicht aufschreiben." });
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 502 });
    try {
      await expect(voice.transcribe(audio)).rejects.toThrow("Das konnten wir nicht aufschreiben.");
    } finally {
      globalThis.fetch = original;
    }
  });
});
