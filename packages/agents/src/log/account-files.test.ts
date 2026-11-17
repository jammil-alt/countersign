// §1.110: a file attached to a message in Sloan's conversation goes with the message when Sloan
// passes it on. An agent that takes Sloan's requests gets the files with the message; an agent
// that starts on documents (Bill clerk, on `document.extracted`) takes them without a `sloan`
// trigger: they are read for it, and the events are addressed to it alone. A file that already
// reached the agents (an upload) is never handed over again.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ContentStore, MemoryObjectStore } from "@countersign/connectors";
import { agent, agentVersion, docExtraction, event, message, run, thread } from "@countersign/db";
import { storeDocument } from "@countersign/documents";
import { withRecording } from "@countersign/llm";
import { DEFAULT_FIXTURE_DIR, fileFixtureStore } from "@countersign/llm/node";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountPassToAgent } from "../tools/account";
import type { ToolInvocation } from "../tools/types";
import { type AccountViews, dbAccountPort } from "./account-port";
import { createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { dbPlatformStore } from "./platform-store";

const h = await createHarness();
afterAll(() => h?.close());

const INVOICE = resolve(DEFAULT_FIXTURE_DIR, "../invoices/northline-20418.pdf");
const RUN = "0192f7a0-0000-7000-8000-00000000c001";
const RUN_UPLOADED = "0192f7a0-0000-7000-8000-00000000c002";

type Workflows = NonNullable<Parameters<typeof makeBundle>[0]>["workflows"];

const on = (slug: string, trigger: Record<string, unknown>) =>
  [
    {
      slug,
      name: slug,
      workflow: { schemaVersion: 3, trigger: { id: `trg-${slug}`, on: trigger }, steps: [] },
    },
  ] as unknown as Workflows;

describe.skipIf(!h)("files passed by Sloan", () => {
  const H = h as Harness;
  const content = new ContentStore(new MemoryObjectStore());
  const transport = withRecording(null, { mode: "replay", store: fileFixtureStore() });
  let sloan: { id: string; versionId: string };
  let desk: { id: string; versionId: string };
  let intake: { id: string; versionId: string };
  let clerk: { id: string; versionId: string };
  let plain: { id: string; versionId: string };
  let chatFile = "";
  let uploaded = "";
  let threadId = "";
  let messageId = "";
  let uploadedMessageId = "";

  async function insertAgent(slug: string, workflows?: Workflows) {
    const [a] = await H.t.db
      .insert(agent)
      .values({ tenantId: H.A.tenantId, kind: "client", slug, name: slug, runStatus: "active" })
      .returning();
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: H.A.tenantId,
        agentId: a?.id as string,
        version: 1,
        bundle: makeBundle(workflows ? { workflows } : {}),
        bundleHash: `files-${slug}`,
        status: "live",
        authorType: "operator",
      })
      .returning();
    await H.t.db
      .update(agent)
      .set({ liveVersionId: v?.id as string })
      .where(eq(agent.id, a?.id as string));
    return { id: a?.id as string, versionId: v?.id as string };
  }

  async function insertRun(id: string, msg: string) {
    await H.t.db.insert(run).values({
      id,
      tenantId: H.A.tenantId,
      agentId: sloan.id,
      agentVersionId: sloan.versionId,
      workflowSlug: "chat",
      mode: "live",
      trigger: {
        type: "event",
        eventType: "thread.message_posted",
        payload: {
          threadId,
          subjectType: "account",
          subjectId: null,
          messageId: msg,
          senderType: "user",
          senderId: H.A.userId,
          audience: "client",
        },
      },
    });
  }

  const emitted: { type: string; payload: unknown }[] = [];
  const port = (reader = true) =>
    dbAccountPort(H.db, {} as AccountViews, {
      emit: async (tx, tenantId, e) => {
        emitted.push({ type: e.type, payload: e.payload });
        await tx.insert(event).values({
          tenantId,
          type: e.type,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          payload: e.payload,
        });
      },
      ...(reader ? { documents: { content, transport } } : {}),
    });

  const pass = (serviceId: string, runId = RUN, reader = true) =>
    accountPassToAgent.run({ serviceId }, {
      tenantId: H.A.tenantId,
      agentId: sloan.id,
      agentVersionId: sloan.versionId,
      runId,
      stepRunId: runId,
      stepId: "answer",
      mode: "live",
      platform: dbPlatformStore(H.db),
      account: port(reader),
    } as ToolInvocation);

  beforeAll(async () => {
    sloan = await insertAgent("supervisor");
    desk = await insertAgent(
      "ap-desk",
      on("take-request", {
        type: "message",
        channels: ["sloan"],
        from: { clientRoles: ["client_admin", "client_user"] },
      }),
    );
    intake = await insertAgent(
      "intake",
      on("on-received", { type: "event", event: "document.received" }),
    );
    clerk = await insertAgent(
      "bill-clerk",
      on("invoice-read", { type: "event", event: "document.extracted" }),
    );
    plain = await insertAgent("reports");
    const bytes = new Uint8Array(readFileSync(INVOICE));
    await H.client(H.A, async (tx) => {
      // Attached in the chat: kept quiet until it's passed on.
      const quiet = await storeDocument(tx, content, {
        tenantId: H.A.tenantId,
        source: "upload",
        connectionId: null,
        bytes,
        filename: "northline-20418.pdf",
        mimeType: "application/pdf",
        meta: { uploadedBy: H.A.userId, via: "chat" },
        announce: false,
      });
      expect(quiet.event).toBeNull();
      chatFile = quiet.document.id;
      // Uploaded the usual way: it already reached the agents that start on documents.
      const loud = await storeDocument(tx, content, {
        tenantId: H.A.tenantId,
        source: "upload",
        connectionId: null,
        bytes: new TextEncoder().encode("%PDF-1.4 another"),
        filename: "other.pdf",
        mimeType: "application/pdf",
      });
      expect(loud.event).not.toBeNull();
      uploaded = loud.document.id;
      const [t] = await tx
        .insert(thread)
        .values({
          tenantId: H.A.tenantId,
          subjectType: "account",
          title: "Account",
          createdBy: H.A.userId,
        })
        .returning();
      threadId = t?.id as string;
      const [m] = await tx
        .insert(message)
        .values({
          tenantId: H.A.tenantId,
          threadId,
          senderType: "user",
          senderId: H.A.userId,
          body: { text: "Can you send this to the bill clerk?", documents: [chatFile] },
          audience: "client",
        })
        .returning();
      messageId = m?.id as string;
      const [m2] = await tx
        .insert(message)
        .values({
          tenantId: H.A.tenantId,
          threadId,
          senderType: "user",
          senderId: H.A.userId,
          body: { text: "And this one", documents: [uploaded] },
          audience: "client",
        })
        .returning();
      uploadedMessageId = m2?.id as string;
    });
    await insertRun(RUN, messageId);
    await insertRun(RUN_UPLOADED, uploadedMessageId);
  });

  it("goes with the message to an agent that takes Sloan's requests", async () => {
    emitted.length = 0;
    const out = await pass(desk.id);
    expect(out).toMatchObject({
      status: "passed",
      files: [{ id: chatFile, name: "northline-20418.pdf" }],
    });
    expect((out as { sources: string[] }).sources).toContain(chatFile);
    expect(emitted).toEqual([
      expect.objectContaining({
        type: "account.request_passed",
        payload: expect.objectContaining({ agentId: desk.id, documents: [chatFile] }),
      }),
    ]);
  });

  it("is handed to an agent that starts on documents, addressed to it alone", async () => {
    emitted.length = 0;
    expect(await pass(intake.id)).toMatchObject({ status: "passed" });
    expect(emitted.map((e) => e.type)).toEqual(["account.request_passed", "document.received"]);
    expect(emitted[1]?.payload).toMatchObject({ documentId: chatFile, forAgentId: intake.id });
  });

  it("is read for Bill clerk, whose `document.extracted` starts only it", async () => {
    emitted.length = 0;
    expect(await pass(clerk.id)).toMatchObject({ status: "passed" });
    const read = await H.t.db
      .select()
      .from(docExtraction)
      .where(eq(docExtraction.documentId, chatFile));
    expect(read).toHaveLength(1);
    const [extracted] = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, H.A.tenantId), eq(event.type, "document.extracted")));
    expect(extracted?.payload).toMatchObject({ documentId: chatFile, forAgentId: clerk.id });
  });

  it("says plainly when files can't be read here, or the agent takes neither", async () => {
    const other = await insertAgent(
      "clerk-two",
      on("invoice-read", { type: "event", event: "document.extracted" }),
    );
    expect(await pass(other.id, RUN, false)).toMatchObject({
      status: "not_accepted",
      reason: expect.stringMatching(/can't read files/),
    });
    expect(await pass(plain.id)).toMatchObject({
      status: "not_accepted",
      reason: expect.stringMatching(/doesn't take files or requests/),
    });
  });

  it("never hands over a file that already reached the agents", async () => {
    emitted.length = 0;
    expect(await pass(intake.id, RUN_UPLOADED)).toMatchObject({
      status: "passed",
      files: [{ id: uploaded, name: "other.pdf" }],
    });
    expect(emitted.map((e) => e.type)).toEqual(["account.request_passed"]);
  });
});
