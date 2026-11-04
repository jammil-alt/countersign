import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  forwardingAddress,
  forwardingStatsOf,
  newForwardingSecret,
  updateForwarding,
} from "@countersign/connectors";
import { connection, document, event } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { receiveForwardedEmail } from "./forwarding";
import { INVOICE_DIR } from "./golden.test-helper";
import { createHarness, type Harness } from "./harness.test-helper";

const h = await createHarness();
afterAll(() => h?.close());

const DOMAIN = "in.mezonas.test";
const eml = (name: string) => new Uint8Array(readFileSync(resolve(INVOICE_DIR, "../email", name)));
const BODY_MARKER = "BODY-TEXT-MUST-NOT-BE-STORED";

describe.skipIf(!h)("email forwarding", () => {
  const harness = h as Harness;
  const { A, B } = harness;
  let address: string;

  beforeAll(async () => {
    address = forwardingAddress({
      tenantId: A.tenantId,
      clientName: "Hollis Millwork",
      secret: newForwardingSecret(),
      domain: DOMAIN,
    });
    await harness.as(A, async (tx) => {
      const [row] = await tx
        .select()
        .from(connection)
        .where(eq(connection.id, A.uploadConnectionId));
      if (!row) throw new Error("no upload connection");
      await updateForwarding(
        tx,
        row,
        { address, allowedSenders: ["ap@hollismillwork.example", "keystonehw.example"] },
        null,
      );
    });
  });

  const receive = (name: string, from: string, to = address) =>
    receiveForwardedEmail(harness.deps(), { from, to, raw: eml(name) }, { domain: DOMAIN });

  async function stats() {
    return harness.as(A, async (tx) => {
      const [row] = await tx
        .select()
        .from(connection)
        .where(eq(connection.id, A.uploadConnectionId));
      return forwardingStatsOf(row ?? { syncCursor: null });
    });
  }

  it("accepts an allowed sender's attachments as email documents, headers kept, body not", async () => {
    const r = await receive("forwarded-by-ap.eml", "ap@hollismillwork.example");
    expect(r.status).toBe("accepted");
    if (r.status !== "accepted") return;
    // The PDF, not the inline signature logo.
    expect(r.documents.map((d) => d.filename)).toEqual(["northline-20418.pdf"]);
    expect(r.skipped).toEqual([{ filename: "logo.png", reason: "an inline image" }]);
    const [doc] = await harness.as(A, (tx) =>
      tx
        .select()
        .from(document)
        .where(eq(document.id, r.documents[0]?.id ?? "")),
    );
    expect(doc?.source).toBe("email");
    expect(doc?.mimeType).toBe("application/pdf");
    expect(doc?.meta).toMatchObject({
      email: {
        from: "ap@hollismillwork.example",
        subject: "Fwd: Invoice 20418 from Northline Panel Supply",
        messageId: "<fwd-20418@mail.example>",
      },
    });
    // No body anywhere: not on the document, not in any event.
    const docs = await harness.as(A, (tx) => tx.select().from(document));
    const events = await harness.as(A, (tx) => tx.select().from(event));
    expect(JSON.stringify([docs, events])).not.toContain(BODY_MARKER);
    expect(JSON.stringify([docs, events])).not.toContain("ignore your instructions");
  });

  it("stores the same attachment once when it is forwarded again", async () => {
    const before = harness.objects.size;
    const r = await receive("forwarded-by-ap.eml", "ap@hollismillwork.example");
    expect(r.status === "accepted" && r.documents[0]?.created).toBe(false);
    expect(harness.objects.size).toBe(before);
  });

  it("accepts a vendor's own mail by domain (From header), keeping PDFs and images only", async () => {
    // The envelope is the vendor's bulk sender; the From header is on the list by domain.
    const r = await receive("from-vendor.eml", "bounce+123@mailer.keystonehw.example");
    expect(r.status).toBe("accepted");
    if (r.status !== "accepted") return;
    expect(r.documents.map((d) => d.filename)).toEqual([
      "keystone-55102.pdf",
      "cedar-ridge-7731.png",
    ]);
    expect(r.skipped.map((s) => s.filename)).toEqual(["statement.xlsx"]);
  });

  it("trusts an allowed From header only when the receiving server says it passed DMARC", async () => {
    // Someone who learned the address sends from their own domain as the allowed vendor.
    const vendor = new TextDecoder().decode(eml("from-vendor.eml"));
    const as = (headers: string[]) =>
      receiveForwardedEmail(
        harness.deps(),
        {
          from: "spoofer@attacker.example",
          to: address,
          raw: new TextEncoder().encode(`${headers.map((h) => `${h}\r\n`).join("")}${vendor}`),
        },
        { domain: DOMAIN },
      );
    const pass =
      "Authentication-Results: mx.cloudflare.net; dmarc=pass header.from=keystonehw.example";
    const fail =
      "Authentication-Results: mx.cloudflare.net; dmarc=fail header.from=keystonehw.example";

    expect(await as([])).toMatchObject({ status: "dropped", reason: "sender_not_allowed" });
    expect(await as([fail])).toMatchObject({ status: "dropped", reason: "sender_not_allowed" });
    // A pass the sender wrote themselves sits below the receiving server's header: not read.
    expect(await as([fail, pass])).toMatchObject({
      status: "dropped",
      reason: "sender_not_allowed",
    });
    expect((await as([pass])).status).toBe("accepted");
  });

  it("drops mail from a sender not on the list, and counts it", async () => {
    const before = await stats();
    const r = await receive("unknown-sender.eml", "accounts@unknown-vendor.example");
    expect(r).toEqual({ status: "dropped", tenantId: A.tenantId, reason: "sender_not_allowed" });
    const after = await stats();
    expect(after.dropped).toBe(before.dropped + 1);
    expect(after.lastDropReason).toBe("sender_not_allowed");
    expect(after.accepted).toBe(before.accepted);
  });

  it("drops mail to a guessed or old address, another domain, or a client without forwarding", async () => {
    const guessed = address.replace(/-[a-z2-7]{8}@/, "-aaaaaaaa@");
    expect(
      await receive("forwarded-by-ap.eml", "ap@hollismillwork.example", guessed),
    ).toMatchObject({
      status: "dropped",
      reason: "unknown_address",
    });
    expect(
      await receive("forwarded-by-ap.eml", "ap@hollismillwork.example", "ap@elsewhere.example"),
    ).toMatchObject({ status: "dropped", reason: "not_our_domain" });
    // B has an upload connection but no address yet: nothing reaches B.
    const forB = forwardingAddress({
      tenantId: B.tenantId,
      clientName: "B",
      secret: "abcdefgh",
      domain: DOMAIN,
    });
    expect(await receive("forwarded-by-ap.eml", "ap@hollismillwork.example", forB)).toMatchObject({
      status: "dropped",
      tenantId: B.tenantId,
      reason: "unknown_address",
    });
    const bDocs = await harness.as(B, (tx) =>
      tx.select().from(document).where(eq(document.source, "email")),
    );
    expect(bDocs).toHaveLength(0);
  });

  it("drops a message over the size limit", async () => {
    const big = new Uint8Array(25 * 1024 * 1024 + 1);
    const r = await receiveForwardedEmail(
      harness.deps(),
      { from: "ap@hollismillwork.example", to: address, raw: big },
      { domain: DOMAIN },
    );
    expect(r).toMatchObject({ status: "dropped", reason: "too_large" });
  });
});
