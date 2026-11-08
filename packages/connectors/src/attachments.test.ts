// P-3: attachments both ways (docs/plan.md §1.65), outbound, against the fakes: each email tool
// carries up to five of the call's client's PDFs and images, read from storage for that send and
// named by the document record. Another client's id reads as unknown and is refused, as are other
// types, more than the provider takes and bytes that aren't what the record says. Gmail gets a
// proper multipart/mixed message (read back with a real MIME parser), Outlook Graph's
// `fileAttachment`, Resend base64 `attachments`; Meta gets one file by link with the text as its
// caption. The approval card's before state lists them by name and size.

import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import {
  AttachmentRefusedError,
  describeOutbound,
  linkOutbound,
  loadOutbound,
} from "./attachments";
import type { ConnectionRef, DocumentServices, StoredFile } from "./connector";
import { memoryCredentials } from "./credentials-accessor";
import { FAKE_GOOGLE, fakeGoogle } from "./gmail/fake";
import {
  createGmailConnector,
  GMAIL_ATTACHMENT_LIMITS,
  GMAIL_SEND_TOOL,
  GMAIL_UPLOAD_SEND_URL,
} from "./gmail/index";
import { buildPlainMessage, fileNameParams } from "./gmail/mime";
import { captureBefore, executeWrite } from "./invoke";
import { noopLogger } from "./logger";
import { FAKE_MICROSOFT, fakeMicrosoft } from "./outlook/fake";
import {
  createOutlookConnector,
  graphMessage,
  OUTLOOK_ATTACHMENT_LIMITS,
  OUTLOOK_SEND_TOOL,
} from "./outlook/index";
import { FAKE_RESEND_MAIN, fakeResend } from "./resend/fake";
import {
  createResendConnector,
  createSendingKey,
  EMAIL_SEND_TOOL,
  type EmailSendAttempt,
  type EmailServices,
} from "./resend/index";
import { fromBase64, utf8 } from "./runtime";
import {
  checkMetaMedia,
  META_CAPTION_MAX,
  META_WHATSAPP_LIMITS,
  metaMediaMessage,
} from "./whatsapp_meta/index";

const NOW = new Date("2026-11-07T15:00:00.000Z");
const TENANT = "0192f7a0-0000-7000-8000-0000000000aa";
const PDF_ID = "0192f7a0-0000-7000-8000-00000000d001";
const PNG_ID = "0192f7a0-0000-7000-8000-00000000d002";
const TXT_ID = "0192f7a0-0000-7000-8000-00000000d003";
const FAKE_PDF_ID = "0192f7a0-0000-7000-8000-00000000d004";
/** Client B's document: the documents service of client A doesn't know it. */
const OTHER_CLIENTS = "0192f7a0-0000-7000-8000-00000000db01";

const pdf = utf8("%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF\n");
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

const FILES: StoredFile[] = [
  { id: PDF_ID, bytes: pdf, filename: "PO-1042.pdf", mimeType: "application/pdf", sha256: "a" },
  { id: PNG_ID, bytes: png, filename: "Plano — cocina.png", mimeType: "image/png", sha256: "b" },
  { id: TXT_ID, bytes: utf8("hello"), filename: "notes.txt", mimeType: "text/plain", sha256: "c" },
  // Says PDF, isn't one.
  {
    id: FAKE_PDF_ID,
    bytes: utf8("MZ..."),
    filename: "x.pdf",
    mimeType: "application/pdf",
    sha256: "d",
  },
];

/** Client A's documents, as apps/api's service answers: another client's id reads as null. */
function documents(opts: { signed?: boolean } = {}): DocumentServices & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async read(id) {
      reads.push(id);
      return FILES.find((f) => f.id === id) ?? null;
    },
    async describe(id) {
      const f = FILES.find((x) => x.id === id);
      return f
        ? { id: f.id, filename: f.filename, mimeType: f.mimeType, sizeBytes: f.bytes.length }
        : null;
    },
    ...(opts.signed === false
      ? {}
      : {
          async signedUrl(id: string) {
            return FILES.some((f) => f.id === id)
              ? `https://app.mezonas.test/api/files/token-${id}`
              : null;
          },
        }),
  };
}

