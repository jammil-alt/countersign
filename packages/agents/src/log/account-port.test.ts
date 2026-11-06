// Sloan's `account.pass_to_agent` over the database (ARCHITECTURE §9.8, §10.8; docs/plan.md
// §1.47): the asker, thread and message come from the run's trigger; only an agent of the same
// client whose live version has a `sloan` message trigger taking the asker gets the request, as
// one `account.request_passed` event in the tool's transaction; a test run passes nothing.

import { agent, agentVersion, event, run } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountPassToAgent } from "../tools/account";
import type { ToolInvocation } from "../tools/types";
import { type AccountViews, dbAccountPort } from "./account-port";
import { type Client, createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { dbPlatformStore } from "./platform-store";

const h = await createHarness();

const ADMIN_RUN = "0192f7a0-0000-7000-8000-00000000b001";
const USER_RUN = "0192f7a0-0000-7000-8000-00000000b002";
const TEST_RUN = "0192f7a0-0000-7000-8000-00000000b003";
const THREAD = "0192f7a0-0000-7000-8000-00000000b101";
const ADMIN_MESSAGE = "0192f7a0-0000-7000-8000-00000000b201";
const USER_MESSAGE = "0192f7a0-0000-7000-8000-00000000b202";

/** A workflow that starts when Sloan passes a request from the client admins. */
const sloanWorkflow = () => [
  {
    slug: "take-request",
    name: "Take a request",
    workflow: {
      schemaVersion: 3 as const,
      trigger: {
        id: "trg-sloan",
        on: {
          type: "message" as const,
          channels: ["sloan" as const],
          from: { clientRoles: ["client_admin" as const] },
        },
      },
      steps: [],
    },
  },
];

describe.skipIf(!h)("account.pass_to_agent", () => {
  const H = h as Harness;
  let sloan: { id: string; versionId: string };
  let desk: { id: string; versionId: string };
  let clerk: { id: string; versionId: string };
  let paused: { id: string; versionId: string };
  let theirs: { id: string; versionId: string };

  async function insertAgent(
    c: Client,
    slug: string,
    workflows?: ReturnType<typeof sloanWorkflow>,
    runStatus: (typeof agent.$inferInsert)["runStatus"] = "active",
  ) {
    const [a] = await H.t.db
      .insert(agent)
      .values({ tenantId: c.tenantId, kind: "client", slug, name: slug, runStatus })
      .returning();
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: c.tenantId,
        agentId: a?.id as string,
        version: 1,
        bundle: makeBundle(workflows ? { workflows } : {}),
        bundleHash: `h-${c.tenantId}-${slug}`,
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

  /** Sloan's run, started by a client person's message in an account thread. */
  async function insertRun(id: string, senderId: string, messageId: string, mode = "live") {
    await H.t.db.insert(run).values({
      id,
      tenantId: H.A.tenantId,
      agentId: sloan.id,
      agentVersionId: sloan.versionId,
      workflowSlug: "chat",
      mode: mode as "live" | "test",
      trigger: {
        type: "event",
        eventType: "thread.message_posted",
        payload: {
          threadId: THREAD,
          subjectType: "account",
          subjectId: null,
          messageId,
          senderType: "user",
          senderId,
          audience: "client",
        },
      },
    });
  }

  const emitted: { type: string; subjectId: string | null; payload: unknown }[] = [];
  // The views are the portal's (apps/api); passing to an agent needs none of them.
  const port = () =>
    dbAccountPort(H.db, {} as AccountViews, {
      emit: async (tx, tenantId, e) => {
        emitted.push({ type: e.type, subjectId: e.subjectId, payload: e.payload });
        await tx.insert(event).values({
          tenantId,
          type: e.type,
          subjectType: e.subjectType,
          subjectId: e.subjectId,
          payload: e.payload,
        });
      },
    });

  const ctx = (runId: string, extra: Partial<ToolInvocation> = {}): ToolInvocation => ({
    tenantId: H.A.tenantId,
    agentId: sloan.id,
    agentVersionId: sloan.versionId,
    runId,
    stepRunId: runId,
    stepId: "answer",
    mode: "live",
    platform: dbPlatformStore(H.db),
    account: port(),
    ...extra,
  });

  const pass = (serviceId: string, runId = ADMIN_RUN, extra: Partial<ToolInvocation> = {}) =>
    accountPassToAgent.run({ serviceId }, ctx(runId, extra));

  beforeAll(async () => {
    sloan = await insertAgent(H.A, "supervisor");
    desk = await insertAgent(H.A, "ap-desk", sloanWorkflow());
    clerk = await insertAgent(H.A, "bill-clerk");
    paused = await insertAgent(H.A, "night-desk", sloanWorkflow(), "paused");
    theirs = await insertAgent(H.B, "ap-desk", sloanWorkflow());
    await insertRun(ADMIN_RUN, H.A.adminId, ADMIN_MESSAGE);
    await insertRun(USER_RUN, H.A.userId, USER_MESSAGE);
    await insertRun(TEST_RUN, H.A.adminId, ADMIN_MESSAGE, "test");
  });
  afterAll(async () => {
    await H?.close();
  });

  it("passes the asker's message to an agent that accepts Sloan, once", async () => {
    emitted.length = 0;
    const out = await pass(desk.id);
    expect(out).toEqual({
      status: "passed",
      reason: null,
      messageId: ADMIN_MESSAGE,
      sources: [desk.id, ADMIN_MESSAGE],
    });
    // The person, thread and message come from the run's trigger, never from the model.
    expect(emitted).toEqual([
      {
        type: "account.request_passed",
        subjectId: THREAD,
        payload: {
          agentId: desk.id,
          threadId: THREAD,
          messageId: ADMIN_MESSAGE,
          userId: H.A.adminId,
        },
      },
    ]);
    const rows = await H.t.db
      .select()
      .from(event)
      .where(and(eq(event.tenantId, H.A.tenantId), eq(event.type, "account.request_passed")));
    expect(rows).toHaveLength(1);
    // The same message to the same agent again starts nothing more.
    expect(await pass(desk.id)).toMatchObject({ status: "already_passed" });
    expect(emitted).toHaveLength(1);
  });

  it("answers plainly when the agent doesn't take the request", async () => {
    emitted.length = 0;
    expect(await pass(clerk.id)).toMatchObject({
      status: "not_accepted",
      reason: expect.stringMatching(/doesn't take requests from Sloan/),
      messageId: null,
    });
    // Its People filter takes client admins only.
    expect(await pass(desk.id, USER_RUN)).toMatchObject({
      status: "not_accepted",
      reason: expect.stringMatching(/doesn't take requests from you/),
    });
    expect(await pass(paused.id)).toMatchObject({
      status: "not_accepted",
      reason: expect.stringMatching(/isn't running/),
    });
    expect(await pass(sloan.id)).toMatchObject({
      status: "not_accepted",
      reason: expect.stringMatching(/itself/),
    });
    expect(emitted).toEqual([]);
  });

  it("never reaches another client's agent", async () => {
    emitted.length = 0;
    await expect(pass(theirs.id)).rejects.toThrow(/no such service/);
    await expect(pass("0192f7a0-0000-7000-8000-00000000ffff")).rejects.toThrow(/no such service/);
    expect(emitted).toEqual([]);
  });

  it("passes nothing in a test run", async () => {
    emitted.length = 0;
    expect(await pass(desk.id, TEST_RUN, { mode: "test" })).toEqual({
      status: "test_run",
      reason: null,
      messageId: null,
      sources: [desk.id],
    });
    // A test run still says plainly when the agent wouldn't take it.
    expect(await pass(clerk.id, TEST_RUN, { mode: "test" })).toMatchObject({
      status: "not_accepted",
    });
    expect(emitted).toEqual([]);
  });

  it("is only the account agent's", async () => {
    await expect(pass(desk.id, ADMIN_RUN, { agentId: clerk.id })).rejects.toThrow(
      /only the account agent/,
    );
  });
});
