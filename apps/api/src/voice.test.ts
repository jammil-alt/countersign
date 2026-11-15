// Voice typing through the API (docs/plan.md §1.109) with a fake speech-to-text: the back office
// and the portal get their words back; a recording of the wrong type or none is refused; a client
// in HIPAA mode is refused until OpenAI's BAA is recorded, for its own people and for an operator
// dictating about it; an operator can't name a client it doesn't serve; OpenAI failing is said
// plainly; nothing is stored.
import { DEV_USER_HEADER } from "@countersign/auth";
import { tenant } from "@countersign/db";
import { TranscribeError, type Transcriber } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness, OPERATOR, OTHER_OPERATOR } from "./api.test-helper";

const heard: { bytes: number; type: string }[] = [];
let failNext = false;
const transcriber: Transcriber = {
  async transcribe(request) {
    if (failNext) {
      failNext = false;
      throw new TranscribeError("OpenAI answered 500", 500);
    }
    heard.push({ bytes: request.audio.length, type: request.type });
    return "Add a step that emails AP.";
  },
};

const h = await createApiHarness({ transcriber });
afterAll(() => h?.close());

describe.skipIf(!h)("voice typing", () => {
  const H = h as NonNullable<typeof h>;
  const AUDIO = new Uint8Array([26, 69, 223, 163, 1, 2, 3, 4]);
  const post = async (email: string, path: string, body: Uint8Array, type = "audio/webm") => {
    const res = await H.app.request(
      path,
      { method: "POST", headers: { [DEV_USER_HEADER]: email, "content-type": type }, body },
      H.env,
    );
    return {
      status: res.status,
      json: (await res.json()) as { text?: string; error?: { code: string } },
    };
  };

  it("writes out what the operator dictated", async () => {
    const res = await post(OPERATOR, "/api/ops/transcribe", AUDIO, "audio/webm;codecs=opus");
    expect(res).toEqual({ status: 200, json: { text: "Add a step that emails AP." } });
    expect(heard.at(-1)).toEqual({ bytes: AUDIO.length, type: "audio/webm" });
  });

  it("writes out what a client's person dictated, in the portal", async () => {
    const res = await post(admin("b"), "/api/transcribe", AUDIO, "audio/mp4");
    expect(res.json.text).toBe("Add a step that emails AP.");
  });

  it("refuses anything but a recording, and an empty one", async () => {
    expect(
      (await post(OPERATOR, "/api/ops/transcribe", AUDIO, "image/jpeg")).json.error?.code,
    ).toBe("not_audio");
    expect(
      (await post(OPERATOR, "/api/ops/transcribe", new Uint8Array(), "audio/ogg")).json.error?.code,
    ).toBe("empty");
  });

  it("refuses a client in HIPAA mode until OpenAI's BAA is recorded", async () => {
    await H.t.db
      .update(tenant)
      .set({ settings: { compliance: { hipaa: true } } })
      .where(eq(tenant.id, H.A.tenantId));
    const before = heard.length;
    const portal = await post(admin("a"), "/api/transcribe", AUDIO);
    expect([portal.status, portal.json.error?.code]).toEqual([409, "hipaa"]);
    const ops = await post(OPERATOR, `/api/ops/transcribe?client=${H.A.tenantId}`, AUDIO);
    expect([ops.status, ops.json.error?.code]).toEqual([409, "hipaa"]);
    // Nothing reached OpenAI.
    expect(heard.length).toBe(before);
  });

  it("refuses a client the operator doesn't serve, and says when OpenAI fails", async () => {
    const other = await post(OTHER_OPERATOR, `/api/ops/transcribe?client=${H.A.tenantId}`, AUDIO);
    expect(other.status).toBe(403);
    failNext = true;
    const failed = await post(OPERATOR, "/api/ops/transcribe", AUDIO);
    expect([failed.status, failed.json.error?.code]).toEqual([502, "voice_failed"]);
  });

  it("is a person's only", async () => {
    const res = await H.app.request(
      "/api/ops/transcribe",
      { method: "POST", headers: { "content-type": "audio/webm" }, body: AUDIO },
      H.env,
    );
    expect(res.status).toBe(401);
  });
});