function emailServices() {
  const attempts = new Map<string, EmailSendAttempt>();
  const sent = new Map<string, Awaited<ReturnType<EmailServices["sentFor"]>>>();
  const recorded: Parameters<EmailServices["recordOutbound"]>[0][] = [];
  const s: Required<EmailServices> = {
    async checkSend({ to }) {
      return to === "maria@proveedor.example"
        ? { ok: true, contact: { id: "c1", name: "María Núñez" } }
        : { ok: false, message: "not a contact" };
    },
    async sentFor(key) {
      return sent.get(key) ?? null;
    },
    async startAttempt(a) {
      if (!attempts.has(a.idempotencyKey)) attempts.set(a.idempotencyKey, a);
    },
    async attemptFor(key) {
      return attempts.get(key) ?? null;
    },
    async replyAddress() {
      return "shop-abc-secret@in.mezonas.test";
    },
    async recordOutbound(m) {
      recorded.push(m);
      sent.set(m.idempotencyKey, m.output);
    },
  };
  return { s, recorded, attempts };
}

const EMAIL = {
  to: "maria@proveedor.example",
  subject: "Purchase order 1042",
  text: "Hello María,\n\nOur purchase order is attached.",
  replyTag: "0192f7a0000070008000000000000001",
};
const ctxFor = (connection: ConnectionRef, docs: DocumentServices, credentials = {}) => ({
  tenantId: TENANT,
  connection,
  credentials: memoryCredentials(credentials),
  logger: noopLogger,
  now: () => NOW,
  services: { email: emailServices().s, documents: docs },
  idempotencyKey: "0192f7a0-run:po:reach:0",
});
const conn = (connector: string, extra: Partial<ConnectionRef> = {}): ConnectionRef => ({
  id: "0192f7a0-0000-7000-8000-000000000009",
  tenantId: TENANT,
  connector,
  status: "connected",
  externalAccountId: "orders@shop.example",
  config: {},
  permissions: {},
  ...extra,
});
const ctxBase = (docs?: DocumentServices) => ({
  tenantId: TENANT,
  connection: conn("resend"),
  credentials: memoryCredentials({}),
  logger: noopLogger,
  now: () => NOW,
  ...(docs ? { services: { documents: docs } } : {}),
});

describe("outbound attachments: the checks", () => {
  it("names each document from its record, without reading the files", async () => {
    const docs = documents();
    const list = await describeOutbound(
      ctxBase(docs),
      [{ documentId: PDF_ID }, { documentId: PNG_ID }],
      GMAIL_ATTACHMENT_LIMITS,
    );
    expect(list).toEqual([
      {
        documentId: PDF_ID,
        filename: "PO-1042.pdf",
        mimeType: "application/pdf",
        sizeBytes: pdf.length,
      },
      {
        documentId: PNG_ID,
        filename: "Plano — cocina.png",
        mimeType: "image/png",
        sizeBytes: png.length,
      },
    ]);
    expect(docs.reads).toEqual([]);
  });

  it("refuses another client's document as unknown, and nothing is read", async () => {
    const docs = documents();
    for (const fn of [describeOutbound, loadOutbound, linkOutbound]) {
      const err = await fn(
        ctxBase(docs),
        [{ documentId: OTHER_CLIENTS }],
        GMAIL_ATTACHMENT_LIMITS,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AttachmentRefusedError);
      expect((err as AttachmentRefusedError).code).toBe("not_found");
    }
  });

  it("refuses other types, bytes that aren't their type, too many and too large", async () => {
    const code = (p: Promise<unknown>) =>
      p.then(
        () => "sent",
        (e: unknown) => (e instanceof AttachmentRefusedError ? e.code : String(e)),
      );
    const docs = documents();
    expect(
      await code(
        describeOutbound(ctxBase(docs), [{ documentId: TXT_ID }], GMAIL_ATTACHMENT_LIMITS),
      ),
    ).toBe("type_not_allowed");
    expect(
      await code(
        loadOutbound(ctxBase(docs), [{ documentId: FAKE_PDF_ID }], GMAIL_ATTACHMENT_LIMITS),
      ),
    ).toBe("type_mismatch");
    expect(
      await code(
        describeOutbound(
          ctxBase(docs),
          [{ documentId: PDF_ID }, { documentId: PNG_ID }],
          META_WHATSAPP_LIMITS,
        ),
      ),
    ).toBe("too_many");
    expect(
      await code(
        describeOutbound(ctxBase(docs), [{ documentId: PDF_ID }], {
          provider: "Tiny",
          maxCount: 5,
          maxTotalBytes: 10,
        }),
      ),
    ).toBe("too_large");
    // No documents service: refused, never sent without the files.
    expect(
      await code(describeOutbound(ctxBase(), [{ documentId: PDF_ID }], GMAIL_ATTACHMENT_LIMITS)),
    ).toBe("not_available");
    // Links need the platform's signer.
    expect(
      await code(
        linkOutbound(
          ctxBase(documents({ signed: false })),
          [{ documentId: PDF_ID }],
          GMAIL_ATTACHMENT_LIMITS,
        ),
      ),
    ).toBe("not_available");
  });

  it("caps each provider at its own limit", () => {
    expect(GMAIL_ATTACHMENT_LIMITS.maxTotalBytes).toBe(18 * 1024 * 1024);
    expect(OUTLOOK_ATTACHMENT_LIMITS.maxTotalBytes).toBe(3_000_000);
    expect(META_WHATSAPP_LIMITS.maxCount).toBe(1);
  });
});

