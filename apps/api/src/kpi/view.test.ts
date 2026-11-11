// audit-plan 6.6: the portal reads only a projection of a live bundle (its client view and whether
// it starts from documents), computed in SQL. It must agree with `readsDocuments` on the bundle.

import type { AgentBundle } from "@countersign/core";
import { agent, agentVersion, withTenant } from "@countersign/db";
import { afterAll, describe, expect, it } from "vitest";
import { createApiHarness } from "../api.test-helper";
import { readsDocuments } from "../lifecycle/runs";
import { liveProjections } from "./view";

const h = await createApiHarness();
afterAll(() => h?.close());

type Wf = { on: Record<string, unknown>; enabled?: boolean; v4?: boolean };

function bundle(workflows: Wf[], clientView?: unknown): AgentBundle {
  return {
    definition: clientView === undefined ? {} : { clientView },
    workflows: workflows.map((w, i) => ({
      slug: `w${i}`,
      name: `Workflow ${i}`,
      enabled: w.enabled ?? true,
      workflow: w.v4
        ? {
            triggers: [
              { id: `t${i}`, on: w.on },
              { id: `u${i}`, on: { type: "manual" } },
            ],
          }
        : { trigger: { id: `t${i}`, on: w.on } },
    })),
  } as unknown as AgentBundle;
}

const doc = { type: "event", event: "document.extracted" };
const cases: [string, AgentBundle][] = [
  ["v3 document trigger", bundle([{ on: doc }])],
  ["v4 document trigger", bundle([{ on: { type: "manual" } }, { on: doc, v4: true }])],
  ["disabled", bundle([{ on: doc, enabled: false }])],
  ["other event", bundle([{ on: { type: "event", event: "run.finished" } }])],
  ["no workflows", bundle([])],
  ["v4, document second", bundle([{ on: { type: "manual" }, v4: true }])],
];

describe.skipIf(!h)("liveProjections", () => {
  const H = h as NonNullable<typeof h>;

  it("agrees with readsDocuments and reads the client view, one query for all", async () => {
    const tenantId = H.A.tenantId;
    const rows: { id: string; liveVersionId: string; tenantId: string; want: boolean }[] = [];
    for (const [i, [name, b]] of cases.entries()) {
      const [a] = await H.t.db
        .insert(agent)
        .values({ tenantId, kind: "client", slug: `proj-${i}`, name, runStatus: "active" })
        .returning();
      if (!a) throw new Error("no agent");
      const [v] = await H.t.db
        .insert(agentVersion)
        .values({
          tenantId,
          agentId: a.id,
          version: 1,
          bundle: i === 0 ? bundle([{ on: doc }], { kpis: [], panels: [] }) : b,
          bundleHash: `proj-${i}`,
          status: "live",
          authorType: "operator",
        })
        .returning();
      if (!v) throw new Error("no version");
      rows.push({ id: a.id, liveVersionId: v.id, tenantId, want: readsDocuments(b) });
    }
    const got = await withTenant(H.db, tenantId, (tx) => liveProjections(tx, rows));
    for (const [i, r] of rows.entries()) {
      expect(got.get(r.id)?.readsDocuments, cases[i]?.[0]).toBe(r.want);
      expect(got.get(r.id)?.versionId).toBe(r.liveVersionId);
    }
    expect(rows.map((r) => r.want)).toEqual([true, true, false, false, false, false]);
    expect(got.get(rows[0]?.id as string)?.view).toEqual({ kpis: [], panels: [] });
    expect(got.get(rows[1]?.id as string)?.view).toBeNull();
  });
});
