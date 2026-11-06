// v0.14 capture: fetching a message's attachments and filing them as documents (ARCHITECTURE §6.12,
// docs/plan.md §1.55). One job per message, one durable step per attachment, then one step that
// tells the conversation's agent (if it names one) and one that reads the new documents. Each
// attachment's outcome is a raw record `MessageMedia` (`<sid>:<index>`, a version per try) written
// in the same transaction as its document, so a retried webhook, step or "download now" never
// makes a second document (Respaldo's "claim once" pattern, no code shared).

import {
  ContentStore,
  type FetchLike,
  // v0.14 W4-A: Meta's two-step download for a `whatsapp_meta` connection's messages.
  fetchMetaMedia,
  fetchTwilioMedia,
  mediaSidOf,
  metaCredentialsOf,
  type ObjectStore,
  readTwilioConfig,
  TransientMediaError,
  TWILIO_CONNECTOR_ID,
  TWILIO_MESSAGE_ENTITY,
  twilioCredentialsOf,
  WHATSAPP_META_CONNECTOR_ID,
} from "@countersign/connectors";
import {
  acceptingTriggers,
  attachmentKind,
  bytesMatchType,
  type ConversationCapture,
  captureAllows,
  extensionFor,
  INBOUND_MESSAGE_EVENT,
  type InboundMessagePayload,
  MEDIA_MAX_TRIES,
  type MediaOutcome,
} from "@countersign/core";
import { agent, agentVersion, connection, type Db, rawRecord, withTenant } from "@countersign/db";
import { DocumentError, storeDocument } from "@countersign/documents";
import { collectEmitted, EmittedEvents, type EventTypeRegistry, emit } from "@countersign/senses";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Bindings } from "../env";
import { reportHandled } from "../observability/report";
import { dispatchAfterCommit } from "../runs/dispatch";
import type { RunInstances } from "../runs/instances";
import { connectionCredentials } from "../secrets";
import { senderFacts } from "../triggers/senders";
import {
  CAPTURE_NOTIFIED_ENTITY,
  getConversation,
  MESSAGE_MEDIA_ENTITY,
  mediaOutcomes,
  storedCaptureOf,
  storedMediaOf,
} from "./capture";

/** One message's capture job (the Workflow's params; plain JSON). */
export interface CaptureParams {
  tenantId: string;
  connectionId: string;
  rawRecordId: string;
  messageSid: string;
  /** The attachments to fetch, by index. */
  indexes: number[];
  /** Why: the webhook, the cron's restart, or a person's "download now". */
  reason: "inbound" | "restart" | "download_now";
  /** The conversation, for a message from before v0.14 whose record doesn't name it. */
  conversationId?: string;
}

export interface CaptureDeps {
  db: Db;
  env: Pick<Bindings, "ENCRYPTION_KEY" | "ENCRYPTION_KEY_PREVIOUS">;
  objects: ObjectStore;
  fetch: FetchLike;
  events: EventTypeRegistry;
  instances: RunInstances;
  /** Reads new PDFs and images in the background (routes/documents.ts), when a model is set. */
  read?: (tenantId: string, documentIds: string[]) => Promise<void>;
}

/** A durable step, as Cloudflare Workflows' `step.do` (or inline, for local runs and tests). */
export interface CaptureStepRunner {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
}

export const inlineCaptureSteps: CaptureStepRunner = { do: (_name, fn) => fn() };

type ItemResult = {
  index: number;
  status: MediaOutcome["status"];
  documentId: string | null;
  read: boolean;
};

/** The whole job: every attachment, then the agent, then the reading. */
export async function runCapture(
  deps: CaptureDeps,
  params: CaptureParams,
  steps: CaptureStepRunner,
): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (const index of params.indexes) {
    results.push(await steps.do(`media:${index}`, () => captureOne(deps, params, index)));
  }
  await steps.do("notify", () => notifyAgent(deps, params, results));
  const toRead = results.filter((r) => r.read && r.documentId).map((r) => r.documentId as string);
  if (toRead.length > 0 && deps.read) {
    await steps.do("read", async () => {
      await deps.read?.(params.tenantId, toRead);
      return true;
    });
  }
  return results;
}

