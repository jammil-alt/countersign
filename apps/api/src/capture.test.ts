// v0.14 capture: WhatsApp passive capture through the running app, against the fake Twilio with
// media (ARCHITECTURE §6.12, docs/plan.md §1.55, M33). A photo from a contact whose conversation
// has attachments on becomes one document, read and linked to its message; with it off, only the
// attachment's existence is kept; a retried webhook or step makes nothing twice; size and type are
// refused; "download now"; the client admin and the operator change capture with change rows, a
// client user can't; clients stay apart; the portal carries no bundle, prompt, cost or link.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createTwilioConnector,
  formEncode,
  generateEncryptionKey,
  parseUrl,
} from "@countersign/connectors";
import { FAKE_TWILIO_MAIN, fakeTwilio } from "@countersign/connectors/testing";
import { AgentBundle, type AgentBundleInput } from "@countersign/core";
import {
  agent,
  conversation,
  conversationChange,
  document,
  event,
  rawRecord,
  tenantChange,
} from "@countersign/db";
import { DEFAULT_FIXTURE_DIR } from "@countersign/llm/node";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  user,
} from "./api.test-helper";
import { MESSAGE_MEDIA_ENTITY } from "./conversations/capture";
import { CAPTURE_CRON_MINUTE, captureCronTick } from "./conversations/cron";
import {
  type CaptureParams,
  captureOne,
  inlineCaptureSteps,
  runCapture,
} from "./conversations/media";
import { captureDepsFor } from "./conversations/start";
import { defaultDeps } from "./http";
import { dbMessagingServices } from "./messaging/services";
import { quietNever } from "./quiet-hours.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const ENCRYPTION_KEY = generateEncryptionKey();
const ORIGIN = "https://app.mezonas.test";
const twilio = fakeTwilio();
const PAT = "+15555550100";
const SAM = "+15555550122";
const PHOTO = new Uint8Array(
  readFileSync(resolve(DEFAULT_FIXTURE_DIR, "..", "invoices", "cedar-ridge-7731.png")),
);
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** A small PNG-looking file with its own bytes (another sha256 each time). */
const png = (n: number, fill = 7) => {
  const b = new Uint8Array(n).fill(fill);
  b.set(PNG_HEAD);
  return b;
};

const h = await createApiHarness({
  connectors: () => [createTwilioConnector({ fetch: twilio.fetch })],
  env: {
    ENCRYPTION_KEY,
    APP_ORIGIN: ORIGIN,
    TWILIO_ACCOUNT_SID: FAKE_TWILIO_MAIN.accountSid,
    TWILIO_AUTH_TOKEN: FAKE_TWILIO_MAIN.authToken,
  },
  fetch: twilio.fetch,
});
afterAll(() => h?.close());

function bundle(name: string, workflow: unknown): AgentBundle {
  return AgentBundle.parse({
    schemaVersion: 1,
    definition: {
      schemaVersion: 2,
      identity: { name, role: "files what suppliers send", mission: "keep the books tidy" },
      kind: "functional",
      model: { id: "claude-opus-5-5", maxTokens: 1024 },
      instructions: "Only do what the workflow says.",
      skills: [],
      extraTools: [],
      canCommand: [],
      permissions: { mode: "suggest_only" },
      budgets: { maxSteps: 4, maxCostUsd: "0.10" },
      memory: { enabled: false },
    },
    workflows: [{ slug: "main", name: "Main", workflow }],
  } as AgentBundleInput);
}

