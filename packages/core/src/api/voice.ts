// Voice typing (docs/plan.md §1.109): what a person dictates in a conversation, written out by
// OpenAI and handed back as text for their message box. The body is the recording's bytes, in one
// of the types a browser records; nothing is stored.

import { z } from "zod";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";

const Id = z.string().refine((v) => isUuid(v), "not an id");

/** At most this many bytes: about four minutes of the opus audio browsers record. */
export const VOICE_MAX_BYTES = 4_000_000;
/** The recorder stops itself after this long. */
export const VOICE_MAX_SECONDS = 120;
/** What browsers record: Chrome and Firefox webm or ogg (opus), Safari mp4. */
export const VOICE_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-m4a",
] as const;

const Written = z.object({ text: z.string() });

export const voiceRoutes = {
  opsTranscribe: defineRoute({
    method: "POST",
    path: "/api/ops/transcribe",
    auth: "session",
    roles: ["operator"],
    summary:
      "Write out what you dictated (body: the recording). With `client`, refused when that client is in HIPAA mode and OpenAI has no BAA",
    query: z.object({ client: Id.optional() }),
    response: Written,
  }),
  portalTranscribe: defineRoute({
    method: "POST",
    path: "/api/transcribe",
    auth: "session",
    roles: ["client_admin", "client_user"],
    summary:
      "Write out what you dictated (body: the recording); refused when your company is in HIPAA mode and OpenAI has no BAA",
    response: Written,
  }),
} as const;