/** Fetches and files one attachment, once. */
export async function captureOne(
  deps: CaptureDeps,
  params: CaptureParams,
  index: number,
): Promise<ItemResult> {
  const { tenantId } = params;
  const key = `${params.messageSid}:${index}`;
  // Read what is needed, and the credentials, in one short transaction.
  const prep = await withTenant(deps.db, tenantId, async (tx) => {
    const [raw] = await tx
      .select()
      .from(rawRecord)
      .where(
        and(
          eq(rawRecord.id, params.rawRecordId),
          eq(rawRecord.tenantId, tenantId),
          eq(rawRecord.connectionId, params.connectionId),
          eq(rawRecord.entityType, TWILIO_MESSAGE_ENTITY),
          eq(rawRecord.externalId, params.messageSid),
        ),
      );
    if (!raw) return null;
    const prior = (await mediaOutcomes(tx, tenantId, params.connectionId, [params.messageSid])).get(
      key,
    );
    const media = storedMediaOf(raw.payload, mediaSidOf).find((m) => m.index === index);
    const conversationId = storedCaptureOf(raw.payload)?.conversationId ?? params.conversationId;
    if (!media || !conversationId) return null;
    const conv = await getConversation(tx, tenantId, conversationId);
    // v0.14 W4-A: the message's connection, Twilio's or Meta's, with its own credentials.
    const [conn] = await tx
      .select()
      .from(connection)
      .where(and(eq(connection.id, params.connectionId), eq(connection.tenantId, tenantId)));
    const auth =
      conn?.connector === TWILIO_CONNECTOR_ID && readTwilioConfig(conn.config)
        ? twilioCredentialsOf(await (await connectionCredentials(tx, deps.env, conn)).get())
        : null;
    const meta =
      conn?.connector === WHATSAPP_META_CONNECTOR_ID && conn.status === "connected"
        ? metaCredentialsOf(await (await connectionCredentials(tx, deps.env, conn)).get())
        : null;
    return {
      prior,
      media,
      capture: conv.capture as ConversationCapture,
      conversationId: conv.id,
      contactId: conv.contactId,
      connector: conn?.connector ?? TWILIO_CONNECTOR_ID,
      auth,
      meta,
    };
  });
  if (!prep) return { index, status: "failed", documentId: null, read: false };
  const { prior, media, capture } = prep;
  // Filed or refused: final. Failed, or refused because the setting didn't take it then: tried
  // again only by "download now", up to the limit.
  if (prior && !(params.reason === "download_now" && retryable(prior.outcome))) {
    return {
      index,
      status: prior.outcome.status,
      documentId: prior.outcome.documentId,
      read: false,
    };
  }
  const tries = (prior?.tries ?? 0) + 1;
  if (tries > MEDIA_MAX_TRIES) {
    return { index, status: "failed", documentId: prior?.outcome.documentId ?? null, read: false };
  }

  // Null while the bytes are waiting to be filed (below, in the outcome's own transaction).
  let outcome: MediaOutcome | null;
  let bytes: Uint8Array | null = null;
  if (!captureAllows(capture, media.contentType)) {
    // The setting changed since the message came in (or never took this type).
    outcome = refused(
      media.contentType,
      capture.attachments === "off" ? "capture_off" : "type_not_allowed",
    );
  } else if (!prep.auth && !prep.meta) {
    outcome = failed(media.contentType, "unauthorized");
  } else {
    // v0.14 W4-A: Meta's two-step download, on the client's number, with its business token.
    const got = prep.meta
      ? await fetchMetaMedia(deps.fetch, {
          token: prep.meta.accessToken,
          phoneNumberId: prep.meta.phoneNumberId,
          mediaId: media.mediaSid,
          contentType: media.contentType,
          maxBytes: capture.maxBytes,
        })
      : await fetchTwilioMedia(deps.fetch, prep.auth as NonNullable<typeof prep.auth>, {
          messageSid: params.messageSid,
          mediaSid: media.mediaSid,
          contentType: media.contentType,
          maxBytes: capture.maxBytes,
        });
    if (!got.ok) {
      outcome =
        got.status === "refused"
          ? refused(media.contentType, got.reason)
          : failed(media.contentType, got.reason);
    } else if (!bytesMatchType(got.bytes, media.contentType)) {
      outcome = refused(media.contentType, "type_mismatch");
    } else {
      bytes = got.bytes;
      outcome = null;
    }
  }

  const collect = new EmittedEvents();
  const content = new ContentStore(deps.objects);
  const written = await withTenant(deps.db, tenantId, async (tx) => {
    collectEmitted(tx, collect);
    let documentId: string | null = null;
    let read = false;
    if (bytes) {
      try {
        const stored = await storeDocument(tx, content, {
          tenantId,
          source: "message",
          connectionId: params.connectionId,
          bytes,
          // Ids only, never the sender's filename (v0.14 W4-A: a wamid's `+`, `/` and `=` as `-`).
          filename: `whatsapp-${fileSafeId(params.messageSid)}-${index}.${extensionFor(media.contentType)}`,
          mimeType: media.contentType,
          meta: {
            channel: "whatsapp",
            conversationId: prep.conversationId,
            rawRecordId: params.rawRecordId,
            messageSid: params.messageSid,
            mediaIndex: index,
            contactId: prep.contactId,
          },
          allowType: (t) => attachmentKind(t) !== null,
        });
        documentId = stored.document.id;
        read = stored.created && attachmentKind(media.contentType) === "document";
        outcome = {
          status: "filed",
          reason: null,
          documentId,
          contentType: media.contentType,
          sizeBytes: bytes.length,
          sha256: stored.document.sha256,
        };
      } catch (error) {
        if (!(error instanceof DocumentError)) throw error;
        outcome = refused(
          media.contentType,
          error.code === "too_large" ? "too_large" : "type_not_allowed",
        );
      }
    }
    const [row] = await tx
      .insert(rawRecord)
      .values({
        tenantId,
        connectionId: params.connectionId,
        // v0.14 W4-A: the message's connector (Twilio or Meta).
        connector: prep.connector,
        entityType: MESSAGE_MEDIA_ENTITY,
        externalId: key,
        externalVersion: String(tries),
        payload: outcome ?? failed(media.contentType, "gone"),
      })
      .onConflictDoNothing()
      .returning({ id: rawRecord.id });
    // Another try got here first: roll back this one (its document included) and use theirs.
    if (!row) throw new AlreadyCaptured();
    return { documentId, read };
  }).catch(async (error: unknown) => {
    if (!(error instanceof AlreadyCaptured)) throw error;
    const theirs = await withTenant(deps.db, tenantId, (tx) =>
      mediaOutcomes(tx, tenantId, params.connectionId, [params.messageSid]),
    );
    const o = theirs.get(key)?.outcome;
    return { documentId: o?.documentId ?? null, read: false, theirs: o?.status ?? "failed" };
  });
  await dispatchAfterCommit({ db: deps.db, instances: deps.instances }, tenantId, collect);
  const status =
    "theirs" in written
      ? (written.theirs as MediaOutcome["status"])
      : (outcome?.status ?? "failed");
  return { index, status, documentId: written.documentId, read: written.read };
}

