// The reading sweep (documents/sweep.ts): a document whose reading on arrival was cut off (left
// `stored` or `extracting`) is read again by the cron, never while a reading is in progress, and
// marked failed with its event after READING_ATTEMPTS readings that never finished.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_USER_HEADER } from "@countersign/auth";
import { docExtraction, document, event, rawRecord, withTenant } from "@countersign/db";
import { claimUnreadDocuments, READING_ATTEMPTS } from "@countersign/documents";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness } from "./api.test-helper";
import { MESSAGE_MEDIA_ENTITY } from "./conversations/capture";
import {
  READING_LOOKBACK_MS,
  READING_SWEEP_EVERY_MINUTES,
  READING_SWEEP_MINUTE,
  readingSweep,
  sweepClientReadings,
} from "./documents/sweep";
import { defaultDeps } from "./http";
import { extractInBackground } from "./routes/documents";

// biome-ignore lint/suspicious/noExplicitAny: response JSON in assertions
type J = any;

const h = await createApiHarness();
afterAll(() => h?.close());

const FIXTURES = resolve(DEFAULT_FIXTURE_DIR, "..");
const invoice = (name: string) => readFileSync(resolve(FIXTURES, "invoices", name));

describe.skipIf(!h)("the reading sweep", () => {
  const H = h as NonNullable<typeof h>;
  const tenantId = H.A.tenantId;
  const services = {
    db: H.db,
    env: H.env,
    deps: {
      ...defaultDeps,
      instances: () => H.instances,
      objects: () => H.objects,
      extractionTransport: () => H.extraction.transport,
    },
  };

  /** Uploads a file with no model key, so nothing reads it on arrival (as if the read was cut). */
  async function uploadUnread(
    name: string,
    type: string,
    bytes: Uint8Array,
    path = "/api/uploads",
  ): Promise<string> {
    const transport = H.extraction.transport;
    H.extraction.transport = null;
    try {
      const form = new FormData();
      form.append("files", new File([bytes], name, { type }));
      const deferred: Promise<unknown>[] = [];
      const res = await H.app.request(
        path,
        { method: "POST", headers: { [DEV_USER_HEADER]: admin("a") }, body: form },
        H.env,
        {
          waitUntil: (p: Promise<unknown>) => void deferred.push(p),
          passThroughOnException: () => {},
          props: {},
        } as unknown as ExecutionContext,
      );
      // The work the upload deferred runs now, while there is no model key.
      while (deferred.length > 0) await Promise.all(deferred.splice(0));
      const json = (await res.json()) as J;
      expect(res.status, JSON.stringify(json)).toBe(200);
      return json.results[0].document.id as string;
    } finally {
      H.extraction.transport = transport;
    }
  }
  const docOf = async (id: string) =>
    (await H.t.db.select().from(document).where(eq(document.id, id)))[0];
  const eventsOf = (id: string, type: string) =>
    H.t.db
      .select()
      .from(event)
      .where(and(eq(event.subjectId, id), eq(event.type, type)));

  const MIN = 60_000;
  /** As if it arrived `ago` ms back. */
  const backdate = (id: string, ago: number) =>
    H.t.db
      .update(document)
      .set({ receivedAt: new Date(Date.now() - ago) })
      .where(eq(document.id, id));
  /** As if a reading started `ago` ms back and was cut off (`attempts` started so far). */
  const cutOff = (id: string, attempts: number, ago = 20 * MIN, more: object = {}) =>
    H.t.db
      .update(document)
      .set({
        status: "extracting",
        meta: { ...more, reading: { at: new Date(Date.now() - ago).toISOString(), attempts } },
      })
      .where(eq(document.id, id));
  const sweep = () => sweepClientReadings(services, tenantId, new Date());
  const readingsOf = (id: string) =>
    H.t.db.select().from(docExtraction).where(eq(docExtraction.documentId, id));
  const claim = (token: string) =>
    withTenant(H.db, tenantId, (tx) =>
      claimUnreadDocuments(tx, { tenantId, claim: token, limit: 10 }),
    );
  const none = { read: 0, failed: 0, quiet: 0 };

  it("reads a document left stored once it has waited 10 minutes, once", async () => {
    const id = await uploadUnread(
      "northline-20418.pdf",
      "application/pdf",
      invoice("northline-20418.pdf"),
    );
    expect((await docOf(id))?.status).toBe("stored");
    // Not yet: its reading may still be on its way.
    expect(await sweep()).toEqual(none);
    await backdate(id, 11 * MIN);
    expect(await sweep()).toEqual({ read: 1, failed: 0, quiet: 0 });
    const doc = await docOf(id);
    expect(doc?.status).toBe("extracted");
    expect(doc?.meta).not.toHaveProperty("reading");
    expect(await eventsOf(id, "document.extracted")).toHaveLength(1);
    // Read once: the next pass finds nothing, and a late reading on arrival (a capture job's own
    // read step, after the sweep's) reads nothing again.
    expect(await sweep()).toEqual(none);
    await extractInBackground(services, tenantId, [id]);
    expect(await readingsOf(id)).toHaveLength(1);
    expect(await eventsOf(id, "document.extracted")).toHaveLength(1);
  });

  it("never reads a file attached to a conversation: it waits to be passed on (§1.110)", async () => {
    const id = await uploadUnread(
      "chat-northline.pdf",
      "application/pdf",
      // Bytes of its own: the same file is stored once per client, and an earlier test reads it.
      new Uint8Array([...invoice("northline-20418.pdf"), 9]),
      "/api/uploads?for=chat",
    );
    await backdate(id, 11 * MIN);
    expect(await sweep()).toEqual(none);
    expect((await docOf(id))?.status).toBe("stored");
    expect(await eventsOf(id, "document.extracted")).toHaveLength(0);
  });

  it("a claim a later pass took over is void: the document is read once, by the holder", async () => {
    const id = await uploadUnread(
      "cedar-ridge-7731.png",
      "image/png",
      invoice("cedar-ridge-7731.png"),
    );
    await backdate(id, 11 * MIN);
    expect((await claim("first")).map((d) => d.id)).toEqual([id]);
    // The first pass ran long and never reached it: its claim went stale, a later pass took it.
    await H.t.db
      .update(document)
      .set({
        status: "stored",
        meta: { reading: { at: new Date(Date.now() - 11 * MIN).toISOString(), claim: "first" } },
      })
      .where(eq(document.id, id));
    expect((await claim("second")).map((d) => d.id)).toEqual([id]);
    // The first pass reaches it at last: not its claim any more.
    await extractInBackground(services, tenantId, [id], { claim: "first" });
    expect(await readingsOf(id)).toEqual([]);
    // Nor a reading on arrival while the claim is fresh.
    await extractInBackground(services, tenantId, [id]);
    expect(await readingsOf(id)).toEqual([]);
    await extractInBackground(services, tenantId, [id], { claim: "second" });
    expect(await readingsOf(id)).toHaveLength(1);
    expect(await eventsOf(id, "document.extracted")).toHaveLength(1);
    expect((await docOf(id))?.meta).toEqual({});
  });

  it("leaves a captured message's document to its capture job while the job is going", async () => {
    const id = await uploadUnread(
      "keystone-55102.pdf",
      "application/pdf",
      invoice("keystone-55102.pdf"),
    );
    const [message] = await H.t.db
      .insert(rawRecord)
      .values({
        tenantId,
        connectionId: H.A.connectionId,
        connector: "twilio",
        entityType: "Message",
        externalId: "SM-sweep-1",
        payload: { capture: { conversationId: "c-1", wanted: [0, 1] } },
      })
      .returning();
    const outcome = (index: number) => ({
      tenantId,
      connectionId: H.A.connectionId,
      connector: "twilio",
      entityType: MESSAGE_MEDIA_ENTITY,
      externalId: `SM-sweep-1:${index}`,
      externalVersion: "1",
      payload: { status: "filed" },
    });
    await H.t.db.insert(rawRecord).values(outcome(0));
    await H.t.db
      .update(document)
      .set({
        source: "message",
        meta: { rawRecordId: message?.id, messageSid: "SM-sweep-1", mediaIndex: 0 },
      })
      .where(eq(document.id, id));
    await backdate(id, 20 * MIN);
    // Attachment 1 is still being fetched: the job reads its documents itself when it is done.
    expect(await sweep()).toEqual(none);
    // Done; its read step was cut off part-way: the sweep reads it.
    await H.t.db.insert(rawRecord).values(outcome(1));
    await cutOff(id, 1, 20 * MIN, { rawRecordId: message?.id });
    expect(await sweep()).toEqual({ read: 1, failed: 0, quiet: 0 });
    expect((await docOf(id))?.status).toBe("extracted");
    expect(await eventsOf(id, "document.extracted")).toHaveLength(1);
  });

  it(`marks it failed, with its event, after ${READING_ATTEMPTS} readings that never finished`, async () => {
    const id = await uploadUnread(
      "third.png",
      "image/png",
      new Uint8Array([...invoice("cedar-ridge-7731.png"), 0]),
    );
    await cutOff(id, READING_ATTEMPTS);
    expect(await sweep()).toEqual({ read: 0, failed: 1, quiet: 0 });
    expect((await docOf(id))?.status).toBe("failed");
    expect(await eventsOf(id, "document.extraction_failed")).toHaveLength(1);
    expect(await readingsOf(id)).toEqual([]);
  });

  it("marks one received over a week ago failed quietly, without an event", async () => {
    const id = await uploadUnread(
      "old.png",
      "image/png",
      new Uint8Array([...invoice("cedar-ridge-7731.png"), 1]),
    );
    await backdate(id, READING_LOOKBACK_MS + 60 * MIN);
    expect(await sweep()).toEqual({ read: 0, failed: 1, quiet: 1 });
    expect((await docOf(id))?.status).toBe("failed");
    expect(await eventsOf(id, "document.extraction_failed")).toEqual([]);
  });

  it("never claims a document twice at once, nor one being read", async () => {
    const id = await uploadUnread(
      "again.png",
      "image/png",
      new Uint8Array([...invoice("cedar-ridge-7731.png"), 2]),
    );
    await backdate(id, 11 * MIN);
    expect((await claim("a")).map((d) => [d.id, d.attempts])).toEqual([[id, 0]]);
    // Claimed: another pass at the same time does not take it.
    expect(await claim("b")).toEqual([]);
    // A reading that started a minute ago is in progress: not claimed either.
    await cutOff(id, 2, MIN);
    expect(await claim("c")).toEqual([]);
    await H.t.db.update(document).set({ status: "failed" }).where(eq(document.id, id));
  });

  it("runs every 5 minutes, at its minute, and only with a model key", async () => {
    const off = new Date(Date.UTC(2026, 10, 20, 10, (READING_SWEEP_MINUTE + 1) % 5));
    expect(await readingSweep(services, off)).toEqual(none);
    const on = new Date(
      Date.UTC(2026, 10, 20, 10, READING_SWEEP_MINUTE + READING_SWEEP_EVERY_MINUTES),
    );
    const transport = H.extraction.transport;
    H.extraction.transport = null;
    try {
      expect(await readingSweep(services, on)).toEqual(none);
    } finally {
      H.extraction.transport = transport;
    }
  });
});