describe("gmail: the MIME parts", () => {
  it("builds multipart/mixed with the text first and each file base64, read back by a real parser", async () => {
    const message = buildPlainMessage({
      from: { address: "orders@shop.example" },
      to: "maria@proveedor.example",
      subject: "PO 1042",
      text: "See attached.",
      messageId: "<run.po.reach.0.mezonas@shop.example>",
      date: NOW,
      attachments: [
        { filename: "PO-1042.pdf", mimeType: "application/pdf", bytes: pdf },
        { filename: "Plano — cocina.png", mimeType: "image/png", bytes: png },
      ],
    });
    // 7-bit ASCII, CRLF, every line within 998 characters.
    expect(message).not.toMatch(/[^\t\r\n\x20-\x7e]/);
    expect(message.split("\r\n").every((l) => l.length <= 998)).toBe(true);
    expect(message).toContain('Content-Type: multipart/mixed; boundary="=_mz_');
    expect(message).toContain('Content-Disposition: attachment; filename="PO-1042.pdf"');
    expect(message).toContain("filename*=UTF-8''Plano%20%E2%80%94%20cocina.png");
    const parsed = await PostalMime.parse(utf8(message), { attachmentEncoding: "arraybuffer" });
    expect(parsed.text?.trim()).toBe("See attached.");
    expect(parsed.attachments.map((a) => [a.filename, a.mimeType, a.disposition])).toEqual([
      ["PO-1042.pdf", "application/pdf", "attachment"],
      ["Plano — cocina.png", "image/png", "attachment"],
    ]);
    expect(new Uint8Array(parsed.attachments[0]?.content as ArrayBuffer)).toEqual(pdf);
    expect(new Uint8Array(parsed.attachments[1]?.content as ArrayBuffer)).toEqual(png);
  });

  it("keeps line breaks and quotes out of a file name's header", () => {
    expect(fileNameParams('evil"\r\nBcc: x@y.z.pdf')).toEqual({
      disposition: 'filename="evil Bcc: x@y.z.pdf"',
      type: 'name="evil Bcc: x@y.z.pdf"',
    });
    expect(() =>
      buildPlainMessage({
        from: { address: "a@b.example" },
        to: "c@d.example",
        subject: "s",
        text: "t",
        messageId: "<m@b.example>",
        date: NOW,
        attachments: [{ filename: "x", mimeType: "text/html\r\nX: y", bytes: pdf }],
      }),
    ).toThrow(/type is not valid/);
  });

  it("sends through the upload URI, lists the files on the approval card and in the output", async () => {
    const google = fakeGoogle();
    const connector = createGmailConnector({ ...FAKE_GOOGLE, fetch: google.fetch });
    const grant = await connector.handleCallback?.(
      { code: google.issueCode({ address: "orders@shop.example" }), state: "s" },
      { tenantId: TENANT, userId: "u1", redirectUri: "https://x.test/cb" },
    );
    if (!grant) throw new Error("no grant");
    const ctx = ctxFor(conn("gmail"), documents(), {
      ...grant.credentials,
      expiresAt: "2026-11-07T16:00:00.000Z",
    });
    const input = { ...EMAIL, attachments: [{ documentId: PDF_ID }, { documentId: PNG_ID }] };
    const { before } = await captureBefore(connector, GMAIL_SEND_TOOL, input, ctx);
    expect((before as { attachments: unknown }).attachments).toEqual([
      expect.objectContaining({ filename: "PO-1042.pdf", sizeBytes: pdf.length }),
      expect.objectContaining({ filename: "Plano — cocina.png", sizeBytes: png.length }),
    ]);
    const out = await executeWrite(connector, GMAIL_SEND_TOOL, input, ctx);
    expect((out.output as { attachments: unknown[] }).attachments).toHaveLength(2);
    expect(google.requests.at(-1)?.url).toBe(GMAIL_UPLOAD_SEND_URL);
    const parsed = await PostalMime.parse(utf8(google.sent[0]?.message ?? ""));
    expect(parsed.attachments.map((a) => a.filename)).toEqual([
      "PO-1042.pdf",
      "Plano — cocina.png",
    ]);
    // Without files, the plain JSON `raw` send as before.
    await executeWrite(connector, GMAIL_SEND_TOOL, EMAIL, { ...ctx, idempotencyKey: "k2" });
    expect(google.requests.at(-1)?.url).toMatch(/\/users\/me\/messages\/send$/);
  });

  it("refuses another client's document before anything is started or sent", async () => {
    const google = fakeGoogle();
    const connector = createGmailConnector({ ...FAKE_GOOGLE, fetch: google.fetch });
    const grant = await connector.handleCallback?.(
      { code: google.issueCode({ address: "orders@shop.example" }), state: "s" },
      { tenantId: TENANT, userId: "u1", redirectUri: "https://x.test/cb" },
    );
    const email = emailServices();
    const ctx = {
      ...ctxFor(conn("gmail"), documents(), {
        ...grant?.credentials,
        expiresAt: "2026-11-07T16:00:00.000Z",
      }),
      services: { email: email.s, documents: documents() },
    };
    await expect(
      executeWrite(
        connector,
        GMAIL_SEND_TOOL,
        { ...EMAIL, attachments: [{ documentId: OTHER_CLIENTS }] },
        ctx,
      ),
    ).rejects.toBeInstanceOf(AttachmentRefusedError);
    expect(google.sent).toHaveLength(0);
    expect(email.attempts.size).toBe(0);
  });
});

