import { z } from "zod";
import { ContactAutonomy } from "../directory/autonomy";
import { VoiceSampleChannel } from "../directory/voice-samples";
import { isUuid } from "../ids";
import { defineRoute } from "./contract";
import { Contact } from "./messaging";

// People (ARCHITECTURE v0.12 §1, §6.1; docs/plan.md §1.42): a person's autonomy per channel, whether
// agents may message them on their own, only with a person's sign, or not at all. The operator sets
// any level; the client admin sets `off` or `approval` and may only tighten (403 `loosening`).
// Every change is a `contact_change` row and, like every request, an audit row.

const Id = z.string().refine((v) => isUuid(v), "not an id");

/** The whole setting: channels left out are not set (they narrow nothing). */
export const ContactAutonomyBody = z.strictObject({ autonomy: ContactAutonomy });
export type ContactAutonomyBody = z.infer<typeof ContactAutonomyBody>;

const OneContact = z.object({ contact: Contact });

export const peopleRoutes = {
  opsContactAutonomy: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/contacts/:contactId/autonomy",
    auth: "session",
    roles: ["operator"],
    summary:
      "Set whether agents may email, text, message on WhatsApp or call this person on their own, with a sign, or not at all",
    params: z.object({ id: Id, contactId: Id }),
    body: ContactAutonomyBody,
    response: OneContact,
  }),
  portalContactAutonomy: defineRoute({
    method: "PUT",
    path: "/api/contacts/:id/autonomy",
    auth: "session",
    roles: ["client_admin"],
    summary:
      "Make agents ask for your sign before contacting this person on a channel, or stop them",
    params: z.object({ id: Id }),
    body: ContactAutonomyBody,
    response: OneContact,
  }),
} as const;

// ── Voice samples (ARCHITECTURE v0.12 §6.4, docs/plan.md §1.42) ─────────────────────────────────
// Pasted by the client admin or the operator (or forwarded to `<forwarding address>+voice`).
// Stored as knowledge entries of kind `voice_sample`; their versions are the knowledge base's
// (`…/knowledge/entries/:entryId/versions`). Agents read them only with `knowledge.voice_samples`.

export const VOICE_SAMPLE_TITLE_MAX = 200;
/** What a person may paste; the kept text is cut to VOICE_SAMPLE_MAX after cleaning. */
export const VOICE_SAMPLE_PASTE_MAX = 20_000;

export const VoiceSampleInput = z.strictObject({
  title: z.string().trim().min(1).max(VOICE_SAMPLE_TITLE_MAX),
  text: z.string().trim().min(1).max(VOICE_SAMPLE_PASTE_MAX),
  /** Whose voice: one of the client's users; left out, the client admin. */
  personUserId: Id.optional(),
  channel: VoiceSampleChannel,
});
export type VoiceSampleInput = z.infer<typeof VoiceSampleInput>;

export const VoiceSampleEdit = z.strictObject({
  title: z.string().trim().min(1).max(VOICE_SAMPLE_TITLE_MAX),
  text: z.string().trim().min(1).max(VOICE_SAMPLE_PASTE_MAX),
  personUserId: Id.optional(),
  channel: VoiceSampleChannel.optional(),
  baseVersion: z.number().int().min(1),
});
export type VoiceSampleEdit = z.infer<typeof VoiceSampleEdit>;

export const VoiceSample = z.object({
  id: z.string(),
  status: z.enum(["active", "archived"]),
  version: z.number().int(),
  title: z.string(),
  /** As kept: quoted history cut, card numbers redacted, at most 4,000 characters. */
  text: z.string(),
  channel: VoiceSampleChannel,
  person: z.object({ id: z.string(), name: z.string().nullable() }),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type VoiceSample = z.infer<typeof VoiceSample>;

const ShowSamples = z.object({ show: z.enum(["active", "all"]).default("active") });
const OneSample = z.object({ sample: VoiceSample });
const Archive = z.strictObject({ baseVersion: z.number().int().min(1) });

export const voiceSampleRoutes = {
  opsVoiceSamples: defineRoute({
    method: "GET",
    path: "/api/ops/clients/:id/knowledge/voice-samples",
    auth: "session",
    roles: ["operator"],
    summary: "A client's voice samples: how its people write, by person and channel",
    params: z.object({ id: Id }),
    query: ShowSamples,
    response: z.object({ samples: z.array(VoiceSample) }),
  }),
  opsVoiceSampleCreate: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/knowledge/voice-samples",
    auth: "session",
    roles: ["operator"],
    summary: "Add an example of how one of a client's people writes",
    params: z.object({ id: Id }),
    body: VoiceSampleInput,
    response: OneSample,
  }),
  opsVoiceSampleEdit: defineRoute({
    method: "PUT",
    path: "/api/ops/clients/:id/knowledge/voice-samples/:entryId",
    auth: "session",
    roles: ["operator"],
    summary: "Change a voice sample (restores an archived one); the previous text is kept",
    params: z.object({ id: Id, entryId: Id }),
    body: VoiceSampleEdit,
    response: OneSample,
  }),
  opsVoiceSampleArchive: defineRoute({
    method: "POST",
    path: "/api/ops/clients/:id/knowledge/voice-samples/:entryId/archive",
    auth: "session",
    roles: ["operator"],
    summary: "Archive a voice sample: agents stop reading it",
    params: z.object({ id: Id, entryId: Id }),
    body: Archive,
    response: OneSample,
  }),
  portalVoiceSamples: defineRoute({
    method: "GET",
    path: "/api/knowledge/voice-samples",
    auth: "session",
    roles: ["client_admin"],
    summary: "Examples of how your people write, which our agents follow for tone",
    query: ShowSamples,
    response: z.object({ samples: z.array(VoiceSample) }),
  }),
  portalVoiceSampleCreate: defineRoute({
    method: "POST",
    path: "/api/knowledge/voice-samples",
    auth: "session",
    roles: ["client_admin"],
    summary: "Add an example of how you or one of your people writes",
    body: VoiceSampleInput,
    response: OneSample,
  }),
  portalVoiceSampleEdit: defineRoute({
    method: "PUT",
    path: "/api/knowledge/voice-samples/:id",
    auth: "session",
    roles: ["client_admin"],
    summary: "Change a voice sample; the previous text is kept",
    params: z.object({ id: Id }),
    body: VoiceSampleEdit,
    response: OneSample,
  }),
  portalVoiceSampleArchive: defineRoute({
    method: "POST",
    path: "/api/knowledge/voice-samples/:id/archive",
    auth: "session",
    roles: ["client_admin"],
    summary: "Archive a voice sample: agents stop reading it",
    params: z.object({ id: Id }),
    body: Archive,
    response: OneSample,
  }),
} as const;
