// Round 4 D (docs/plan.md §1.211) against a real database as cs_worker: a client's dollar
// thresholds only tighten from our side; a write at or over one says so on its card; and the
// card's evidence reads back from the rows the run left, in the portal (no agent version, only its
// own client's items) and in the back office.

import { TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import { inboxItem } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  FakeWorkflowStep,
  OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";
import { executeRun } from "./runs/execute";
import { cloudflareStepRunner } from "./runs/step-runner";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;
const code = (res: { json: unknown }) => j(res.json).error?.code;

const h = await createApiHarness();
afterAll(() => h?.close());

const OPS = (id: string) => `/api/ops/clients/${id}/write-thresholds`;
const PORTAL = "/api/settings/write-thresholds";

describe.skipIf(!h)("dollar thresholds", () => {
  const H = h as ApiHarness;

  it("lets us lower or add one, never raise or remove one; the client's admin may", async () => {
    const empty = await H.call(OPERATOR, "GET", OPS(H.B.tenantId));
    expect(empty.status, JSON.stringify(empty.json)).toBe(200);
    expect(j(empty.json)).toEqual({ revision: 0, thresholds: [], mayLoosen: false });

    const add = await H.call(OPERATOR, "PUT", OPS(H.B.tenantId), {
      revision: 0,
      thresholds: [{ currency: "USD", approveFrom: "500.00" }],
    });
    expect(add.status, JSON.stringify(add.json)).toBe(200);
    expect(j(add.json).revision).toBe(1);

    const raise = await H.call(OPERATOR, "PUT", OPS(H.B.tenantId), {
      revision: 1,
      thresholds: [{ currency: "USD", approveFrom: "900.00" }],
    });
    expect([raise.status, code(raise)]).toEqual([403, "loosening"]);
    const remove = await H.call(OPERATOR, "PUT", OPS(H.B.tenantId), {
      revision: 1,
      thresholds: [],
    });
    expect([remove.status, code(remove)]).toEqual([403, "loosening"]);
    const lower = await H.call(OPERATOR, "PUT", OPS(H.B.tenantId), {
      revision: 1,
      thresholds: [{ currency: "USD", approveFrom: "250.00" }],
    });
    expect(lower.status).toBe(200);

    // The client's user reads them; only the admin saves, and may raise their own.
    const read = await H.call(user("b"), "GET", PORTAL);
    expect(j(read.json)).toMatchObject({ revision: 2, mayLoosen: false });
    const byUser = await H.call(user("b"), "PUT", PORTAL, { revision: 2, thresholds: [] });
    expect(byUser.status).toBe(403);
    const stale = await H.call(admin("b"), "PUT", PORTAL, { revision: 1, thresholds: [] });
    expect([stale.status, code(stale)]).toEqual([409, "stale"]);
    const raised = await H.call(admin("b"), "PUT", PORTAL, {
      revision: 2,
      thresholds: [{ currency: "USD", approveFrom: "1000.00" }],
    });
    expect(raised.status, JSON.stringify(raised.json)).toBe(200);
    expect(j(raised.json)).toMatchObject({ revision: 3, mayLoosen: true });
    // Another client's thresholds are out of reach of B's admin.
    expect(j((await H.call(admin("a"), "GET", PORTAL)).json).thresholds).toEqual([]);
  });
});

describe.skipIf(!h)("a change's evidence", () => {
  const H = h as ApiHarness;
  let agentId = "";
  const deps = () => ({
    db: H.db,
    platform: H.platform,
    transport: new FakeModel(),
    instances: H.instances,
  });
  const resolveAs = (who: (item: typeof inboxItem.$inferSelect) => Promise<string>) => {
    return async (_name: string, type: string) => {
      const items = await H.t.db.select().from(inboxItem).where(eq(inboxItem.status, "open"));
      const item = items.find((i) => `inbox-${i.id.replace(/-/g, "")}` === type);
      if (!item) throw new Error(`no open item for ${type}`);
      const email = await who(item);
      const res = await H.call(
        email,
        "POST",
        email === OPERATOR ? `/api/ops/inbox/${item.id}/resolve` : `/api/inbox/${item.id}/resolve`,
        { decision: "approve" },
      );
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const sent = H.instances.events.find((e) => e.event.type === type);
      if (!sent) throw new Error(`no event ${type} was sent`);
      return sent.event.payload;
    };
  };

  beforeAll(async () => {
    await H.call(admin("a"), "POST", "/api/connections/testkit/authorize");
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "evidence-clerk",
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
      { workflow: "fix-record" },
    );
    const testParams = H.instances.started.get(j(test.json).runId);
    if (!testParams) throw new Error("the test run was not started");
    await executeRun(
      deps(),
      testParams,
      cloudflareStepRunner(new FakeWorkflowStep(resolveAs(async () => OPERATOR))),
    );
    const act = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/activate`);
    expect(act.status, JSON.stringify(act.json)).toBe(200);
    // The change sets the record to 12.00 USD: at or over 10.00, it waits for a person.
    const t = await H.call(OPERATOR, "PUT", OPS(H.A.tenantId), {
      revision: 0,
      thresholds: [{ currency: "USD", approveFrom: "10.00" }],
    });
    expect(t.status, JSON.stringify(t.json)).toBe(200);
  });

  it("shows the step, the values and the threshold, in the portal and the back office", async () => {
    const started = await H.call(OPERATOR, "POST", `/api/ops/agents/${agentId}/run`, {
      workflow: "fix-record",
    });
    const params = H.instances.started.get(j(started.json).runId);
    if (!params) throw new Error("not started");
    let checked = false;
    const step = new FakeWorkflowStep(
      resolveAs(async (item) => {
        if (item.kind !== "external_action") return admin("a");
        expect(item.payload).toMatchObject({
          tool: TESTKIT_UPDATE_TOOL,
          threshold: { currency: "USD", approveFrom: "10.00" },
        });
        expect(item.payload).not.toHaveProperty("verification");

        const portal = await H.call(admin("a"), "GET", `/api/inbox/${item.id}/evidence`);
        expect(portal.status, JSON.stringify(portal.json)).toBe(200);
        const e = j(portal.json).evidence;
        expect(e).toMatchObject({
          itemId: item.id,
          producedBy: { step: { id: "update", name: "Update the record" }, from: [], rule: null },
          threshold: { currency: "USD", approveFrom: "10.00" },
          verification: null,
        });
        expect(e.values).toContainEqual({ path: "amount", before: "10.00", after: "12.00" });
        // The portal's copy names no agent version (invariant 11).
        expect(e).not.toHaveProperty("agentVersionId");
        expect(JSON.stringify(e)).not.toMatch(/claude|cost|prompt/i);

        const ops = await H.call(OPERATOR, "GET", `/api/ops/inbox/${item.id}/evidence`);
        expect(ops.status, JSON.stringify(ops.json)).toBe(200);
        expect(j(ops.json).evidence.agentVersionId).toEqual(expect.any(String));

        // Another client's admin can't read it (invariant 1).
        const other = await H.call(admin("b"), "GET", `/api/inbox/${item.id}/evidence`);
        expect(other.status).toBe(404);
        checked = true;
        return admin("a");
      }),
    );
    expect(await executeRun(deps(), params, cloudflareStepRunner(step))).toEqual({
      status: "succeeded",
    });
    expect(checked).toBe(true);
  });

  it("has nothing to show for an item that proposes no change", async () => {
    const [item] = await H.t.db
      .select()
      .from(inboxItem)
      .where(eq(inboxItem.kind, "approval"))
      .limit(1);
    if (!item) throw new Error("no approval item");
    const res = await H.call(OPERATOR, "GET", `/api/ops/inbox/${item.id}/evidence`);
    expect([res.status, code(res)]).toEqual([404, "no_evidence"]);
  });
});
