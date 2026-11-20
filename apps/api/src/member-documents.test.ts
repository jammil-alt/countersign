// docs/plan.md §1.122 and PLATFORM_QA SEC-4: a client user limited to some agents opens a document
// by id only when a run, a step or an inbox item of one of their agents names it. Any other document
// of the client answers 404, as a missing one does, so its id isn't confirmed. Admins and client
// users with every agent open any of the client's documents, as before.

import { createHash } from "node:crypto";
import { agent, appUser, document, inboxItem, membership, run, stepRun } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("a document a limited client user opens (PLATFORM_QA SEC-4)", () => {
  const H = h as ApiHarness;
  const ids = {
    one: "",
    two: "",
    runOne: "",
    runTwo: "",
    docTrigger: "",
    docStep: "",
    docItem: "",
    docOther: "",
    docNone: "",
  };
  let userId = "";

  /** A client agent forked from a template of its own, active, with its live version id. */
  async function clientAgent(tenantId: string, slug: string, serviceName: string) {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug,
      bundle: testBundle(serviceName),
    });
    expect(tpl.status, JSON.stringify(tpl.json)).toBe(200);
    const tid = j(tpl.json).agent.id as string;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: tenantId,
      serviceName,
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    await H.t.db
      .update(agent)
      .set({ runStatus: "active" })
      .where(eq(agent.id, j(fork.json).agent.id));
    return { id: j(fork.json).agent.id as string, version: j(fork.json).version.id as string };
  }

  async function liveRun(tenantId: string, a: { id: string; version: string }, trigger = {}) {
    const [row] = await H.t.db
      .insert(run)
      .values({
        tenantId,
        agentId: a.id,
        agentVersionId: a.version,
        workflowSlug: "fix-record",
        status: "succeeded",
        trigger,
      })
      .returning({ id: run.id });
    return row?.id as string;
  }

  async function doc(tenantId: string, name: string) {
    const [row] = await H.t.db
      .insert(document)
      .values({
        tenantId,
        source: "upload",
        storageKey: `tenants/a/${name}`,
        mimeType: "application/pdf",
        filename: name,
        sizeBytes: 10,
        sha256: createHash("sha256").update(name).digest("hex"),
      })
      .returning({ id: document.id });
    return row?.id as string;
  }

  beforeAll(async () => {
    const tenantId = H.A.tenantId;
    const one = await clientAgent(tenantId, "docs-one", "Invoices");
    const two = await clientAgent(tenantId, "docs-two", "Collections");
    ids.one = one.id;
    ids.two = two.id;
    ids.docTrigger = await doc(tenantId, "started-run-one.pdf");
    ids.docStep = await doc(tenantId, "read-in-step-one.pdf");
    ids.docItem = await doc(tenantId, "item-one.pdf");
    ids.docOther = await doc(tenantId, "item-two.pdf");
    ids.docNone = await doc(tenantId, "nobody.pdf");
    ids.runOne = await liveRun(tenantId, one, {
      type: "event",
      event: "document.received",
      payload: { documentId: ids.docTrigger },
    });
    ids.runTwo = await liveRun(tenantId, two);
    await H.t.db.insert(stepRun).values({
      tenantId,
      runId: ids.runOne,
      nodeId: "read",
      nodeType: "tool",
      status: "succeeded",
      input: {},
      output: { lines: [{ documentIds: [ids.docStep] }] },
    });
    await H.t.db.insert(inboxItem).values([
      {
        tenantId,
        agentId: one.id,
        runId: ids.runOne,
        kind: "review",
        title: "Check invoice 1",
        assigneeRole: "client_user",
        payload: { documentId: ids.docItem },
      },
      {
        tenantId,
        agentId: two.id,
        runId: ids.runTwo,
        kind: "review",
        title: "Chase customer 2",
        assigneeRole: "client_user",
        subjectType: "document",
        subjectId: ids.docOther,
        payload: { documentId: ids.docOther },
      },
    ]);
    const [u] = await H.t.db
      .select()
      .from(appUser)
      .where(eq(appUser.email, user("a")));
    userId = u?.id as string;
    const set = await H.call(admin("a"), "PATCH", `/api/users/${userId}`, {
      agentIds: [ids.one],
    });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
  });

  afterAll(async () => {
    await H.t.db
      .update(membership)
      .set({ agentIds: null })
      .where(and(eq(membership.tenantId, H.A.tenantId), eq(membership.userId, userId)));
  });

  it("(PLATFORM_QA SEC-4) answers 404 for a document only another agent's item names", async () => {
    for (const id of [ids.docOther, ids.docNone]) {
      const res = await H.call(user("a"), "GET", `/api/documents/${id}`);
      expect(res.status, id).toBe(404);
      expect(j(res.json).error.code).toBe("not_found");
      expect(JSON.stringify(res.json)).not.toContain(".pdf");
    }
  });

  it("(PLATFORM_QA SEC-4) answers 200 for a document their own agent's item, run or step names", async () => {
    for (const id of [ids.docItem, ids.docTrigger, ids.docStep]) {
      const res = await H.call(user("a"), "GET", `/api/documents/${id}`);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      expect(j(res.json).document.id).toBe(id);
      expect(typeof j(res.json).url).toBe("string");
    }
  });

  it("(PLATFORM_QA SEC-4) an empty list opens no document", async () => {
    await H.call(admin("a"), "PATCH", `/api/users/${userId}`, { agentIds: [] });
    expect((await H.call(user("a"), "GET", `/api/documents/${ids.docItem}`)).status).toBe(404);
    await H.call(admin("a"), "PATCH", `/api/users/${userId}`, { agentIds: [ids.one] });
  });

  it("(PLATFORM_QA SEC-4) an admin, and a client user with every agent, still open any document", async () => {
    for (const id of [ids.docOther, ids.docNone]) {
      expect((await H.call(admin("a"), "GET", `/api/documents/${id}`)).status, id).toBe(200);
    }
    await H.call(admin("a"), "PATCH", `/api/users/${userId}`, { agentIds: null });
    expect((await H.call(user("a"), "GET", `/api/documents/${ids.docNone}`)).status).toBe(200);
    await H.call(admin("a"), "PATCH", `/api/users/${userId}`, { agentIds: [ids.one] });
  });
});