describe.skipIf(!h)("WhatsApp passive capture", () => {
  const H = h as ApiHarness;
  const A = () => H.A.tenantId;
  const ops = (path = "") => `/api/ops/clients/${A()}${path}`;
  let setup: ReturnType<typeof j> = null;
  let number = "";
  let patId = "";

  async function photoIn(
    from: string,
    media: NonNullable<Parameters<typeof twilio.inbound>[0]["media"]>,
    body = "Here is the invoice",
  ) {
    const msg = await twilio.inbound({
      account: setup.twilio.subaccountSid,
      from,
      to: number,
      body,
      url: setup.webhooks.messages,
      channel: "whatsapp",
      media,
    });
    const res = await H.call(
      null,
      "POST",
      setup.webhooks.messages.replace(ORIGIN, ""),
      formEncode(msg.params),
      {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": msg.signature,
      },
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await H.settle();
    return msg;
  }

  const rawOf = async (sid: string) => {
    const [r] = await H.t.db
      .select()
      .from(rawRecord)
      .where(and(eq(rawRecord.tenantId, A()), eq(rawRecord.externalId, sid)));
    return r;
  };
  const outcomesOf = (sid: string) =>
    H.t.db
      .select()
      .from(rawRecord)
      .where(
        and(
          eq(rawRecord.tenantId, A()),
          eq(rawRecord.entityType, MESSAGE_MEDIA_ENTITY),
          eq(rawRecord.externalId, `${sid}:0`),
        ),
      );
  const docsOf = (sid: string) =>
    H.t.db
      .select()
      .from(document)
      .where(and(eq(document.tenantId, A()), eq(document.filename, `whatsapp-${sid}-0.png`)));
  const patConversation = async () => {
    const list = await H.call(admin("a"), "GET", "/api/conversations");
    expect(list.status, JSON.stringify(list.json)).toBe(200);
    return j(list.json).items.find((c: { contact: { id: string } }) => c.contact?.id === patId);
  };

  beforeAll(async () => {
    const q = await H.call(OPERATOR, "PUT", ops("/messaging"), {
      quietHours: quietNever(),
    });
    expect(q.status, JSON.stringify(q.json)).toBe(200);
    await H.call(OPERATOR, "POST", ops("/messaging/twilio"));
    const bought = await H.call(OPERATOR, "POST", ops("/messaging/numbers"), {
      phoneNumber: "+15125550101",
    });
    setup = j(bought.json).setup;
    number = setup.twilio.numbers[0].phoneNumber;
    const wa = await H.call(
      OPERATOR,
      "PUT",
      ops(`/messaging/numbers/${setup.twilio.numbers[0].sid}/whatsapp`),
      { enabled: true },
    );
    setup = j(wa.json).setup;
    const pat = await H.call(OPERATOR, "POST", ops("/contacts"), {
      name: "Pat Lee",
      whatsapp: PAT,
      roles: ["supplier"],
    });
    expect(pat.status, JSON.stringify(pat.json)).toBe(200);
    patId = j(pat.json).contact.id;
  });

  it("with attachments off (the default), keeps only that an attachment existed", async () => {
    const msg = await photoIn(PAT, [{ contentType: "image/png", bytes: PHOTO }]);
    const conv = await patConversation();
    expect(conv).toMatchObject({
      kind: "direct",
      channel: "whatsapp",
      capture: { archive: true, attachments: "off", maxBytes: 20 * 1024 * 1024 },
    });
    const raw = await rawOf(msg.sid);
    expect(raw?.payload).toMatchObject({
      text: "Here is the invoice",
      media: [{ index: 0, contentType: "image/png", mediaSid: msg.mediaSids[0] }],
      capture: { conversationId: conv.id, archive: true, wanted: [] },
    });
    // Never the link, never the bytes; nothing fetched, no document.
    expect(JSON.stringify(raw?.payload)).not.toContain("https://");
    expect(twilio.mediaRequests()).toHaveLength(0);
    expect(await outcomesOf(msg.sid)).toHaveLength(0);
    expect(await docsOf(msg.sid)).toHaveLength(0);
    const msgs = await H.call(admin("a"), "GET", `/api/conversations/${conv.id}/messages`);
    expect(j(msgs.json).items[0].attachments).toEqual([
      {
        index: 0,
        contentType: "image/png",
        sizeBytes: null,
        status: "not_downloaded",
        documentId: null,
      },
    ]);
  });

  it("lets the client admin and the operator change capture, each logged; a client user can't", async () => {
    let conv = await patConversation();
    // A client user (not admin) has no access at all.
    expect((await H.call(user("a"), "GET", "/api/conversations")).status).toBe(403);
    expect(
      (
        await H.call(user("a"), "PUT", `/api/conversations/${conv.id}/capture`, {
          attachments: "documents",
          updatedAt: conv.updatedAt,
        })
      ).status,
    ).toBe(403);
    // The client admin turns attachments on.
    const on = await H.call(admin("a"), "PUT", `/api/conversations/${conv.id}/capture`, {
      attachments: "documents",
      updatedAt: conv.updatedAt,
    });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    expect(j(on.json).conversation.capture.attachments).toBe("documents");
    // An old read is stale; the same setting again is no change.
    const stale = await H.call(admin("a"), "PUT", `/api/conversations/${conv.id}/capture`, {
      archive: false,
      updatedAt: conv.updatedAt,
    });
    expect([stale.status, j(stale.json).error.code]).toEqual([409, "stale"]);
    conv = j(on.json).conversation;
    const same = await H.call(admin("a"), "PUT", `/api/conversations/${conv.id}/capture`, {
      attachments: "documents",
      updatedAt: conv.updatedAt,
    });
    expect([same.status, j(same.json).error.code]).toEqual([409, "no_op"]);
    // The operator may turn it off and on again too, with a reason.
    const opsList = await H.call(OPERATOR, "GET", ops("/conversations"));
    const opsConv = j(opsList.json).items.find((c: { id: string }) => c.id === conv.id);
    const off = await H.call(OPERATOR, "PUT", ops(`/conversations/${conv.id}/capture`), {
      capture: { ...opsConv.capture, attachments: "off" },
      reason: "client asked by phone",
      updatedAt: opsConv.updatedAt,
    });
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    const back = await H.call(OPERATOR, "PUT", ops(`/conversations/${conv.id}/capture`), {
      capture: { ...opsConv.capture, attachments: "documents" },
      updatedAt: j(off.json).conversation.updatedAt,
    });
    expect(back.status, JSON.stringify(back.json)).toBe(200);
    const rows = await H.t.db
      .select()
      .from(conversationChange)
      .where(eq(conversationChange.conversationId, conv.id));
    expect(rows.map((r) => r.side).sort()).toEqual(["client", "operator", "operator"]);
    expect(rows.find((r) => r.side === "client")?.change).toMatchObject({
      setting: "capture",
      before: { attachments: "off" },
      after: { attachments: "documents" },
    });
    // The portal names the operator's side "us"; the back office names the person.
    const portalLog = await H.call(admin("a"), "GET", `/api/conversations/${conv.id}/changes`);
    expect(j(portalLog.json).items.map((i: { by: string }) => i.by)).toContain("us");
    const opsLog = await H.call(OPERATOR, "GET", ops(`/conversations/${conv.id}/changes`));
    expect(
      j(opsLog.json).items.some((i: { reason: string }) => i.reason === "client asked by phone"),
    ).toBe(true);
  });

  it("with attachments on, files a photo as one document, read and linked to its message", async () => {
    const msg = await photoIn(PAT, [{ contentType: "image/png", bytes: PHOTO }]);
    const [outcome] = await outcomesOf(msg.sid);
    expect(outcome?.payload).toMatchObject({ status: "filed", contentType: "image/png" });
    const docs = await docsOf(msg.sid);
    expect(docs).toHaveLength(1);
    const doc = docs[0];
    const raw = await rawOf(msg.sid);
    expect(doc).toMatchObject({
      source: "message",
      mimeType: "image/png",
      sizeBytes: PHOTO.length,
    });
    expect(doc?.meta).toMatchObject({
      channel: "whatsapp",
      rawRecordId: raw?.id,
      messageSid: msg.sid,
      mediaIndex: 0,
      contactId: patId,
    });
    expect(outcome?.payload).toMatchObject({ documentId: doc?.id });
    // document.received fired once; the background reading read it (replayed model).
    const received = await H.t.db
      .select()
      .from(event)
      .where(
        and(
          eq(event.tenantId, A()),
          eq(event.type, "document.received"),
          eq(event.subjectId, doc?.id ?? ""),
        ),
      );
    expect(received).toHaveLength(1);
    const view = await H.call(admin("a"), "GET", `/api/documents/${doc?.id}`);
    expect(j(view.json).document.status).toBe("extracted");
    // The message shows the attachment, filed, with its document.
    const conv = await patConversation();
    const msgs = await H.call(admin("a"), "GET", `/api/conversations/${conv.id}/messages`);
    const line = j(msgs.json).items.find((m: { sid: string }) => m.sid === msg.sid);
    expect(line.attachments).toEqual([
      {
        index: 0,
        contentType: "image/png",
        sizeBytes: PHOTO.length,
        status: "filed",
        documentId: doc?.id,
      },
    ]);
    // The agents' tools see the same, with no link.
    const facts = await dbMessagingServices(H.db, {
      id: setup.twilio.connectionId,
      tenantId: A(),
      connector: "twilio",
      status: "connected",
      externalAccountId: null,
      config: {},
      permissions: {} as never,
    }).messageFacts?.([msg.sid]);
    expect(facts?.get(msg.sid)).toMatchObject({
      kept: true,
      conversation: { id: conv.id, kind: "direct" },
      attachments: [{ status: "filed", documentId: doc?.id }],
    });

    // A retried webhook: acknowledged, nothing fetched or filed again.
    const fetched = twilio.mediaRequests().length;
    const res = await H.call(
      null,
      "POST",
      setup.webhooks.messages.replace(ORIGIN, ""),
      formEncode(msg.params),
      { "content-type": "application/x-www-form-urlencoded", "x-twilio-signature": msg.signature },
    );
    expect(res.status).toBe(200);
    await H.settle();
    // A retried step (the Workflow replaying it after a crash): the outcome stands.
    const deps = captureDepsFor({
      db: H.db,
      env: H.env,
      deps: {
        ...defaultDeps,
        objects: () => H.objects,
        instances: () => H.instances,
        fetch: () => twilio.fetch,
        extractionTransport: () => null,
      },
      platform: H.platform,
    });
    const again = await captureOne(
      deps,
      {
        tenantId: A(),
        connectionId: setup.twilio.connectionId,
        rawRecordId: raw?.id ?? "",
        messageSid: msg.sid,
        indexes: [0],
        reason: "restart",
      },
      0,
    );
    expect(again).toMatchObject({ status: "filed", documentId: doc?.id });
    expect(twilio.mediaRequests().length).toBe(fetched);
    expect(await docsOf(msg.sid)).toHaveLength(1);
    expect(await outcomesOf(msg.sid)).toHaveLength(1);
  });

  it("refuses files over the limit and types the setting doesn't take or that don't match", async () => {
    const conv = await patConversation();
    const opsList = await H.call(OPERATOR, "GET", ops("/conversations"));
    const c = j(opsList.json).items.find((x: { id: string }) => x.id === conv.id);
    const small = await H.call(OPERATOR, "PUT", ops(`/conversations/${conv.id}/capture`), {
      capture: { ...c.capture, maxBytes: 1000 },
      updatedAt: c.updatedAt,
    });
    expect(small.status, JSON.stringify(small.json)).toBe(200);
    const big = await photoIn(PAT, [{ contentType: "image/png", bytes: png(5000, 1) }]);
    expect((await outcomesOf(big.sid))[0]?.payload).toMatchObject({
      status: "refused",
      reason: "too_large",
    });
    const chunked = await photoIn(PAT, [
      { contentType: "image/png", bytes: png(5000, 2), noLength: true },
    ]);
    expect((await outcomesOf(chunked.sid))[0]?.payload).toMatchObject({
      status: "refused",
      reason: "too_large",
    });
    // Declared as a PNG, but it isn't one.
    const fake = await photoIn(PAT, [
      { contentType: "image/png", bytes: new Uint8Array([60, 104, 116, 109, 108]) },
    ]);
    expect((await outcomesOf(fake.sid))[0]?.payload).toMatchObject({
      status: "refused",
      reason: "type_mismatch",
    });
    // A zip is never wanted: not fetched at all.
    const before = twilio.mediaRequests().length;
    const zip = await photoIn(PAT, [
      { contentType: "application/zip", bytes: new Uint8Array([1, 2]) },
    ]);
    expect(twilio.mediaRequests().length).toBe(before);
    expect((await rawOf(zip.sid))?.payload).toMatchObject({ capture: { wanted: [] } });
    // A redirect off Twilio's list fails without fetching it.
    const odd = await photoIn(PAT, [
      { contentType: "image/png", bytes: png(100, 3), redirectTo: "https://evil.example/x" },
    ]);
    expect((await outcomesOf(odd.sid))[0]?.payload).toMatchObject({
      status: "failed",
      reason: "redirect_refused",
    });
    expect(twilio.requests.some((r) => parseUrl(r.url)?.origin === "https://evil.example")).toBe(
      false,
    );
    // Nothing refused became a document.
    for (const m of [big, chunked, fake, odd]) expect(await docsOf(m.sid)).toHaveLength(0);
  });

  it("downloads now only when the conversation's setting allows it", async () => {
    // Someone new: their conversation starts with downloads off, whatever the default.
    const setDefault = await H.call(OPERATOR, "PUT", ops("/conversations/default"), {
      capture: { archive: true, attachments: "documents", maxBytes: 20 * 1024 * 1024 },
      reason: "client wants invoices filed",
    });
    expect(setDefault.status, JSON.stringify(setDefault.json)).toBe(200);
    const [defaultChange] = await H.t.db
      .select()
      .from(tenantChange)
      .where(eq(tenantChange.tenantId, A()));
    expect(defaultChange).toBeDefined();
    const msg = await photoIn(SAM, [{ contentType: "image/png", bytes: png(300, 9) }], "hello");
    const list = await H.call(admin("a"), "GET", "/api/conversations");
    const sam = j(list.json).items.find((c: { title: string }) => c.title === SAM);
    expect(sam.capture.attachments).toBe("off");
    const [sys] = await H.t.db
      .select()
      .from(conversationChange)
      .where(eq(conversationChange.conversationId, sam.id));
    expect(sys?.side).toBe("system");
    const raw = await rawOf(msg.sid);
    const path = `/api/conversations/${sam.id}/messages/${raw?.id}/download`;
    const refused = await H.call(admin("a"), "POST", path);
    expect([refused.status, j(refused.json).error.code]).toEqual([409, "capture_off"]);
    const on = await H.call(admin("a"), "PUT", `/api/conversations/${sam.id}/capture`, {
      attachments: "documents",
      updatedAt: sam.updatedAt,
    });
    expect(on.status).toBe(200);
    const now = await H.call(admin("a"), "POST", path);
    expect(now.status, JSON.stringify(now.json)).toBe(200);
    expect(j(now.json)).toEqual({ started: [0], done: [] });
    await H.settle();
    expect(await docsOf(msg.sid)).toHaveLength(1);
    // Again: done, nothing new.
    const twice = await H.call(
      OPERATOR,
      "POST",
      ops(`/conversations/${sam.id}/messages/${raw?.id}/download`),
    );
    expect(j(twice.json)).toEqual({ started: [], done: [0] });
    await H.settle();
    expect(await docsOf(msg.sid)).toHaveLength(1);
  });

  it("keeps no text when archiving is off, and starts the conversation's agent once with the documents", async () => {
    // An agent that starts on WhatsApp messages from suppliers.
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${A()}/agents`, {
      slug: "filer",
      bundle: bundle("Filer", {
        schemaVersion: 3,
        trigger: {
          id: "msg",
          on: { type: "message", channels: ["whatsapp"], from: { tags: ["supplier"] } },
        },
        steps: [],
      }),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const agentId = j(created.json).agent.id as string;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${j(created.json).version.id}/publish`,
    );
    await H.t.db.update(agent).set({ runStatus: "active" }).where(eq(agent.id, agentId));
    const conv = await patConversation();
    const opsList = await H.call(OPERATOR, "GET", ops("/conversations"));
    const c = j(opsList.json).items.find((x: { id: string }) => x.id === conv.id);
    // The client admin can't name an agent; the operator can, only a fitting one.
    const notOurs = await H.call(OPERATOR, "PUT", ops(`/conversations/${conv.id}/capture`), {
      capture: { ...c.capture, agentId: H.B.tenantId },
      updatedAt: c.updatedAt,
    });
    expect([notOurs.status, j(notOurs.json).error.code]).toEqual([422, "invalid_agent"]);
    const set = await H.call(OPERATOR, "PUT", ops(`/conversations/${conv.id}/capture`), {
      capture: { ...c.capture, archive: false, maxBytes: 20 * 1024 * 1024, agentId },
      updatedAt: c.updatedAt,
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(j(set.json).conversation.agentName).toBe("Filer");
    const portal = await H.call(admin("a"), "GET", "/api/conversations");
    expect(JSON.stringify(portal.json)).not.toContain(agentId);

    const msg = await photoIn(
      PAT,
      [{ contentType: "image/png", bytes: png(400, 5) }],
      "secret words",
    );
    const raw = await rawOf(msg.sid);
    expect(raw?.payload).toMatchObject({ text: "", capture: { archive: false } });
    expect(JSON.stringify(raw?.payload)).not.toContain("secret words");
    const [doc] = await docsOf(msg.sid);
    const inbound = await H.t.db
      .select()
      .from(event)
      .where(
        and(
          eq(event.tenantId, A()),
          eq(event.type, "inbound.message"),
          eq(event.subjectId, raw?.id ?? ""),
        ),
      );
    expect(inbound).toHaveLength(1);
    expect(inbound[0]?.payload).toMatchObject({
      agentId,
      channel: "whatsapp",
      contactId: patId,
      documents: [doc?.id],
    });
    expect([...H.instances.started.values()].filter((r) => r.agentId === agentId)).toHaveLength(1);
  });

  it("downloads now a message kept before v0.14 (with Twilio's link), reading only its media SID", async () => {
    const conv = await patConversation();
    const msg = await twilio.inbound({
      account: setup.twilio.subaccountSid,
      from: PAT,
      to: number,
      body: "old one",
      url: setup.webhooks.messages,
      channel: "whatsapp",
      media: [{ contentType: "image/png", bytes: png(700, 6) }],
    });
    const [old] = await H.t.db
      .insert(rawRecord)
      .values({
        tenantId: A(),
        connectionId: setup.twilio.connectionId,
        connector: "twilio",
        entityType: "Message",
        externalId: msg.sid,
        externalVersion: null,
        payload: {
          direction: "in",
          channel: "whatsapp",
          from: PAT,
          to: number,
          text: "old one",
          numMedia: 1,
          media: [{ url: msg.params.MediaUrl0, contentType: "image/png" }],
        },
      })
      .returning();
    const res = await H.call(
      admin("a"),
      "POST",
      `/api/conversations/${conv.id}/messages/${old?.id}/download`,
    );
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    await H.settle();
    expect(await docsOf(msg.sid)).toHaveLength(1);
    // Another contact's conversation can't claim it.
    const list = await H.call(admin("a"), "GET", "/api/conversations");
    const other = j(list.json).items.find((c: { id: string }) => c.id !== conv.id);
    const wrong = await H.call(
      admin("a"),
      "POST",
      `/api/conversations/${other.id}/messages/${old?.id}/download`,
    );
    expect(wrong.status).toBe(404);
  });

  it("leaves a download pending while Twilio is down, and the cron's restart files it once", async () => {
    const msg = await photoIn(PAT, [
      { contentType: "image/png", bytes: png(600, 4), failWith: 503 },
    ]);
    expect(await outcomesOf(msg.sid)).toHaveLength(0);
    const mediaSid = msg.mediaSids[0] ?? "";
    const stored = twilio.media.get(mediaSid);
    if (stored) delete stored.failWith;
    // Ten minutes later, at the cron's minute.
    const at = new Date(Date.now() + 11 * 60 * 1000);
    while (at.getUTCMinutes() % 10 !== CAPTURE_CRON_MINUTE)
      at.setUTCMinutes(at.getUTCMinutes() + 1);
    const started: CaptureParams[] = [];
    const jobs = {
      start: async (p: CaptureParams) => {
        started.push(p);
        return "started" as const;
      },
    };
    expect(await captureCronTick(H.db, jobs, at)).toBe(1);
    expect(started[0]).toMatchObject({ messageSid: msg.sid, indexes: [0], reason: "restart" });
    const deps = captureDepsFor({
      db: H.db,
      env: H.env,
      deps: {
        ...defaultDeps,
        objects: () => H.objects,
        instances: () => H.instances,
        fetch: () => twilio.fetch,
        extractionTransport: () => null,
      },
      platform: H.platform,
    });
    await runCapture(deps, started[0] as CaptureParams, inlineCaptureSteps);
    expect(await docsOf(msg.sid)).toHaveLength(1);
    // Nothing is pending any more.
    expect(await captureCronTick(H.db, jobs, at)).toBe(0);
  });

  it("keeps every client's conversations to itself, and the portal carries nothing it shouldn't", async () => {
    const conv = await patConversation();
    expect((await H.call(admin("b"), "GET", `/api/conversations/${conv.id}/changes`)).status).toBe(
      404,
    );
    expect(
      (
        await H.call(admin("b"), "PUT", `/api/conversations/${conv.id}/capture`, {
          archive: true,
          updatedAt: conv.updatedAt,
        })
      ).status,
    ).toBe(404);
    expect(j((await H.call(admin("b"), "GET", "/api/conversations")).json).items).toEqual([]);
    // The operator through B's path can't reach A's conversation.
    expect(
      (
        await H.call(
          OPERATOR,
          "GET",
          `/api/ops/clients/${H.B.tenantId}/conversations/${conv.id}/changes`,
        )
      ).status,
    ).toBe(404);
    const rows = await H.t.db
      .select()
      .from(conversation)
      .where(eq(conversation.tenantId, H.B.tenantId));
    expect(rows).toEqual([]);
    for (const path of [
      "/api/conversations",
      `/api/conversations/${conv.id}/messages`,
      `/api/conversations/${conv.id}/changes`,
    ]) {
      const res = await H.call(admin("a"), "GET", path);
      expect(res.status, path).toBe(200);
      expect(forbiddenKeys(res.json), path).toEqual([]);
      expect(JSON.stringify(res.json), path).not.toMatch(
        /twilio\.com|twiliocdn|agentId|instructions/,
      );
    }
  });
});
