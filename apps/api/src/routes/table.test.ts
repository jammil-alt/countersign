// audit-plan 6.1: the Table (portal Home, polled every 20 s) is read in a fixed number of
// statements: none of its reads grows per agent or per KPI. Counted at the transaction's client,
// where every statement drizzle sends goes through `unsafe`.

import { agent, agentVersion, run, type Tx, withTenant } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { createApiHarness, testBundle } from "../api.test-helper";
import { tenantRow } from "../notify/people";
import { buildTable } from "./table";
import { agentsNow } from "./usage";

const h = await createApiHarness();
afterAll(() => h?.close());

/** Most statements the Table's handler may send (the plan's target is 15 with the route's own). */
const TABLE_STATEMENTS = 11;

function viewBundle(name: string) {
  const b = testBundle(name);
  (b.definition as Record<string, unknown>).clientView = {
    kpis: [
      {
        id: "done",
        label: "Runs done",
        period: "week",
        format: "count",
        measure: { kind: "runs", status: "succeeded" },
      },
      {
        id: "share",
        label: "Runs done of all",
        period: "week",
        format: "percent",
        measure: {
          kind: "ratio",
          numerator: { kind: "runs", status: "succeeded" },
          denominator: { kind: "runs" },
        },
      },
    ],
    panels: [{ id: "main", kind: "kpis", kpis: ["done", "share"] }],
  };
  return b;
}

/** Runs `fn` in a transaction and counts the statements it sends. */
async function counted<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<{ n: number; out: T }> {
  const H = h as NonNullable<typeof h>;
  return withTenant(H.db, tenantId, async (tx) => {
    // biome-ignore lint/suspicious/noExplicitAny: a test reaches the transaction's own client.
    const session = (tx as any).session as { client: { unsafe: (...a: unknown[]) => unknown } };
    const client = session.client;
    let n = 0;
    session.client = new Proxy(client, {
      get(target, prop, receiver) {
        if (prop === "unsafe") {
          return (...a: unknown[]) => {
            n += 1;
            return target.unsafe(...a);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
    try {
      const out = await fn(tx);
      return { n, out };
    } finally {
      session.client = client;
    }
  });
}

describe.skipIf(!h)("the Table's statements", () => {
  const H = h as NonNullable<typeof h>;
  const tenantId = () => H.A.tenantId;
  let made = 0;

  /** An agent with `done` succeeded runs and one running; `view: false` gives it no client view. */
  async function addAgent(done: number, view = true): Promise<string> {
    made += 1;
    const [a] = await H.t.db
      .insert(agent)
      .values({
        tenantId: tenantId(),
        kind: "client",
        slug: `count-${made}`,
        name: `Clerk ${made}`,
        runStatus: "active",
        stage: "live",
      })
      .returning();
    if (!a) throw new Error("no agent");
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: tenantId(),
        agentId: a.id,
        version: 1,
        bundle: view ? viewBundle(`Clerk ${made}`) : testBundle(`Clerk ${made}`),
        bundleHash: `count-${made}`,
        status: "live",
        authorType: "operator",
      })
      .returning();
    if (!v) throw new Error("no version");
    await H.t.db.update(agent).set({ liveVersionId: v.id }).where(eq(agent.id, a.id));
    const statuses = [...Array(done).fill("succeeded"), "running"] as ("succeeded" | "running")[];
    await H.t.db.insert(run).values(
      statuses.map((status) => ({
        tenantId: tenantId(),
        agentId: a.id,
        agentVersionId: v.id,
        workflowSlug: "fix-record",
        mode: "live" as const,
        status,
        trigger: { type: "manual" },
      })),
    );
    return a.id;
  }

  const table = async () => {
    const t = await withTenant(H.db, tenantId(), (tx) => tenantRow(tx, tenantId()));
    if (!t) throw new Error("no client");
    return counted(tenantId(), (tx) =>
      buildTable(tx, t, { userId: H.A.admin, role: "client_admin" }, new Date(), H.platform),
    );
  };

  it("sends the same few statements for one agent and for five, each with its own KPIs", async () => {
    await addAgent(1);
    const one = await table();
    expect(one.out.services).toHaveLength(1);
    expect(one.out.services[0]?.kpis.map((k) => k.key)).toEqual(["done", "share"]);
    // Different figures per agent, and one with no client view between ones with KPIs, so the
    // KPI lists cannot slide onto the wrong agent.
    await addAgent(3);
    await addAgent(2, false);
    await addAgent(4);
    await addAgent(0);
    const five = await table();
    const want: [string, { done: string; share: string } | null, number][] = [
      ["Clerk 1", { done: "1", share: "50%" }, 2],
      ["Clerk 2", { done: "3", share: "75%" }, 4],
      ["Clerk 3", null, 3],
      ["Clerk 4", { done: "4", share: "80%" }, 5],
      ["Clerk 5", { done: "0", share: "0%" }, 1],
    ];
    expect(five.out.services.map((s) => s.name)).toEqual(want.map(([name]) => name));
    for (const [i, [name, kpis, total]] of want.entries()) {
      const s = five.out.services[i];
      expect(
        s?.kpis.map((k) => [k.key, k.value]),
        name,
      ).toEqual(
        kpis
          ? [
              ["done", kpis.done],
              ["share", kpis.share],
            ]
          : [],
      );
      expect(s?.runs?.total, name).toBe(total);
      expect(s?.runsNow, name).toEqual({ running: 1, waitingOnYou: 0 });
    }
    expect(five.n).toBe(one.n);
    expect(five.n).toBeLessThanOrEqual(TABLE_STATEMENTS);
  });

  it("reads every agent's latest run in one statement", async () => {
    const { n, out } = await counted(tenantId(), (tx) => agentsNow(tx, tenantId()));
    expect(out).toHaveLength(5);
    expect(n).toBe(1);
  });
});
