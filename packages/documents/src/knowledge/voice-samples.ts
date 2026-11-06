// Voice samples (ARCHITECTURE v0.12 §6.4, docs/plan.md §1.42): examples of how one of the client's
// people writes, kept as knowledge entries of kind `voice_sample` whose versions carry
// `meta {personUserId, channel}`. Added by pasting (the client admin or the operator) or by
// forwarding to the client's address with the `+voice` tag; read by agents only through
// `knowledge.voice_samples`, as data (invariant 9). Never indexed for `knowledge.search`. Every
// read and write is inside the one client's transaction (invariant 1).

import {
  readVoiceSampleMeta,
  VOICE_SAMPLE_KIND,
  type VoiceSampleChannel,
  type VoiceSampleMeta,
  voiceSampleText,
} from "@countersign/core";
import { appUser, knowledgeEntry, knowledgeEntryVersion, membership, type Tx } from "@countersign/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  archiveKnowledgeEntry,
  createKnowledgeEntry,
  editKnowledgeEntry,
  entriesQuery,
  entryViews,
  getKnowledgeEntry,
  type KnowledgeAuthor,
  type KnowledgeEntryView,
  KnowledgeError,
} from "./entries";

/** At most this many active samples per person; adding one more archives the oldest (§1.42). */
export const VOICE_SAMPLES_PER_PERSON = 50;

const PERSON_ROLES = ["client_admin", "client_user"] as const;

export interface VoicePerson {
  id: string;
  name: string | null;
  email: string;
}

/** The client's own people (client admins and users), by id or email. */
async function people(
  tx: Tx,
  tenantId: string,
  where: { ids?: string[]; email?: string; role?: (typeof PERSON_ROLES)[number] } = {},
) {
  return tx
    .select({
      id: appUser.id,
      name: appUser.name,
      email: appUser.email,
      role: membership.role,
      since: membership.createdAt,
    })
    .from(membership)
    .innerJoin(appUser, eq(appUser.id, membership.userId))
    .where(
      and(
        eq(membership.tenantId, tenantId),
        inArray(membership.role, where.role ? [where.role] : [...PERSON_ROLES]),
        where.ids ? inArray(membership.userId, where.ids) : undefined,
        where.email ? eq(appUser.email, where.email.trim().toLowerCase()) : undefined,
      ),
    )
    .orderBy(asc(membership.createdAt), asc(appUser.id));
}

/**
 * Whose voice a sample is: the person named, who must be one of the client's own users; else the
 * client's first client admin (§1.42: "default the client admin").
 */
// DECISION: with several client admins, the default is the one who joined first (a stable choice
// the operator can see and override by naming the person).
export async function voicePerson(
  tx: Tx,
  tenantId: string,
  personUserId: string | null | undefined,
): Promise<VoicePerson> {
  if (personUserId) {
    const [p] = await people(tx, tenantId, { ids: [personUserId] });
    if (!p) throw new KnowledgeError("not_a_person", "that person is not one of this client's users");
    return { id: p.id, name: p.name, email: p.email };
  }
  const [admin] = await people(tx, tenantId, { role: "client_admin" });
  if (!admin) throw new KnowledgeError("no_person", "this client has no client admin yet");
  return { id: admin.id, name: admin.name, email: admin.email };
}

/** The client's own user with this email address, if any. */
export async function voicePersonByEmail(
  tx: Tx,
  tenantId: string,
  email: string,
): Promise<VoicePerson | null> {
  const [p] = await people(tx, tenantId, { email });
  return p ? { id: p.id, name: p.name, email: p.email } : null;
}

/** Archives a person's oldest active samples beyond the limit. */
async function capPerson(tx: Tx, tenantId: string, personUserId: string, author: KnowledgeAuthor) {
  const rows = await entriesQuery(
    tx,
    tenantId,
    eq(knowledgeEntry.kind, VOICE_SAMPLE_KIND),
    eq(knowledgeEntry.status, "active"),
    sql`${knowledgeEntryVersion.meta}->>'personUserId' = ${personUserId}`,
  ).orderBy(desc(knowledgeEntry.createdAt), desc(knowledgeEntry.id));
  for (const old of rows.slice(VOICE_SAMPLES_PER_PERSON)) {
    await archiveKnowledgeEntry(tx, tenantId, old.id, { baseVersion: old.version, author });
  }
}

/**
 * Adds a sample: the text cleaned (quoted history cut, cards redacted, 4,000 characters), whose
 * voice it is checked, and the person's oldest beyond 50 archived.
 */
