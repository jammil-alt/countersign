// Voice typing (docs/plan.md §1.109): a person's recording, written out by OpenAI and handed back
// as text for their message box. Back office and portal alike: the client's compliance mode is
// checked first (a client in HIPAA mode is refused until OpenAI's BAA is recorded), the recording
// is read with its type and size checked, and neither it nor its words are stored or logged; only
// each call's usage and cost are (H5, §1.196). A slow route: the call to OpenAI runs outside any
// transaction.

import {
  clientLanguage,
  complianceOf,
  parseAcceptLanguage,
  parseCoveredProcessors,
  processingRefusal,
  resolveLocale,
  routes,
  userLanguage,
  VOICE_FEATURE,
  VOICE_MAX_BYTES,
  VOICE_TYPES,
} from "@countersign/core";
import { type Tx, tenant } from "@countersign/db";
import { TranscribeError, type Transcriber } from "@countersign/llm";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import { clientTranscriber } from "../compliance/models";
import {
  type AppContext,
  type AppEnv,
  ensureClient,
  HttpError,
  mountLong,
  type Services,
} from "../http";
import { claimMetered } from "../metered";
import { recordOperatorTranscription, recordTranscriptionUsage } from "../voice-usage";

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

/**
 * HIPAA mode (§1.35): what a person in this client says goes to OpenAI only under its BAA. Returns
 * the client's settings, for the speaker's language.
 */
async function refuseUncovered(
  tx: Tx,
  services: Services,
  clientId: string,
): Promise<Record<string, unknown>> {
  const [t] = await tx
    .select({ settings: tenant.settings })
    .from(tenant)
    .where(eq(tenant.id, clientId));
  const settings = (t?.settings ?? {}) as Record<string, unknown>;
  const refusal = processingRefusal(
    complianceOf(settings),
    parseCoveredProcessors(services.env.BAA_PROCESSORS),
    VOICE_FEATURE.processors,
    VOICE_FEATURE.what,
  );
  if (refusal) throw new HttpError(409, "hipaa", refusal);
  return settings;
}

function transcriberOf(services: Services, clientId: string | null): Transcriber {
  // Held to the client's HIPAA mode here too, beside the route's own check (called outside any
  // transaction).
  const t = clientTranscriber(services, { clients: [clientId], read: services.db });
  if (!t) throw new HttpError(503, "voice_off", "voice typing isn't set up here");
  return t;
}

async function writeOut(
  t: Transcriber,
  recording: { audio: Uint8Array; type: string },
  language?: string,
) {
  try {
    return await t.transcribe({ ...recording, language });
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
    const t = transcriberOf(ctx.services, clientId);
    const recording = await readRecording(ctx.c);
    const transcription = await writeOut(t, recording);
    // H5 (§1.196). DECISION: the back office's dictation is the operator's cost, never written
    // as a client's usage: the client didn't ask, as for the back office's questions
    // (../voice-usage.ts, ../runs-ask/usage.ts). §1.210: recorded as ours, on the client named.
    await ctx.inTx((scoped) =>
      recordOperatorTranscription(
        scoped.tx,
        {
          surface: "ops",
          tenantId: clientId,
          userId: ctx.session.user.id,
          transcription,
          recording: { type: recording.type, bytes: recording.audio.length },
        },
        "back office dictation",
      ),
    );
    return { text: transcription.text };
  });

  mountLong(app, routes.portalTranscribe, async (ctx) => {
    const clientId = ctx.tenantIds[0];
    if (!clientId) throw new HttpError(403, "forbidden", "no client");
    const settings = await ctx.inTx((scoped) => refuseUncovered(scoped.tx, ctx.services, clientId));
    // The language the person reads in (theirs, else the client's, else the browser's) helps
    // the model hear it right. DECISION: the back office leaves it to the model to detect.
    const locale = resolveLocale({
      user: userLanguage(settings, ctx.session.user.id),
      client: clientLanguage(settings),
      browser: parseAcceptLanguage(ctx.c.req.header("accept-language")),
    });
    const t = transcriberOf(ctx.services, clientId);
    const recording = await readRecording(ctx.c);
    // Audit 5.9: each person's recordings are limited per minute and per day (../metered.ts).
    // DECISION: claimed once the recording is known to be one we would send (the client covered,
    // voice typing set up, the recording's type and size right) and just before it goes to
    // OpenAI, so only a recording that is sent uses the allowance.
    await ctx.inTx((scoped) =>
      claimMetered(scoped.tx, ctx.c, {
        kind: "transcribe",
        tenantId: clientId,
        session: ctx.session,
        role: ctx.role,
      }),
    );
    const language = locale.slice(0, 2);
    const transcription = await writeOut(t, recording, language);
    // H5 (§1.196): each call is the client's usage under its account agent, with its model and
    // cost, attributed to the person (../voice-usage.ts). Written after the call, in its own short
    // transaction, as a question's cost is.
    await ctx.inTx((scoped) =>
      recordTranscriptionUsage(scoped.tx, {
        surface: "portal",
        tenantId: clientId,
        userId: ctx.session.user.id,
        transcription,
        recording: { type: recording.type, bytes: recording.audio.length },
        language,
      }),
    );
    return { text: transcription.text };
  });
}
