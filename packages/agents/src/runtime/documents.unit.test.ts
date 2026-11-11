// Skill model (2026-11-10): an AI skill's `x-document` inputs are attached to its model call, as
// data; code skills and skills that mark none attach nothing. No database.

import { describe, expect, it } from "vitest";
import { DOCS_SPLIT_SKILLS, READ_DOCUMENT_SKILL } from "../tools/docs-split";
import type { DocumentsPort } from "../tools/types";
import { documentAttachments, documentInputFields } from "./documents";

const read = DOCS_SPLIT_SKILLS.find((s) => s.id === READ_DOCUMENT_SKILL);
if (!read) throw new Error("Read document is registered");

const port = (files: Record<string, { mimeType: string; bytes: Uint8Array }>) =>
  ({
    async file(tenantId: string, documentId: string) {
      const f = files[`${tenantId}/${documentId}`];
      if (!f) throw new Error(`document ${documentId} not found`);
      return { documentId, filename: "x", ...f };
    },
  }) as unknown as DocumentsPort;

describe("documents an AI skill reads", () => {
  it("finds the fields marked as documents", () => {
    expect(documentInputFields(read)).toEqual(["documentId"]);
    expect(documentInputFields({ input: { type: "object", properties: { a: {} } } })).toEqual([]);
  });

  it("attaches a PDF as a document block and an image as an image block", async () => {
    const docs = port({
      "t1/d1": { mimeType: "application/pdf", bytes: new Uint8Array([37, 80, 68, 70]) },
      "t1/d2": { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    });
    const pdf = await documentAttachments(docs, "t1", read, { documentId: "d1" });
    expect(pdf).toMatchObject({ ok: true, blocks: [{ type: "document" }] });
    const png = await documentAttachments(docs, "t1", read, { documentId: "d2" });
    expect(png).toMatchObject({ ok: true, blocks: [{ type: "image" }] });
  });

  it("reads only the run's client's documents, and fails in plain words", async () => {
    const docs = port({ "t1/d1": { mimeType: "application/pdf", bytes: new Uint8Array([1]) } });
    const other = await documentAttachments(docs, "t2", read, { documentId: "d1" });
    expect(other).toMatchObject({ ok: false });
    if (!other.ok) expect(other.error).toMatch(/couldn't read document d1/);
    const none = await documentAttachments(undefined, "t1", read, { documentId: "d1" });
    expect(none).toEqual({ ok: false, error: "reading a document is not available here" });
  });

  it("attaches nothing for a code skill", async () => {
    const code = { ...read, mode: "tool" as const };
    expect(await documentAttachments(undefined, "t1", code, { documentId: "d1" })).toEqual({
      ok: true,
      blocks: [],
    });
  });
});
