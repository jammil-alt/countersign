// Track B's routes against a real database as cs_worker: the portal's Connections actions (sign in,
// disconnect, tighten only), the back office's offering and connections view, and what the inbox
// and run screens read (agent names, the run's workflow, the client timeline's sources), with no
// portal response ever carrying cost, prompts or bundles.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { FORBIDDEN_PORTAL_FIELD } from "@countersign/core";
import { connectionChange, inboxItem, membership, stepRun, tenant } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

function forbiddenKeys(value: unknown, at = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => forbiddenKeys(v, `${at}[${i}]`));
  if (value === null || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([k, v]) => [
    ...(FORBIDDEN_PORTAL_FIELD.test(k) ? [`${at}.${k}`] : []),
    ...forbiddenKeys(v, `${at}.${k}`),
  ]);
}

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("portal connections", () => {
  const H = h as ApiHarness;
  const authorize = (who: string, connector = "testkit") =>
    H.call(who, "POST", `/api/connections/${connector}/authorize`);

  it("lets only the client admin sign in to an offered tool, reusing the client's connection", async () => {
    expect((await authorize(user("a"))).status).toBe(403);
    expect((await authorize(OPERATOR)).status).toBe(403);
    const res = await authorize(admin("a"));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json).redirectUrl).toBeNull();
    expect(j(res.json).connection).toMatchObject({
      connector: "testkit",
      available: true,
      connection: { id: H.A.connectionId, status: "connected" },
    });
    expect(forbiddenKeys(res.json)).toEqual([]);
    expect(JSON.stringify(res.json)).not.toContain("credentials");
    const changes = await H.t.db
      .select()
      .from(connectionChange)
      .where(eq(connectionChange.connectionId, H.A.connectionId));
    expect(changes.map((c) => c.change)).toContainEqual(
      expect.objectContaining({ kind: "status", after: "connected" }),
    );
    // Signing in again changes nothing.
    expect(j((await authorize(admin("a"))).json).connection.connection.id).toBe(H.A.connectionId);
  });

  it("refuses a connector that is not offered, and one that can't be signed in to yet", async () => {
    expect((await authorize(admin("a"), "gmail")).status).toBe(404);
    // An offer of a connector this deployment doesn't have (as the superuser: the API refuses it).
    await H.t.db
      .update(tenant)
      .set({ settings: { connectors_offered: ["testkit", "qbo"] } })
      .where(eq(tenant.id, H.B.tenantId));
    const list = await H.call(admin("b"), "GET", "/api/connections");
    const qbo = j(list.json).connections.find((c: { connector: string }) => c.connector === "qbo");
    expect(qbo).toMatchObject({ available: false, connection: null });
    const res = await authorize(admin("b"), "qbo");
    expect(res.status).toBe(409);
    expect(j(res.json).error.code).toBe("not_available");
  });

  it("disconnects, keeping the matrix the client tightened for when it reconnects", async () => {
    const path = `/api/connections/${H.A.connectionId}`;
    const tightened = await H.call(admin("a"), "PATCH", `${path}/permissions`, { update: "off" });
    expect(tightened.status, JSON.stringify(tightened.json)).toBe(200);
    expect((await H.call(user("a"), "DELETE", path)).status).toBe(403);
    expect((await H.call(admin("b"), "DELETE", path)).status).toBe(404);
    expect((await H.call(OPERATOR, "DELETE", path)).status).toBe(403);
    const off = await H.call(admin("a"), "DELETE", path);
    expect(off.status, JSON.stringify(off.json)).toBe(200);
    expect(j(off.json).connection.connection.status).toBe("disconnected");
    const back = await authorize(admin("a"));
    expect(j(back.json).connection.connection).toMatchObject({
      id: H.A.connectionId,
      status: "connected",
      permissions: { update: "off" },
    });
  });

  it("enforces tighten-only on the server: no loosening, no scope, delete stays off", async () => {
    const path = `/api/connections/${H.A.connectionId}/permissions`;
    const loosen = await H.call(admin("a"), "PATCH", path, { update: "approval" });
    expect(loosen.status).toBe(403);
    expect(j(loosen.json).error.code).toBe("loosening");
    const scope = await H.call(admin("a"), "PATCH", path, { scope: "everything" });
    expect(scope.status).toBe(403);
    const del = await H.call(admin("a"), "PATCH", path, { delete: "auto" });
    expect(del.status).toBe(403);
    // The operator may loosen again.
    const ops = await H.call(OPERATOR, "PATCH", `/api/ops/connections/${H.A.connectionId}`, {
      permissions: { update: "approval" },
    });
    expect(j(ops.json).connection.permissions.update).toBe("approval");
  });
});