describe("outlook: Graph's attachment shape", () => {
  it("puts each file in the message as a fileAttachment with its name, type and base64 bytes", async () => {
    const body = graphMessage({
      to: "maria@proveedor.example",
      replyTo: null,
      subject: "PO",
      text: "Attached.",
      ref: "mz-1",
      attachments: [{ filename: "PO-1042.pdf", mimeType: "application/pdf", bytes: pdf }],
    }) as { message: { attachments: Record<string, string>[] } };
    expect(body.message.attachments).toEqual([
      {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: "PO-1042.pdf",
        contentType: "application/pdf",
        contentBytes: expect.any(String),
      },
    ]);
    expect(fromBase64(body.message.attachments[0]?.contentBytes as string)).toEqual(pdf);
  });

  it("sends them through sendMail and refuses more than Graph's request takes", async () => {
    const ms = fakeMicrosoft();
    const connector = createOutlookConnector({ ...FAKE_MICROSOFT, fetch: ms.fetch });
    const grant = await connector.handleCallback?.(
      { code: ms.issueCode(), state: "s", session_state: "x" },
      { tenantId: TENANT, userId: "u1", redirectUri: "https://x.test/cb" },
    );
    if (!grant) throw new Error("no grant");
    const ctx = ctxFor(
      conn("outlook", { externalAccountId: grant.externalAccountId }),
      documents(),
      {
        ...grant.credentials,
        expiresAt: "2026-11-07T16:00:00.000Z",
      },
    );
    await executeWrite(
      connector,
      OUTLOOK_SEND_TOOL,
      { ...EMAIL, attachments: [{ documentId: PDF_ID }] },
      ctx,
    );
    const sent = ms.sent[0]?.body.message as unknown as { attachments: { name: string }[] };
    expect(sent.attachments.map((a) => a.name)).toEqual(["PO-1042.pdf"]);
    const big: DocumentServices = {
      ...documents(),
      async describe(id) {
        return { id, filename: "scan.pdf", mimeType: "application/pdf", sizeBytes: 3_500_000 };
      },
    };
    await expect(
      captureBefore(
        connector,
        OUTLOOK_SEND_TOOL,
        { ...EMAIL, attachments: [{ documentId: PDF_ID }] },
        {
          ...ctx,
          services: { email: emailServices().s, documents: big },
        },
      ),
    ).rejects.toThrow(/Outlook takes at most 2\.9 MB/);
  });
});