export async function addVoiceSample(
  tx: Tx,
  tenantId: string,
  input: {
    title: string;
    text: string;
    personUserId?: string | null;
    channel: VoiceSampleChannel;
    author: KnowledgeAuthor;
  },
): Promise<KnowledgeEntryView> {
  const person = await voicePerson(tx, tenantId, input.personUserId);
  const meta: VoiceSampleMeta = { personUserId: person.id, channel: input.channel };
  const body = voiceSampleText(input.text) || "(empty)";
  const entry = await createKnowledgeEntry(tx, tenantId, {
    kind: VOICE_SAMPLE_KIND,
    title: input.title.trim().slice(0, 200) || "Voice sample",
    body,
    meta,
    author: input.author,
  });
  await capPerson(tx, tenantId, person.id, input.author);
  return entry;
}

/** Edits a sample: the same cleaning and person check as adding one. */
export async function editVoiceSample(
  tx: Tx,
  tenantId: string,
  entryId: string,
  input: {
    title: string;
    text: string;
    personUserId?: string | null;
    channel?: VoiceSampleChannel;
    baseVersion: number;
    author: KnowledgeAuthor;
  },
): Promise<KnowledgeEntryView> {
  const current = await getKnowledgeEntry(tx, tenantId, entryId);
  if (current?.kind !== VOICE_SAMPLE_KIND) {
    throw new KnowledgeError("not_found", "voice sample not found");
  }
  const was = readVoiceSampleMeta(current.meta);
  const person = await voicePerson(tx, tenantId, input.personUserId ?? was?.personUserId);
  const meta: VoiceSampleMeta = {
    personUserId: person.id,
    channel: input.channel ?? was?.channel ?? "email",
  };
  const saved = await editKnowledgeEntry(tx, tenantId, entryId, {
    title: input.title.trim().slice(0, 200) || current.title,
    body: voiceSampleText(input.text) || "(empty)",
    meta,
    baseVersion: input.baseVersion,
    author: input.author,
  });
  await capPerson(tx, tenantId, person.id, input.author);
  return saved;
}

/** One sample as `knowledge.voice_samples` returns it: data about style, with its record ids. */
export interface VoiceSampleView {
  id: string;
  versionId: string;
  title: string;
  text: string;
  channel: VoiceSampleChannel;
  person: { id: string; name: string | null };
  createdAt: Date;
}

/**
 * The client's active samples, newest first: one person's when named, one channel's when named.
 * When a channel has none for the person, their samples on other channels are returned and
 * `channelMatched` is false (a person's email still shows how they write a text).
 */
// DECISION: falling back to other channels beats returning nothing: the skill is told which
// channel each sample is from and keeps to the channel's length.
export async function listVoiceSamples(
  tx: Tx,
  tenantId: string,
  input: { personUserId?: string | undefined; channel?: VoiceSampleChannel | undefined; limit: number },
): Promise<{ samples: VoiceSampleView[]; channelMatched: boolean }> {
  const read = async (channel: VoiceSampleChannel | undefined) => {
    const rows = await entriesQuery(
      tx,
      tenantId,
      eq(knowledgeEntry.kind, VOICE_SAMPLE_KIND),
      eq(knowledgeEntry.status, "active"),
      input.personUserId
        ? sql`${knowledgeEntryVersion.meta}->>'personUserId' = ${input.personUserId}`
        : undefined,
      channel ? sql`${knowledgeEntryVersion.meta}->>'channel' = ${channel}` : undefined,
    )
      .orderBy(desc(knowledgeEntry.createdAt), desc(knowledgeEntry.id))
      .limit(input.limit);
    return entryViews(rows);
  };
  let rows = await read(input.channel);
  let channelMatched = true;
  if (rows.length === 0 && input.channel) {
    rows = await read(undefined);
    channelMatched = rows.length === 0;
  }
  const metas = rows.map((r) => readVoiceSampleMeta(r.meta));
  const ids = [...new Set(metas.flatMap((m) => (m ? [m.personUserId] : [])))];
  const names = new Map(
    ids.length ? (await people(tx, tenantId, { ids })).map((p) => [p.id, p.name ?? p.email]) : [],
  );
  const samples: VoiceSampleView[] = [];
  rows.forEach((r, i) => {
    const m = metas[i];
    if (!m) return;
    samples.push({
      id: r.id,
      versionId: r.versionId,
      title: r.title,
      text: r.body,
      channel: m.channel,
      person: { id: m.personUserId, name: names.get(m.personUserId) ?? null },
      createdAt: r.createdAt,
    });
  });
  return { samples, channelMatched };
}