describe.skipIf(!h)("back office connections", () => {
  const H = h as ApiHarness;

  it("shows a client's connections with the offering, the registered connectors and who uses them", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/connections`);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const body = j(res.json);
    expect(body.offered).toEqual(["testkit"]);
    expect(body.connectors).toEqual([
      expect.objectContaining({ id: "upload", auth: "none", tools: [] }),
      expect.objectContaining({
        id: "testkit",
        auth: "none",
        tools: expect.arrayContaining([
          expect.objectContaining({ id: TESTKIT_UPDATE_TOOL, verb: "update" }),
        ]),
      }),
    ]);
    expect(body.usedBy).toEqual({ [H.A.connectionId]: [] });
    expect(JSON.stringify(body)).not.toContain("credentialsEncrypted");
  });

  it("sets the offering for a served client only, with registered connectors only", async () => {
    const path = `/api/ops/clients/${H.A.tenantId}/connectors`;
    expect((await H.call(OPERATOR, "PUT", path, { offered: ["nope"] })).status).toBe(422);
    expect(
      (
        await H.call(OPERATOR, "PUT", `/api/ops/clients/${H.C.tenantId}/connectors`, {
          offered: ["testkit"],
        })
      ).status,
    ).toBe(404);
    expect((await H.call(admin("a"), "PUT", path, { offered: [] })).status).toBe(403);
    const none = await H.call(OPERATOR, "PUT", path, { offered: [] });
    expect(j(none.json)).toEqual({ offered: [] });
    // No longer offered: no new sign-in, but the existing connection is still listed.
    expect((await H.call(admin("a"), "POST", "/api/connections/testkit/authorize")).status).toBe(
      404,
    );
    const list = await H.call(admin("a"), "GET", "/api/connections");
    expect(j(list.json).connections.map((c: { connector: string }) => c.connector)).toEqual([
      "upload",
      "testkit",
    ]);
    const back = await H.call(OPERATOR, "PUT", path, { offered: ["testkit", "testkit"] });
    expect(j(back.json)).toEqual({ offered: ["testkit"] });
    const [row] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.A.tenantId));
    expect(row?.settings).toMatchObject({ connectors_offered: ["testkit"] });
    // Another operator can't see this client's connections.
    expect(
      (await H.call(OTHER_OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/connections`)).status,
    ).toBe(404);
  });

  it("connects tools from the back office in the Sandbox client only", async () => {
    // A real client: the client signs in; the operator never connects for them.
    const real = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/connections/testkit/connect`,
    );
    expect(real.status).toBe(403);
    expect(j(real.json).error.code).toBe("not_sandbox");
    expect(
      j((await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}/connections`)).json)
        .sandbox,
    ).toBe(false);

    const [sandbox] = await H.t.db
      .insert(tenant)
      .values({ name: "Sandbox", settings: { sandbox: true } })
      .returning();
    if (!sandbox) throw new Error("no sandbox");
    await H.t.db
      .insert(membership)
      .values({ tenantId: sandbox.id, userId: H.operator, role: "operator" });
    const path = `/api/ops/clients/${sandbox.id}/connections/testkit/connect`;
    // Only an operator who serves it, and only connectors that need no provider sign-in.
    expect((await H.call(OTHER_OPERATOR, "POST", path)).status).toBe(404);
    expect((await H.call(admin("a"), "POST", path)).status).toBe(403);
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/clients/${sandbox.id}/connections/nope/connect`))
        .status,
    ).toBe(409);

    const first = await H.call(OPERATOR, "POST", path);
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    const conn = j(first.json).connection;
    expect(conn).toMatchObject({ tenantId: sandbox.id, connector: "testkit", status: "connected" });
    expect(conn.permissions).toMatchObject({ update: "approval", delete: "off" });
    // Again: the same connection, and one status change recorded, by the operator.
    const again = await H.call(OPERATOR, "POST", path);
    expect(j(again.json).connection.id).toBe(conn.id);
    const changes = await H.t.db
      .select()
      .from(connectionChange)
      .where(eq(connectionChange.connectionId, conn.id));
    expect(changes.map((c) => c.change)).toEqual([
      { kind: "status", by: "operator", before: null, after: "connected" },
    ]);
    const view = j(
      (await H.call(OPERATOR, "GET", `/api/ops/clients/${sandbox.id}/connections`)).json,
    );
    expect(view).toMatchObject({ sandbox: true, offered: ["testkit"] });
  });
});

describe.skipIf(!h)("inbox and run views", () => {
  const H = h as ApiHarness;
  let agentId = "";
  let runId = "";
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
  });

  /** Resolves the item a run waits on through the API, and returns the event it sent. */
  const resolveAs = (who: string, check?: (kind: string) => Promise<void>) => {
    return async (_name: string, type: string) => {
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
      const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
      if (!item) throw new Error(`no open item for ${type}`);
      await check?.(item.kind);
      const path =
        who === OPERATOR ? `/api/ops/inbox/${item.id}/resolve` : `/api/inbox/${item.id}/resolve`;
      const res = await H.call(who, "POST", path, { decision: "approve" });
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const sent = H.instances.events.find((e) => e.event.type === type);
      if (!sent) throw new Error(`no event ${type} was sent`);
      return sent.event.payload;
    };
  };

  beforeAll(async () => {
    await H.call(admin("a"), "POST", "/api/connections/testkit/authorize");
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "records-clerk",
      bundle: testBundle(),
    });
    const tid = j(tpl.json).agent.id;
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${tid}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tid}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Record keeping",
    });
    agentId = j(fork.json).agent.id;
    const v1 = j(fork.json).version.id;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${agentId}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/versions/${v1}/publish`);
    const test = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${agentId}/versions/${v1}/test-run`,
      {
        workflow: "fix-record",
      },
    );
    const testParams = H.instances.started.get(j(test.json).runId);
    if (!testParams) throw new Error("the test run was not started");
    await executeRun(
      deps(),
      testParams,
      cloudflareStepRunner(new FakeWorkflowStep(resolveAs(OPERATOR))),
    );
    const act = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/activate`);
    expect(act.status, JSON.stringify(act.json)).toBe(200);
  });

  it("shows the change waiting in both inboxes: tool, target, now and after", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "fix-record",
    });
    runId = j(res.json).runId;
    const params = H.instances.started.get(runId);
    if (!params) throw new Error("not started");
    const checked: string[] = [];
    const step = new FakeWorkflowStep(
      resolveAs(admin("a"), async (kind) => {
        checked.push(kind);
        if (kind !== "external_action") return;
        const portal = await H.call(admin("a"), "GET", "/api/inbox");
        expect(forbiddenKeys(portal.json)).toEqual([]);
        const [item] = j(portal.json).items;
        expect(item.kind).toBe("external_action");
        expect(item.payload).toMatchObject({
          tool: TESTKIT_UPDATE_TOOL,
          input: { id: "r1", amount: "12.00" },
          before: { id: "r1", amount: "10.00" },
        });
        // The operator sees every served client's items with their agents, and only its own
        // when asked for "operator".
        const all = await H.call(OPERATOR, "GET", "/api/ops/inbox?assigned=all");
        expect(j(all.json).items.map((i: { id: string }) => i.id)).toContain(item.id);
        expect(j(all.json).agents).toEqual([
          expect.objectContaining({ id: agentId, serviceName: "Record keeping" }),
        ]);
        const mine = await H.call(OPERATOR, "GET", "/api/ops/inbox");
        expect(j(mine.json).items.map((i: { id: string }) => i.id)).not.toContain(item.id);
        // The client admin's approval is theirs, not the operator's.
        const taken = await H.call(OPERATOR, "POST", `/api/ops/inbox/${item.id}/resolve`, {
          decision: "approve",
        });
        expect(taken.status).toBe(403);
      }),
    );
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    expect(checked).toEqual(["external_action", "approval"]);
  });

  it("gives the back office the run with its agent, version and workflow, and names in the list", async () => {
    const list = await H.call(OPERATOR, "GET", `/api/ops/runs?client=${H.A.tenantId}`);
    expect(j(list.json).runs.map((r: { id: string }) => r.id)).toContain(runId);
    expect(j(list.json).agents).toEqual([
      expect.objectContaining({ id: agentId, name: "Records clerk", slug: "records-clerk" }),
    ]);
    const res = await H.call(OPERATOR, "GET", `/api/ops/runs/${runId}`);
    const body = j(res.json);
    expect(body.agent).toMatchObject({ id: agentId, tenantId: H.A.tenantId });
    expect(body.version).toBe(1);
    expect(body.workflow).toMatchObject({ slug: "fix-record", name: "Fix a record" });
    expect(body.workflow.definition.steps.map((s: { id: string }) => s.id)).toEqual([
      "update",
      "confirm",
      "internal",
    ]);
    expect(body.actions[0]).toMatchObject({
      status: "done",
      before: { amount: "10.00" },
      input: { amount: "12.00" },
    });
  });

  it("shows the client timeline with sources, and never internals or cost", async () => {
    // A step whose output cites records (as skills that produce alerts must).
    await H.t.db
      .update(stepRun)
      .set({ output: { sources: ["r1", "r2"], costUsd: "987.6543" } })
      .where(and(eq(stepRun.runId, runId), eq(stepRun.nodeId, "update")));
    const res = await H.call(user("a"), "GET", `/api/runs/${runId}`);
    expect(res.status).toBe(200);
    expect(forbiddenKeys(res.json)).toEqual([]);
    const body = j(res.json);
    expect(
      body.steps.map((s: { label: string; sources: string[] }) => [s.label, s.sources]),
    ).toEqual([
      ["Corrected the record", ["r1", "r2"]],
      ["Confirm", []],
    ]);
    expect(JSON.stringify(body)).not.toContain("Operator note");
    // A distinctive amount: "1.00" also matched timestamps such as 16:22:21.004Z.
    expect(JSON.stringify(body)).not.toContain("987.6543");
    expect(JSON.stringify(body)).not.toContain("costUsd");
  });
});
