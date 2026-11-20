// What a client sees for one agent, opened in the back office (docs/plan.md §1.163, owner
// 2026-11-20): `GET /api/ops/clients/:id/agents/:agentId/client-view` answers exactly what the
// client's portal page for that agent gets (`GET /api/services/:id`), only to an operator who
// serves the client, with its audit row; never bundles, instructions, prompts or cost. The client
// page's agents also say when each one's schedule next starts a run.

import type { AgentBundleInput } from "@countersign/core";
import { AgentBundle, buildPath, routes } from "@countersign/core";
import { agent, agentVersion, auditEvent, run } from "@countersign/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
  user,
} from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

/** testBundle, started every day at 9:00 in the client's zone as well as by hand. */
function scheduledBundle() {
  const b = testBundle("Bill clerk") as unknown as AgentBundleInput;
  const wf = b.workflows[0] as AgentBundleInput["workflows"][number];
  return AgentBundle.parse({
    ...b,
    workflows: [
      wf,
      {
        ...wf,
        slug: "daily-check",
        name: "Daily check",
        workflow: {
          ...(wf.workflow as object),
          trigger: { id: "trg-daily", on: { type: "schedule", cron: "0 9 * * *" } },
        },
      },
    ],
  });
}

describe.skipIf(!h)("the back office's view of an agent as the client sees it", () => {
  const H = h as NonNullable<typeof h>;
  const db = H.t.db;
  const ids = {} as Record<"live" | "draft", string>;
  const view = (client: string, agentId: string) =>
    buildPath(routes.opsClientAgentView.path, { id: client, agentId });

  beforeAll(async () => {
    const [a] = await db
      .insert(agent)
      .values({
        tenantId: H.A.tenantId,
        kind: "client",
        slug: "bill-clerk",
        name: "Bill clerk",
        runStatus: "active",
        stage: "live",
      })
      .returning();
    if (!a) throw new Error("no agent");
    ids.live = a.id;
    const [v] = await db
      .insert(agentVersion)
      .values({
        tenantId: H.A.tenantId,
        agentId: a.id,
        version: 1,
        bundle: scheduledBundle(),
        bundleHash: "hash-client-view",
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    await db.update(agent).set({ liveVersionId: v.id }).where(eq(agent.id, a.id));
    await db.insert(run).values({
      tenantId: H.A.tenantId,
      agentId: a.id,
      agentVersionId: v.id,
      workflowSlug: "fix-record",
      mode: "live",
      status: "succeeded",
      trigger: { type: "manual" },
      startedAt: new Date(Date.now() - 60_000),
      finishedAt: new Date(),
    });
    // Not started: the client's portal doesn't show it yet.
    const [d] = await db
      .insert(agent)
      .values({
        tenantId: H.A.tenantId,
        kind: "client",
        slug: "draft-clerk",
        name: "Draft clerk",
        runStatus: "draft",
      })
      .returning();
    if (!d) throw new Error("no draft");
    ids.draft = d.id;
  });

  it("answers an operator who serves the client exactly what the client's portal gets", async () => {
    const ops = await H.call(OPERATOR, "GET", view(H.A.tenantId, ids.live));
    expect(ops.status).toBe(200);
    const portal = await H.call(admin("a"), "GET", `/api/services/${ids.live}`);
    expect(portal.status).toBe(200);
    expect(ops.json).toEqual(portal.json);
    expect(j(ops.json).service).toMatchObject({ id: ids.live, name: "Bill clerk" });
    expect(j(ops.json).recentRuns).toHaveLength(1);
    // The portal's user sees the same page too.
    expect((await H.call(user("a"), "GET", `/api/services/${ids.live}`)).json).toEqual(ops.json);
  });

  it("never carries a bundle, instructions, prompts or cost", async () => {
    const ops = await H.call(OPERATOR, "GET", view(H.A.tenantId, ids.live));
    expect(forbiddenKeys(ops.json, /cost|token|prompt|instruction|bundle|definition/i)).toEqual([]);
    expect(JSON.stringify(ops.json)).not.toContain("Change records only when asked.");
  });

  it("is not found for a client the operator doesn't serve, or an agent of another client", async () => {
    // The other operator serves client C only.
    const other = await H.call(OTHER_OPERATOR, "GET", view(H.A.tenantId, ids.live));
    expect(other.status).toBe(404);
    // Client A's agent asked for under client B: B's scope has no such agent.
    const wrong = await H.call(OPERATOR, "GET", view(H.B.tenantId, ids.live));
    expect(wrong.status).toBe(404);
    // Client C, which this operator doesn't serve.
    const unserved = await H.call(OPERATOR, "GET", view(H.C.tenantId, ids.live));
    expect(unserved.status).toBe(404);
  });

  it("is not found for an agent the client doesn't see yet, as in the portal", async () => {
    expect((await H.call(OPERATOR, "GET", view(H.A.tenantId, ids.draft))).status).toBe(404);
    expect((await H.call(admin("a"), "GET", `/api/services/${ids.draft}`)).status).toBe(404);
  });

  it("refuses the client's own people, even naming their own client", async () => {
    for (const who of [admin("a"), user("a")]) {
      const res = await H.call(who, "GET", view(H.A.tenantId, ids.live));
      expect(res.status, who).toBe(403);
      const named = await H.call(who, "GET", view(H.A.tenantId, ids.live), undefined, {
        "x-countersign-client": H.A.tenantId,
      });
      expect(named.status, who).toBe(403);
    }
    expect((await H.call(null, "GET", view(H.A.tenantId, ids.live))).status).toBe(401);
  });

  it("writes the operator's audit row against the client", async () => {
    await H.call(OPERATOR, "GET", view(H.A.tenantId, ids.live));
    await H.settle();
    const rows = await db
      .select()
      .from(auditEvent)
      .where(
        and(
          eq(auditEvent.action, `GET ${routes.opsClientAgentView.path}`),
          eq(auditEvent.actorUserId, H.operator),
          eq(auditEvent.outcome, "ok"),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.tenantId === H.A.tenantId)).toBe(true);
  });

  it("says on the client page when each agent's schedule next starts a run", async () => {
    const res = await H.call(OPERATOR, "GET", `/api/ops/clients/${H.A.tenantId}`);
    expect(res.status).toBe(200);
    const activity = j(res.json).activity as { agentId: string; nextRunAt: string | null }[];
    const live = activity.find((a) => a.agentId === ids.live);
    const at = new Date(live?.nextRunAt as string).getTime();
    // Every day at 9:00 in the client's zone: within the next day.
    expect(at).toBeGreaterThan(Date.now());
    expect(at).toBeLessThanOrEqual(Date.now() + 86_400_000);
    // A draft is not started: no next run.
    expect(activity.find((a) => a.agentId === ids.draft)?.nextRunAt).toBeNull();
  });
});
