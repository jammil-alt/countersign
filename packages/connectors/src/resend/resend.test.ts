// The resend connector against the fake: email.send checks the contact in code before Resend is
// called, sends from the connection's address with a tagged reply-to, once per idempotency key;
// provisioning makes a domain with DNS records and a sending key restricted to it; replies are
// parsed to their own words.
import { describe, expect, it } from "vitest";
import type { ConnectionRef } from "../connector";
import { memoryCredentials } from "../credentials-accessor";
import { captureBefore, executeWrite } from "../invoke";
import { noopLogger } from "../logger";
import { utf8 } from "../runtime";
import { parseReplyEmail, replyText } from "../upload/forwarding";
import { FAKE_RESEND_MAIN, fakeResend } from "./fake";
import {
  createDomain,
  createResendConnector,
  createSendingKey,
  EMAIL_SEND_TOOL,
  EmailBlockedError,
  type EmailServices,
  taggedReplyTo,
} from "./index";

const CONN: ConnectionRef = {
  id: "0192f7a0-0000-7000-8000-000000000001",
  tenantId: "0192f7a0-0000-7000-8000-0000000000aa",
  connector: "resend",
  status: "connected",
  externalAccountId: "mail.mezonas.test",
  config: {
    sendingDomain: "mail.mezonas.test",
    localPart: "orders",
    fromName: "Shop orders",
    replyTo: "shop-abc-secret@in.mezonas.test",
  },
  permissions: {},
};

function services(agreed: boolean) {
  const recorded: unknown[] = [];
  const sent = new Map<string, Awaited<ReturnType<EmailServices["sentFor"]>>>();
  const s: EmailServices = {
    async checkSend({ to }) {
      if (to !== "pat@shop.example") return { ok: false, message: "not a contact" };
      return agreed
        ? { ok: true, contact: { id: "c1", name: "Pat Lee" } }
        : { ok: false, message: "this contact hasn't agreed to email" };
    },
    async sentFor(key) {
      return sent.get(key) ?? null;
    },
    async recordOutbound(m) {
      recorded.push(m);
      sent.set(m.idempotencyKey, m.output);
    },
  };
  return { s, recorded };
}