/** An outcome "download now" may try again: a failure, or a refusal by the setting of the time. */
export function retryable(outcome: MediaOutcome): boolean {
  return (
    outcome.status === "failed" ||
    (outcome.status === "refused" &&
      (outcome.reason === "capture_off" || outcome.reason === "type_not_allowed"))
  );
}

class AlreadyCaptured extends Error {
  override name = "AlreadyCaptured";
}

/** v0.14 W4-A: a message id as a file name part: letters, digits, `.`, `_`; anything else `-`. */
export function fileSafeId(sid: string): string {
  let out = "";
  for (const ch of sid.slice(0, 200)) {
    const ok =
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "." ||
      ch === "_";
    out += ok ? ch : "-";
  }
  return out;
}

const refused = (contentType: string, reason: MediaOutcome["reason"]): MediaOutcome => ({
  status: "refused",
  reason,
  documentId: null,
  contentType,
  sizeBytes: null,
  sha256: null,
});
const failed = (contentType: string, reason: MediaOutcome["reason"]): MediaOutcome => ({
  status: "failed",
  reason,
  documentId: null,
  contentType,
  sizeBytes: null,
  sha256: null,
});

/**
 * Starts the conversation's agent once per message, with the filed documents, through its own
 * WhatsApp message trigger and People filter (`inbound.message`). No reply, whatever happens.
 */
