// The reading sweep (documents/sweep.ts): a document whose reading on arrival was cut off (left
// `stored` or `extracting`) is read again by the cron, never while a reading is in progress, and
// marked failed with its event after READING_ATTEMPTS readings that never finished.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_USER_HEADER } from "@countersign/auth";
import { docExtraction, document, event, withTenant } from "@countersign/db";
import { claimUnreadDocuments, READING_ATTEMPTS } from "@countersign/documents";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { admin, createApiHarness } from "./api.test-helper";
import {
  READING_STALE_MS,
  READING_SWEEP_EVERY_MINUTES,
  READING_SWEEP_MINUTE,
  readingSweep,
  sweepClientReadings,
} from "./documents/sweep";
import { defaultDeps } from "./http";

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
  const later = () => new Date(Date.now() + READING_STALE_MS + 60_000);

  /** Uploads a file with no model key, so nothing reads it on arrival (as if the read was cut). */
  async function uploadUnread(name: string, type: string, bytes: Uint8Array): Promise<string> {
    const transport = H.extraction.transport;
    H.extraction.transport = null;
    try {
      const form = new FormData();
      form.append("files", new File([bytes], name, { type }));
      const deferred: Promise<unknown>[] = [];
      const res = await H.app.request(
        "/api/uploads",
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

  it("reads a document left stored once it has waited 10 minutes", async () => {
    const id = await uploadUnread(
      "northline-20418.pdf",
      "application/pdf",
      invoice("northline-20418.pdf"),
    );
    expect((await docOf(id))?.status).toBe("stored");
    // Not yet: its reading may still be on its way.
    expect(await sweepClientReadings(services, tenantId, new Date())).toEqual({
      read: 0,
      failed: 0,
    });
    expect(await sweepClientReadings(services, tenantId, later())).toEqual({ read: 1, failed: 0 });
    const doc = await docOf(id);
    expect(doc?.status).toBe("extracted");
    expect(doc?.meta).not.toHaveProperty("reading");
    expect(await eventsOf(id, "document.extracted")).toHaveLength(1);
    // Read once: the next pass finds nothing.
    expect(await sweepClientReadings(services, tenantId, later())).toEqual({ read: 0, failed: 0 });
  });

  it("reads one left extracting by a reading that was cut off", async () => {
    const id = await uploadUnread(
      "cedar-ridge-7731.png",
      "image/png",
      invoice("cedar-ridge-7731.png"),
    );
    await H.t.db
      .update(document)
      .set({
        status: "extracting",
        meta: { uploadedBy: "x", reading: { at: new Date().toISOString(), attempts: 1 } },
      })
      .where(eq(document.id, id));
    expect(await sweepClientReadings(services, tenantId, new Date())).toEqual({
      read: 0,
      failed: 0,
    });
    expect(await sweepClientReadings(services, tenantId, later())).toEqual({ read: 1, failed: 0 });
    const doc = await docOf(id);
    expect(doc?.status).toBe("extracted");
    expect(doc?.meta).toEqual({ uploadedBy: "x" });
  });

  it(`marks it failed, with its event, after ${READING_ATTEMPTS} readings that never finished`, async () => {
    const id = await uploadUnread(
      "keystone-55102.pdf",
      "application/pdf",
      invoice("keystone-55102.pdf"),
    );
    await H.t.db
      .update(document)
      .set({
        status: "extracting",
        meta: { reading: { at: new Date().toISOString(), attempts: READING_ATTEMPTS } },
      })
      .where(eq(document.id, id));
    expect(await sweepClientReadings(services, tenantId, later())).toEqual({ read: 0, failed: 1 });
    expect((await docOf(id))?.status).toBe("failed");
    expect(await eventsOf(id, "document.extraction_failed")).toHaveLength(1);
    expect(
      await H.t.db.select().from(docExtraction).where(eq(docExtraction.documentId, id)),
    ).toEqual([]);
  });

  it("counts each reading started, and never claims one in progress", async () => {
    // Any extractable bytes: this one is claimed, never read.
    const bytes = new Uint8Array([...invoice("cedar-ridge-7731.png"), 0]);
    const id = await uploadUnread("again.png", "image/png", bytes);
    const now = later();
    const claim = () =>
      withTenant(H.db, tenantId, (tx) =>
        claimUnreadDocuments(tx, {
          tenantId,
          staleBefore: new Date(now.getTime() - READING_STALE_MS),
          now,
          limit: 10,
        }),
      );
    expect((await claim()).map((d) => [d.id, d.attempts])).toEqual([[id, 0]]);
    // Claimed: a second sweep (another tick, at the same time) does not take it.
    expect(await claim()).toEqual([]);
    // A reading that started just now is in progress: not claimed either.
    await H.t.db
      .update(document)
      .set({ status: "extracting", meta: { reading: { at: now.toISOString(), attempts: 2 } } })
      .where(eq(document.id, id));
    expect(await claim()).toEqual([]);
    await H.t.db.update(document).set({ status: "failed" }).where(eq(document.id, id));
  });

  it("runs every 5 minutes, at its minute, and only with a model key", async () => {
    const off = new Date(Date.UTC(2026, 10, 20, 10, (READING_SWEEP_MINUTE + 1) % 5));
    expect(await readingSweep(services, off)).toEqual({ read: 0, failed: 0 });
    const on = new Date(
      Date.UTC(2026, 10, 20, 10, READING_SWEEP_MINUTE + READING_SWEEP_EVERY_MINUTES),
    );
    const transport = H.extraction.transport;
    H.extraction.transport = null;
    try {
      expect(await readingSweep(services, on)).toEqual({ read: 0, failed: 0 });
    } finally {
      H.extraction.transport = transport;
    }
  });
});
