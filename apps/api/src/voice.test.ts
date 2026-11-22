// Voice typing through the API (docs/plan.md §1.109) with a fake speech-to-text: the back office
// and the portal get their words back; a recording of the wrong type or none is refused; a client
// in HIPAA mode is refused until OpenAI's BAA is recorded, for its own people and for an operator
// dictating about it; an operator can't name a client it doesn't serve; OpenAI failing is said
// plainly; nothing of the recording is stored, and each call's usage and cost is (H5, §1.196).
import { DEV_USER_HEADER } from "@countersign/auth";
import { ACCOUNT_AGENT_SLUG } from "@countersign/core";
import {
  agent,
  agentVersion,
  auditEvent,
  modelCall,
  run,
  stepRun,
  tenant,
  usageDaily,
} from "@countersign/db";
import { TranscribeError, type Transcriber, transcribeModelId } from "@countersign/llm";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import {
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { METERED_LIMITS } from "./metered";
import { VOICE_RUN_WORKFLOW } from "./voice-usage";

// Live dictation (2026-11-21) sends a segment every five seconds or more: 12 a minute at most.
const LIMIT = METERED_LIMITS.transcribe;

const heard: { bytes: number; type: string; language?: string | undefined }[] = [];
let failNext = false;
const transcriber: Transcriber = {
  async transcribe(request) {
    if (failNext) {
      failNext = false;
      throw new TranscribeError("OpenAI answered 500", 500);
    }
    heard.push({ bytes: request.audio.length, type: request.type, language: request.language });
    return {
      text: "Add a step that emails AP.",
      model: transcribeModelId(),
      usage: { inputTokens: 120, audioTokens: 100, outputTokens: 10, seconds: null },
      costUsd: "0.000375",
      durationMs: 40,
    };
  },
};

const h = await createApiHarness({ transcriber });
afterAll(() => h?.close());

describe.skipIf(!h)("voice typing", () => {
  const H = h as NonNullable<typeof h>;
  const AUDIO = new Uint8Array([26, 69, 223, 163, 1, 2, 3, 4]);
  const post = async (
    email: string,
    path: string,
    body: Uint8Array,
    type = "audio/webm",
    headers: Record<string, string> = {},
  ) => {
    const res = await H.app.request(
      path,
      {
        method: "POST",
        headers: { [DEV_USER_HEADER]: email, "content-type": type, ...headers },
        body,
      },
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
    // The back office leaves the language to the model.
    expect(heard.at(-1)).toEqual({ bytes: AUDIO.length, type: "audio/webm", language: undefined });
  });

  it("writes out what a client's person dictated, in the portal", async () => {
    const res = await post(admin("b"), "/api/transcribe", AUDIO, "audio/mp4", {
      "accept-language": "pt-BR,pt;q=0.9",
    });
    expect(res.json.text).toBe("Add a step that emails AP.");
    // The language the person reads in, as the model takes it.
    expect(heard.at(-1)?.language).toBe("pt");
  });

  it("records each portal dictation as the client's usage, under its account agent", async () => {
    // H5 (§1.196). Client B's account agent (Sloan).
    const [sloan] = await H.t.db
      .insert(agent)
      .values({ tenantId: H.B.tenantId, kind: "client", slug: ACCOUNT_AGENT_SLUG, name: "Sloan" })
      .returning();
    if (!sloan) throw new Error("no agent");
    const [version] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: H.B.tenantId,
        agentId: sloan.id,
        version: 1,
        bundle: testBundle("Sloan"),
        bundleHash: "hash-voice-sloan",
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!version) throw new Error("no version");
    await H.t.db.update(agent).set({ liveVersionId: version.id }).where(eq(agent.id, sloan.id));
    const [person] = await H.t.db.execute<{ id: string }>(
      sql`select id from app_user where email = ${admin("b")}`,
    );

    const res = await post(admin("b"), "/api/transcribe", AUDIO, "audio/webm");
    expect(res.status).toBe(200);

    const runs = await H.t.db
      .select()
      .from(run)
      .where(and(eq(run.tenantId, H.B.tenantId), eq(run.workflowSlug, VOICE_RUN_WORKFLOW)));
    expect(runs).toHaveLength(1);
    const r = runs[0] as (typeof runs)[number];
    expect(r).toMatchObject({
      agentId: sloan.id,
      agentVersionId: version.id,
      mode: "test",
      status: "succeeded",
      costUsd: "0.0004",
      trigger: { type: "dictation", surface: "portal", dictatedBy: person?.id },
    });
    const [step] = await H.t.db.select().from(stepRun).where(eq(stepRun.runId, r.id));
    expect(step).toMatchObject({ nodeType: "transcription", tokensIn: 120, tokensOut: 10 });
    // The recording's type and size, never its words.
    expect(step?.input).toEqual({ type: "audio/webm", bytes: AUDIO.length, language: "en" });
    expect(JSON.stringify(step?.output)).not.toContain("emails AP");
    const [call] = await H.t.db.select().from(modelCall).where(eq(modelCall.runId, r.id));
    expect(call).toMatchObject({
      tenantId: H.B.tenantId,
      provider: "openai",
      model: "openai:gpt-4o-mini-transcribe",
      action: "tool_call",
      tokensIn: 120,
      tokensOut: 10,
      // numeric(14,4), rounded up: a call never shows as free.
      costUsd: "0.0004",
      durationMs: 40,
    });
    // Rolled up into the day's usage, as decimals.
    const [day] = await H.t.db
      .select()
      .from(usageDaily)
      .where(and(eq(usageDaily.tenantId, H.B.tenantId), eq(usageDaily.agentId, sloan.id)));
    expect(day).toMatchObject({ runs: 1, tokensIn: 120, tokensOut: 10, costUsd: "0.0004" });

    // The back office's dictation is the operator's cost: logged, no run.
    const before = (await H.t.db.select({ id: run.id }).from(run)).length;
    const ops = await post(OPERATOR, `/api/ops/transcribe?client=${H.B.tenantId}`, AUDIO);
    expect(ops.status).toBe(200);
    expect((await H.t.db.select({ id: run.id }).from(run)).length).toBe(before);
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

  it("counts only recordings it sends: a refused one uses none of the allowance", async () => {
    for (let i = 0; i < 10; i++) {
      const bad = await post(admin("c"), "/api/transcribe", AUDIO, "image/jpeg");
      expect(bad.json.error?.code).toBe("not_audio");
    }
    const empty = await post(admin("c"), "/api/transcribe", new Uint8Array(), "audio/ogg");
    expect(empty.json.error?.code).toBe("empty");
    const ok = await post(admin("c"), "/api/transcribe", AUDIO);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
  });

  it("limits each person's recordings in the portal: 30 a minute, sent at once or not", async () => {
    // Room for a minute of live dictation (12 segments) and more.
    expect(LIMIT.perMinute).toBe(30);
    const before = heard.length;
    const sent = await Promise.all(
      Array.from({ length: LIMIT.perMinute + 2 }, () => post(user("b"), "/api/transcribe", AUDIO)),
    );
    expect(sent.map((r) => r.status).sort()).toEqual([
      ...Array(LIMIT.perMinute).fill(200),
      429,
      429,
    ]);
    expect(sent.find((r) => r.status === 429)?.json.error?.code).toBe("rate_limited");
    // Only the ones allowed reached OpenAI.
    expect(heard.length - before).toBe(LIMIT.perMinute);
  });

  it("limits each person's recordings in the portal to 1,500 a day", async () => {
    expect(LIMIT.perDay).toBe(1500);
    const [person] = await H.t.db.execute<{ id: string }>(
      sql`select id from app_user where email = ${admin("b")}`,
    );
    // Earlier today: the rest of the day's allowance, two hours ago, beside the one written out
    // above.
    await H.t.db.insert(auditEvent).values(
      Array.from({ length: LIMIT.perDay - 1 }, () => ({
        tenantId: H.B.tenantId,
        actorKind: "user" as const,
        actorUserId: person?.id ?? null,
        action: "metered transcribe",
        outcome: "ok" as const,
        target: {},
        createdAt: new Date(Date.now() - 2 * 3_600_000),
      })),
    );
    const before = heard.length;
    const res = await post(admin("b"), "/api/transcribe", AUDIO);
    expect([res.status, res.json.error?.code]).toEqual([429, "daily_limit"]);
    expect(heard.length).toBe(before);
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
