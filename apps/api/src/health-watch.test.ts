// v0.17 O5 (ARCHITECTURE §10.15 "Sloan is the chat", docs/plan.md §1.96): Sloan's v6 is chat only,
// and the watches its older versions ran as processes are the platform's: a failed run becomes a
// finding on the next tick, once however often the tick looks, and the daily check runs at 08:00
// in the client's own time zone. No agent runs and no model is called. A client whose Sloan still
// runs the old watches keeps them, and the platform leaves them alone.

import { SUPERVISOR_SLUG } from "@countersign/core";
import { agent, agentVersion, event, inboxItem, tenant } from "@countersign/db";
import { FakeModel } from "@countersign/llm";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { latestSeededVersion } from "./account/templates";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { localTime, platformHealthTick } from "./health/watch";
import { runtimeFor } from "./runs/execute";

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("Sloan's old watches as platform code", () => {
  const H = h as ApiHarness;
  const model = new FakeModel([]);
  const deps = () => ({
    db: H.db,
    runtime: runtimeFor({
      db: H.db,
      platform: H.platform,
      transport: model,
      instances: H.instances,
    }),
  });
  let sloanId = "";
  let failedAgent = "";
  let failedVersion = "";

  beforeAll(async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const [sloan] = await H.t.db
      .select({ id: agent.id, versionId: agent.liveVersionId })
      .from(agent)
      .where(and(eq(agent.tenantId, H.A.tenantId), eq(agent.slug, SUPERVISOR_SLUG)));
    sloanId = sloan?.id ?? "";
    // Any other agent of the client, to fail a run of.
    const [other] = await H.t.db
      .insert(agent)
      .values({
        tenantId: H.A.tenantId,
        kind: "client",
        slug: "watched",
        name: "Watched",
        stage: "bench",
      })
      .returning({ id: agent.id });
    failedAgent = other?.id ?? "";
    const [v] = await H.t.db
      .select({ id: agentVersion.id })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, sloanId))
      .limit(1);
    failedVersion = v?.id ?? "";
    await H.t.db
      .update(tenant)
      .set({ timezone: "America/Chicago" })
      .where(eq(tenant.id, H.A.tenantId));
  });

  it("forks Sloan's v6: the chat and nothing else", async () => {
    expect(latestSeededVersion(SUPERVISOR_SLUG)).toBe(6);
    const [row] = await H.t.db
      .select({ bundle: agentVersion.bundle })
      .from(agent)
      .innerJoin(agentVersion, eq(agentVersion.id, agent.liveVersionId))
      .where(eq(agent.id, sloanId));
    const bundle = row?.bundle as { workflows: { slug: string }[] } | undefined;
    const slugs = (bundle?.workflows ?? []).map((w) => w.slug);
    expect(slugs).toEqual(["chat"]);
  });

  it("reports a failed run once, however often the tick looks, with no model call", async () => {
    const at = new Date();
    await H.t.db.insert(event).values({
      tenantId: H.A.tenantId,
      type: "run.failed",
      subjectType: "run",
      subjectId: null,
      payload: {
        runId: "00000000-0000-4000-8000-0000000000f1",
        agentId: failedAgent,
        agentVersionId: failedVersion,
        workflowSlug: "fix-record",
        stepId: "update",
        error: "the record was gone",
      },
    });
    const findings = () =>
      H.t.db
        .select({ id: inboxItem.id, role: inboxItem.assigneeRole })
        .from(inboxItem)
        .where(
          and(
            eq(inboxItem.tenantId, H.A.tenantId),
            sql`${inboxItem.payload}->>'fingerprint' is not null`,
            eq(inboxItem.status, "open"),
          ),
        );
    const before = (await findings()).length;
    await platformHealthTick(
      deps(),
      H.A.tenantId,
      new Date(at.getTime() + 1000),
      "America/Chicago",
    );
    const after = await findings();
    expect(after.length).toBeGreaterThan(before);
    expect(new Set(after.map((f) => f.role))).toEqual(new Set(["client_admin", "operator"]));
    // The next tick sees the same event: nothing new.
    await platformHealthTick(
      deps(),
      H.A.tenantId,
      new Date(at.getTime() + 61_000),
      "America/Chicago",
    );
    expect((await findings()).length).toBe(after.length);
    expect(model.requests).toHaveLength(0);
  });

  it("runs the daily check at 08:00 in the client's time zone, and only then", async () => {
    // 08:00 in Chicago on 12 November 2026 is 14:00 UTC.
    const eight = new Date("2026-11-12T14:00:00.000Z");
    expect(localTime(eight, "America/Chicago")).toEqual({ hour: 8, minute: 0 });
    const checks = async () =>
      (
        await H.t.db
          .select({ id: event.id })
          .from(event)
          .where(and(eq(event.tenantId, H.A.tenantId), eq(event.type, "health.checked")))
      ).length;
    const n = await checks();
    expect((await platformHealthTick(deps(), H.A.tenantId, eight, "America/Chicago")).checked).toBe(
      true,
    );
    expect(await checks()).toBe(n + 1);
    const later = new Date(eight.getTime() + 60_000);
    expect((await platformHealthTick(deps(), H.A.tenantId, later, "America/Chicago")).checked).toBe(
      false,
    );
  });

  it("leaves a client whose Sloan still runs the old watches to them", async () => {
    // Sloan's live version made to hold v5's watch processes again.
    const [live] = await H.t.db
      .select({ bundle: agentVersion.bundle })
      .from(agent)
      .innerJoin(agentVersion, eq(agentVersion.id, agent.liveVersionId))
      .where(eq(agent.id, sloanId));
    const bundle = live?.bundle as { workflows: Record<string, unknown>[] };
    const chat = bundle.workflows[0] ?? {};
    const legacy = {
      ...bundle,
      workflows: [
        ...bundle.workflows,
        ...["daily-check", "run-failed", "connection-needs-attention"].map((slug) => ({
          ...chat,
          slug,
        })),
      ],
    };
    const [old] = await H.t.db.$client<{ id: string }[]>`
      insert into agent_version (tenant_id, agent_id, version, bundle, bundle_hash, status, author_type)
      values (${H.A.tenantId}, ${sloanId}, 99, ${JSON.stringify(legacy)}::jsonb, 'legacy', 'live', 'operator')
      returning id`;
    await H.t.db.update(agent).set({ liveVersionId: old?.id }).where(eq(agent.id, sloanId));
    const eight = new Date("2026-11-13T14:00:00.000Z");
    expect(await platformHealthTick(deps(), H.A.tenantId, eight, "America/Chicago")).toEqual({
      reported: 0,
      checked: false,
      suggested: 0,
    });
    expect(
      await H.t.db
        .select({ id: agent.id })
        .from(agent)
        .where(and(isNull(agent.tenantId), eq(agent.slug, SUPERVISOR_SLUG))),
    ).toHaveLength(1);
  });
});
