// DQ-001 (`docs.get#photoMetadata`): Get document gives a photo's location and time taken, read
// from the stored file's metadata in code, and every other document's answer as it was.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ContentStore, ensureUploadConnection, MemoryObjectStore } from "@countersign/connectors";
import { getDocument, storeDocument } from "@countersign/documents";
import { withRecording } from "@countersign/llm";
import { DEFAULT_FIXTURE_DIR, fileFixtureStore } from "@countersign/llm/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { docsGet } from "../tools/docs";
import type { DocumentForTool } from "../tools/types";
import { dbDocumentsPort, documentForTool } from "./documents-port";
import { createHarness, type Harness } from "./harness.test-helper";

const harness = await createHarness();
afterAll(() => harness?.close());

const FIXTURES = resolve(DEFAULT_FIXTURE_DIR, "..");
const file = (path: string) => new Uint8Array(readFileSync(resolve(FIXTURES, path)));

describe.skipIf(!harness)("Get document's photo location and time taken", () => {
  const h = harness as Harness;
  const content = new ContentStore(new MemoryObjectStore());
  const port = dbDocumentsPort(h.db, {
    content,
    transport: withRecording(null, { mode: "replay", store: fileFixtureStore() }),
  });
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const files: [string, string, string][] = [
      ["site.jpg", "photos/site.jpg", "image/jpeg"],
      ["site.heic", "photos/site.heic", "image/heic"],
      ["no-gps.jpg", "photos/no-gps.jpg", "image/jpeg"],
      ["invoice.pdf", "invoices/northline-20418.pdf", "application/pdf"],
    ];
    await h.client(h.A, async (tx) => {
      const conn = await ensureUploadConnection(tx, h.A.tenantId);
      for (const [name, path, mimeType] of files) {
        const stored = await storeDocument(tx, content, {
          tenantId: h.A.tenantId,
          source: "upload",
          connectionId: conn.id,
          bytes: file(path),
          filename: name,
          mimeType,
          // Intake doesn't take HEIC yet (KEPT_TYPES); stored here as a channel that did would.
          allowType: () => true,
        });
        ids[name] = stored.document.id;
      }
    });
  });

  const get = async (name: string) => {
    const doc = await port.get(h.A.tenantId, ids[name] ?? "");
    // What the tool answers is what its output schema allows.
    docsGet.output.parse({ ...doc, sources: [] });
    return doc as DocumentForTool;
  };

  it.each(["site.jpg", "site.heic"])("gives %s's GPS position and time taken", async (name) => {
    const doc = await get(name);
    expect(doc.locationSource).toBe("exif");
    expect(Math.abs((doc.latitude ?? 0) - 30.267153)).toBeLessThan(0.0001);
    expect(Math.abs((doc.longitude ?? 0) - -97.743057)).toBeLessThan(0.0001);
    expect(doc.takenAt).toBe("2026-11-20T14:32:05-06:00");
  });

  it("gives none for a photo without GPS, not an error", async () => {
    expect(await get("no-gps.jpg")).toMatchObject({
      latitude: null,
      longitude: null,
      locationSource: "none",
    });
  });

  it("answers a document that isn't a photo exactly as before", async () => {
    const doc = await port.get(h.A.tenantId, ids["invoice.pdf"] ?? "");
    const view = await h.client(h.A, (tx) =>
      getDocument(tx, h.A.tenantId, ids["invoice.pdf"] ?? ""),
    );
    if (!view) throw new Error("no document");
    expect(doc).toEqual(await documentForTool(view, null));
    expect(Object.keys(doc ?? {})).not.toContain("locationSource");
  });

  it("gives none for another client's photo: it isn't found", async () => {
    expect(await port.get(h.B.tenantId, ids["site.jpg"] ?? "")).toBeNull();
  });
});