describe("resend connector", () => {
  it("sends from the client's address, once per key, with a tagged reply-to", async () => {
    const resend = fakeResend();
    const key = await createSendingKey(resend.fetch, FAKE_RESEND_MAIN.apiKey, {
      name: "client",
      domainId: null,
    });
    const connector = createResendConnector({ fetch: resend.fetch });
    const { s, recorded } = services(true);
    const ctx = {
      tenantId: CONN.tenantId,
      connection: CONN,
      credentials: memoryCredentials({ apiKey: key }),
      logger: noopLogger,
      now: () => new Date("2026-11-04T15:00:00.000Z"),
      services: { email: s },
    };
    const input = {
      to: "Pat@Shop.example",
      subject: "Friday's delivery",
      text: "Can you confirm Friday?",
      replyTag: "0192f7a0000070008000000000000001",
    };
    const before = await captureBefore(connector, EMAIL_SEND_TOOL, input, ctx);
    expect(before.before).toEqual({
      contact: { id: "c1", name: "Pat Lee" },
      to: "pat@shop.example",
      from: "orders@mail.mezonas.test",
    });
    const w = { ...ctx, idempotencyKey: "run:reach:reach:0" };
    const r = await executeWrite(connector, EMAIL_SEND_TOOL, input, w);
    expect(r.output).toMatchObject({
      to: "pat@shop.example",
      from: "orders@mail.mezonas.test",
      replyTo: "shop-abc-secret+0192f7a0000070008000000000000001@in.mezonas.test",
      contactName: "Pat Lee",
    });
    expect(resend.emails).toHaveLength(1);
    expect(resend.emails[0]).toMatchObject({
      from: "Shop orders <orders@mail.mezonas.test>",
      to: ["pat@shop.example"],
      idempotencyKey: "run:reach:reach:0",
    });
    // A re-run with the same key returns the recorded email and sends nothing.
    await executeWrite(connector, EMAIL_SEND_TOOL, input, w);
    expect(resend.emails).toHaveLength(1);
    expect(recorded).toHaveLength(1);
  });

  it("refuses a contact without email consent, before Resend is called", async () => {
    const resend = fakeResend();
    const connector = createResendConnector({ fetch: resend.fetch });
    const ctx = {
      tenantId: CONN.tenantId,
      connection: CONN,
      credentials: memoryCredentials({ apiKey: FAKE_RESEND_MAIN.apiKey }),
      logger: noopLogger,
      now: () => new Date(),
      services: { email: services(false).s },
      idempotencyKey: "k",
    };
    const input = { to: "pat@shop.example", subject: "Hi", text: "Hello" };
    await expect(captureBefore(connector, EMAIL_SEND_TOOL, input, ctx)).rejects.toThrow(
      "hasn't agreed to email",
    );
    await expect(executeWrite(connector, EMAIL_SEND_TOOL, input, ctx)).rejects.toBeInstanceOf(
      EmailBlockedError,
    );
    expect(resend.emails).toHaveLength(0);
  });

  it("makes a domain with DNS records and a key that sends only from it", async () => {
    const resend = fakeResend();
    const d = await createDomain(resend.fetch, FAKE_RESEND_MAIN.apiKey, "shop.example");
    expect(d.records.map((r) => r.type)).toEqual(["MX", "TXT"]);
    const key = await createSendingKey(resend.fetch, FAKE_RESEND_MAIN.apiKey, {
      name: "shop",
      domainId: d.id,
    });
    expect(resend.keys.get(key)).toBe("shop.example");
    // A sending key can't make domains.
    await expect(createDomain(resend.fetch, key, "other.example")).rejects.toThrow("403");
  });

  it("tags reply-to addresses and parses a reply to its own words", async () => {
    expect(taggedReplyTo("a-b-c@in.x", "abc123")).toBe("a-b-c+abc123@in.x");
    expect(taggedReplyTo(null, "abc123")).toBeNull();
    expect(replyText("Yes, Friday.\n\nOn Tue, Orders wrote:\n> Can you?")).toBe("Yes, Friday.");
    // Gmail's line above the quote, in each of the portal's languages.
    for (const line of [
      "El mar, 5 nov 2026 a las 15:00, Pat Lee (<pat.lee@gmail.test>) escribió:",
      "Le mar. 5 nov. 2026 à 15:00, Pat Lee <pat.lee@gmail.test> a écrit :",
      "Em ter., 5 de nov. de 2026 às 15:00, Pat Lee <pat.lee@gmail.test> escreveu:",
      "Il giorno mar 5 nov 2026 alle ore 15:00 Pat Lee <pat.lee@gmail.test> ha scritto:",
      "Am Di., 5. Nov. 2026 um 15:00 Uhr schrieb Pat Lee <pat.lee@gmail.test>:",
    ]) {
      expect(replyText(`Sí, el viernes.\n\n${line}\nHola`)).toBe("Sí, el viernes.");
    }
    // A sentence of the reply that happens to start alike stays.
    expect(replyText("El pedido llega el viernes.")).toBe("El pedido llega el viernes.");
    const raw = utf8(
      [
        "From: Pat <pat@shop.example>",
        "To: a-b-c+abc123@in.x",
        "Subject: Re: Friday",
        "In-Reply-To: <run.reach.0@mail.mezonas.test>",
        "References: <run.reach.0@mail.mezonas.test>",
        "Content-Type: text/plain",
        "",
        "Works for us.",
        "> quoted",
      ].join("\r\n"),
    );
    const r = await parseReplyEmail(raw);
    expect(r).toMatchObject({
      from: "pat@shop.example",
      inReplyTo: "<run.reach.0@mail.mezonas.test>",
      references: ["<run.reach.0@mail.mezonas.test>"],
      text: "Works for us.",
    });
  });
});