async function notifyAgent(
  deps: CaptureDeps,
  params: CaptureParams,
  results: readonly ItemResult[],
): Promise<boolean> {
  const { tenantId } = params;
  const collect = new EmittedEvents();
  const sent = await withTenant(deps.db, tenantId, async (tx) => {
    collectEmitted(tx, collect);
    // v0.14 W4-A: with its connector (Twilio or Meta), for the marker below.
    const [raw] = await tx
      .select({ payload: rawRecord.payload, connector: rawRecord.connector })
      .from(rawRecord)
      .where(and(eq(rawRecord.id, params.rawRecordId), eq(rawRecord.tenantId, tenantId)));
    const conversationId =
      (raw ? storedCaptureOf(raw.payload)?.conversationId : undefined) ?? params.conversationId;
    if (!conversationId) return false;
    const conv = await getConversation(tx, tenantId, conversationId);
    const agentId = (conv.capture as ConversationCapture).agentId;
    if (!agentId || !conv.contactId) return false;
    const [a] = await tx
      .select({ id: agent.id, bundle: agentVersion.bundle })
      .from(agent)
      .innerJoin(
        agentVersion,
        and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, tenantId)),
      )
      .where(
        and(
          eq(agent.id, agentId),
          eq(agent.tenantId, tenantId),
          eq(agent.kind, "client"),
          eq(agent.runStatus, "active"),
          eq(agent.testCopy, false),
          isNotNull(agent.liveVersionId),
        ),
      );
    if (!a) return false;
    const facts = await senderFacts(tx, tenantId, { contactId: conv.contactId, userId: null });
    // Passive: a sender the agent's People filter doesn't take starts nothing and gets no reply.
    if (acceptingTriggers(a.bundle, "whatsapp", facts).length === 0) return false;
    // Once per message, whoever retries.
    const [marker] = await tx
      .insert(rawRecord)
      .values({
        tenantId,
        connectionId: params.connectionId,
        connector: raw?.connector ?? TWILIO_CONNECTOR_ID,
        entityType: CAPTURE_NOTIFIED_ENTITY,
        externalId: `${params.messageSid}:${a.id}`,
        externalVersion: null,
        payload: { agentId: a.id, rawRecordId: params.rawRecordId },
      })
      .onConflictDoNothing()
      .returning({ id: rawRecord.id });
    if (!marker) return false;
    const payload: InboundMessagePayload = {
      agentId: a.id,
      channel: "whatsapp",
      contactId: conv.contactId,
      userId: null,
      rawRecordId: params.rawRecordId,
      documents: results
        .filter((r) => r.status === "filed" && r.documentId)
        .map((r) => r.documentId as string)
        .slice(0, 20),
      receivedAt: new Date().toISOString(),
    };
    await emit(
      tx,
      {
        tenantId,
        type: INBOUND_MESSAGE_EVENT,
        subjectType: "raw_record",
        subjectId: params.rawRecordId,
        payload,
      },
      { registry: deps.events },
    );
    return true;
  });
  await dispatchAfterCommit({ db: deps.db, instances: deps.instances }, tenantId, collect);
  return sent;
}

/** Whether the conversation's agent will be told after the downloads (inbound-text skips it). */
export function captureAgentOf(capture: ConversationCapture, wanted: readonly number[]) {
  return wanted.length > 0 && capture.agentId ? capture.agentId : null;
}

/** For callers outside a request: a step runner that logs and swallows a final failure. */
export async function runCaptureInline(deps: CaptureDeps, params: CaptureParams): Promise<void> {
  try {
    await runCapture(deps, params, inlineCaptureSteps);
  } catch (error) {
    if (error instanceof TransientMediaError) {
      // Left pending: the cron's restart tries again.
      reportHandled("capturing media: Twilio unavailable", error, { kind: "capture" });
      return;
    }
    reportHandled("capturing media failed", error, { kind: "capture" });
  }
}
