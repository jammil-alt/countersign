// v0.14 capture: the capture setting, the client's default, and the attachment types each setting
// takes (docs/plan.md §1.55).

import { describe, expect, it } from "vitest";
import {
  attachmentKind,
  bytesMatchType,
  CAPTURE_DEFAULT,
  CAPTURE_MAX_BYTES_CAP,
  ConversationCapture,
  captureAllows,
  defaultCaptureOf,
  extensionFor,
  initialCapture,
} from "./conversation";

/** A string's bytes, one per character (ASCII only here). */
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));

describe("capture", () => {
  it("defaults to keeping messages, attachments off, 20 MB", () => {
    expect(CAPTURE_DEFAULT).toEqual({ archive: true, attachments: "off", maxBytes: 20971520 });
    expect(defaultCaptureOf({})).toEqual(CAPTURE_DEFAULT);
    expect(defaultCaptureOf({ messaging: { capture: { archive: "yes" } } })).toEqual(
      CAPTURE_DEFAULT,
    );
    const set = { archive: false, attachments: "documents", maxBytes: 1024 };
    expect(defaultCaptureOf({ messaging: { quietHours: {}, capture: set } })).toEqual(set);
  });

  it("caps the size and refuses unknown fields", () => {
    const ok = { archive: true, attachments: "all", maxBytes: CAPTURE_MAX_BYTES_CAP };
    expect(ConversationCapture.safeParse(ok).success).toBe(true);
    expect(
      ConversationCapture.safeParse({ ...ok, maxBytes: CAPTURE_MAX_BYTES_CAP + 1 }).success,
    ).toBe(false);
    expect(ConversationCapture.safeParse({ ...ok, maxBytes: 0 }).success).toBe(false);
    expect(ConversationCapture.safeParse({ ...ok, url: "x" }).success).toBe(false);
    expect(ConversationCapture.safeParse({ ...ok, agentId: "not-an-id" }).success).toBe(false);
  });

  it("starts a stranger's conversation with attachments off", () => {
    const on = { ...CAPTURE_DEFAULT, attachments: "documents" as const };
    expect(initialCapture(on, true).attachments).toBe("documents");
    expect(initialCapture(on, false)).toEqual({ ...on, attachments: "off" });
  });

  it("takes PDFs and images under documents, a fixed list more under all, never anything else", () => {
    for (const t of [
      "application/pdf",
      "image/png",
      "image/JPEG",
      "image/jpg",
      "image/webp; q=1",
    ]) {
      expect(attachmentKind(t), t).toBe("document");
      expect(captureAllows({ attachments: "documents" }, t), t).toBe(true);
      expect(captureAllows({ attachments: "off" }, t), t).toBe(false);
    }
    for (const t of ["audio/ogg", "video/mp4", "text/csv"]) {
      expect(captureAllows({ attachments: "documents" }, t), t).toBe(false);
      expect(captureAllows({ attachments: "all" }, t), t).toBe(true);
    }
    for (const t of [
      "application/x-msdownload",
      "application/zip",
      "text/html",
      "",
      "image/svg+xml",
    ]) {
      expect(captureAllows({ attachments: "all" }, t), t).toBe(false);
    }
    expect(extensionFor("image/jpeg")).toBe("jpg");
    expect(extensionFor("audio/ogg")).toBe("ogg");
  });

  it("checks PDFs and images by their first bytes", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]);
    expect(bytesMatchType(png, "image/png")).toBe(true);
    expect(bytesMatchType(png, "application/pdf")).toBe(false);
    expect(bytesMatchType(ascii("%PDF-1.7"), "application/pdf")).toBe(true);
    expect(bytesMatchType(ascii("<html>"), "image/jpeg")).toBe(false);
    const webp = ascii("RIFF\0\0\0\0WEBPVP8 ");
    expect(bytesMatchType(webp, "image/webp")).toBe(true);
    expect(bytesMatchType(ascii("RIFF\0\0\0\0WAVEfmt "), "image/webp")).toBe(false);
    expect(bytesMatchType(new Uint8Array([1]), "audio/ogg")).toBe(true);
    expect(bytesMatchType(new Uint8Array([1]), "application/zip")).toBe(false);
  });
});