describe("resend: base64 attachments", () => {
  it("sends each file with its record's name and type", async () => {
    const resend = fakeResend();
    const key = await createSendingKey(resend.fetch, FAKE_RESEND_MAIN.apiKey, {
      name: "client",
      domainId: null,
    });
    const connector = createResendConnector({ fetch: resend.fetch });
    const ctx = ctxFor(
      conn("resend", {
        config: { sendingDomain: "mail.mezonas.test", localPart: "orders", replyTo: null },
      }),
      documents(),
      { apiKey: key },
    );
    const out = await executeWrite(
      connector,
      EMAIL_SEND_TOOL,
      { ...EMAIL, attachments: [{ documentId: PDF_ID }] },
      ctx,
    );
    expect(resend.emails[0]?.attachments).toEqual([
      { filename: "PO-1042.pdf", content: expect.any(String), content_type: "application/pdf" },
    ]);
    expect(fromBase64(resend.emails[0]?.attachments?.[0]?.content as string)).toEqual(pdf);
    expect(out.output).toMatchObject({
      attachments: [{ documentId: PDF_ID, filename: "PO-1042.pdf", sizeBytes: pdf.length }],
    });
    // Six documents is more than any email takes: refused at the input.
    await expect(
      executeWrite(
        connector,
        EMAIL_SEND_TOOL,
        {
          ...EMAIL,
          attachments: Array.from({ length: 6 }, (_, i) => ({
            documentId: `0192f7a0-0000-7000-8000-00000000e00${i}`,
          })),
        },
        { ...ctx, idempotencyKey: "k6" },
      ),
    ).rejects.toThrow(/invalid input/);
  });
});

describe("whatsapp through Meta: one file by link, the text its caption", () => {
  it("sends a PDF as a document with its file name, a JPEG or PNG as an image", () => {
    const base = { documentId: PDF_ID, sizeBytes: 10, url: "https://app.mezonas.test/api/files/t" };
    expect(
      metaMediaMessage({ ...base, filename: "PO.pdf", mimeType: "application/pdf" }, "Our order"),
    ).toEqual({
      type: "document",
      document: { link: base.url, caption: "Our order", filename: "PO.pdf" },
    });
    expect(metaMediaMessage({ ...base, filename: "p.png", mimeType: "image/png" }, "")).toEqual({
      type: "image",
      image: { link: base.url },
    });
  });

  it("refuses an image over 5 MB and a caption over 1024 characters", () => {
    const file = {
      documentId: PNG_ID,
      filename: "p.png",
      mimeType: "image/png",
      sizeBytes: 6 * 1024 * 1024,
    };
    expect(() => checkMetaMedia(file, "hi")).toThrow(AttachmentRefusedError);
    expect(() =>
      checkMetaMedia({ ...file, sizeBytes: 10 }, "x".repeat(META_CAPTION_MAX + 1)),
    ).toThrow(/1024 characters/);
    expect(() => checkMetaMedia({ ...file, sizeBytes: 10 }, "fine")).not.toThrow();
  });
});
