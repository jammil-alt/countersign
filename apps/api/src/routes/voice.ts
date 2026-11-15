// Voice typing (docs/plan.md §1.109): a person's recording, written out by OpenAI and handed back
// as text for their message box. Back office and portal alike: the client's compliance mode is
// checked first (a client in HIPAA mode is refused until OpenAI's BAA is recorded), the recording
// is read with its type and size checked, and nothing is stored or logged. A slow route: the call
// to OpenAI runs outside any transaction.

import {
  complianceOf,
  parseCoveredProcessors,
  processingRefusal,
  routes,
  VOICE_FEATURE,
  VOICE_MAX_BYTES,
  VOICE_TYPES,
} from "@countersign/core";
import { type Tx, tenant } from "@countersign/db";
import { TranscribeError, type Transcriber } from "@countersign/llm";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
  type AppContext,
  type AppEnv,
  ensureClient,
  HttpError,
  mountLong,
  type Services,
  transcriberFor,
} from "../http";

/** The recording, refused unless a type a browser records and a size voice typing takes. */
async function readRecording(c: AppContext): Promise<{ audio: Uint8Array; type: string }> {
  const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (!(VOICE_TYPES as readonly string[]).includes(type)) {
    throw new HttpError(
      422,
      "not_audio",
      "send the recording as audio (webm, ogg, mp4, mp3 or wav)",
    );
  }
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > VOICE_MAX_BYTES) throw new HttpError(422, "too_long", "the recording is too long");
  const audio = new Uint8Array(await c.req.arrayBuffer());
  if (audio.length === 0) throw new HttpError(422, "empty", "the recording is empty");
  if (audio.length > VOICE_MAX_BYTES)
    throw new HttpError(422, "too_long", "the recording is too long");
  return { audio, type };
}

/** HIPAA mode (§1.35): what a person in this client says goes to OpenAI only under its BAA. */
async function refuseUncovered(tx: Tx, services: Services, clientId: string): Promise<void> {
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, clientId));
  const refusal = processingRefusal(
    complianceOf((t?.settings ?? {}) as Record<string, unknown>),
    parseCoveredProcessors(services.env.BAA_PROCESSORS),
    VOICE_FEATURE.processors,
    VOICE_FEATURE.what,
  );
  if (refusal) throw new HttpError(409, "hipaa", refusal);
}

function transcriberOf(services: Services): Transcriber {
  const t = transcriberFor(services.deps, services.env);
  if (!t) throw new HttpError(503, "voice_off", "voice typing isn't set up here");
  return t;
}

async function writeOut(t: Transcriber, recording: { audio: Uint8Array; type: string }) {
  try {
    return { text: await t.transcribe(recording) };
  } catch (error) {
    if (error instanceof TranscribeError) {
      throw new HttpError(502, "voice_failed", "we couldn't write that out: try again");
    }
    throw error;
  }
}

export function voiceRoutes(app: Hono<AppEnv>): void {
  mountLong(app, routes.opsTranscribe, async (ctx) => {
    const clientId = ctx.query.client ?? null;
    if (clientId) {
      ensureClient(ctx, clientId);
      await ctx.inTx((scoped) => refuseUncovered(scoped.tx, ctx.services, clientId));
    }
    const t = transcriberOf(ctx.services);
    return writeOut(t, await readRecording(ctx.c));
  });

  mountLong(app, routes.portalTranscribe, async (ctx) => {
    const clientId = ctx.tenantIds[0];
    if (!clientId) throw new HttpError(403, "forbidden", "no client");
    await ctx.inTx((scoped) => refuseUncovered(scoped.tx, ctx.services, clientId));
    const t = transcriberOf(ctx.services);
    return writeOut(t, await readRecording(ctx.c));
  });
}
