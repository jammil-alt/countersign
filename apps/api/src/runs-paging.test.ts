// QA (runs and dates): the back office's runs list pages newest first by `before` and `next`,
// and each run says how long it waited on people (`waitedMs`), so "Took" is its working time.
import { inboxItem, run } from "@countersign/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { waitedMsOf } from "./runs/run-wait";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const H_MS = 3_600_000;

describe("waitedMsOf", () => {
  const start = new Date("2026-11-01T00:00:00Z");
  const at = (h: number) => new Date(start.getTime() + h * H_MS);
  const r = { id: "r", tenantId: "t", startedAt: start, finishedAt: at(170) };
  const item = (from: number, to: number | null) => ({
    runId: "r",
    status: to === null ? "open" : "resolved",
    createdAt: at(from),
    resolvedAt: to === null ? null : at(to),
  });

  it("joins overlapping waits and cuts them to the run", () => {
    // A week on an approval, a second item inside it, and one raised after the run ended.
    const items = [item(1, 169), item(10, 20), item(171, 172)];
    expect(waitedMsOf(r, items)).toBe(168 * H_MS);
  });

  it("counts an open item to now, and nothing before the run starts", () => {
    const going = { ...r, finishedAt: null };
    expect(waitedMsOf(going, [item(2, null)], at(5))).toBe(3 * H_MS);
    expect(waitedMsOf({ ...r, startedAt: null }, [item(1, 2)])).toBe(0);
  });
});

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("the runs list's pages", () => {
  const H = h as ApiHarness;
  const now = Date.now();
  const ids: string[] = [];
  let waited = "";

  beforeAll(async () => {
    const tpl = await H.call(OPERATOR, "POST", "/api/ops/templates", {
      slug: "pager",
      bundle: testBundle("Pager"),
    });
    await H.call(
      OPERATOR,
      "POST",
      `/api/ops/agents/${j(tpl.json).agent.id}/versions/${j(tpl.json).version.id}/publish`,
    );
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${j(tpl.json).agent.id}/fork`, {
      clientId: H.A.tenantId,
      slug: "pager",
      serviceName: "Pager",
    });
    const agentId = j(fork.json).agent.id;
    const agentVersionId = j(fork.json).version.id;
    // Five runs a minute apart, and two more created in the same instant (the id breaks the tie).
    const at = [0, 1, 2, 3, 4, 5, 5].map((m) => new Date(now - m * 60_000));
    for (const createdAt of at) {
      const [r] = await H.t.db
        .insert(run)
        .values({
          tenantId: H.A.tenantId,
          agentId,
          agentVersionId,
          workflowSlug: "fix-record",
          mode: "live",
          status: "succeeded",
          createdAt,
          startedAt: createdAt,
          finishedAt: new Date(createdAt.getTime() + 170 * H_MS),
        })
        .returning();
      ids.push(r?.id as string);
    }
    // The first run waited a week on an approval.
    waited = ids[0] as string;
    await H.t.db.insert(inboxItem).values({
      tenantId: H.A.tenantId,
      kind: "approval",
      runId: waited,
      agentId,
      assigneeRole: "client_admin",
      title: "Approve the bill",
      status: "resolved",
      createdAt: new Date(now + H_MS),
      resolvedAt: new Date(now + 169 * H_MS),
    });
  });

  it("pages newest first with before and next, every run once", async () => {
    const seen: string[] = [];
    let before: string | null = null;
    let pages = 0;
    do {
      const q: string = `/api/ops/runs?client=${H.A.tenantId}&limit=3${before ? `&before=${before}` : ""}`;
      const res = await H.call(OPERATOR, "GET", q);
      expect(res.status, JSON.stringify(res.json)).toBe(200);
      const body = j(res.json);
      expect(body.runs.length).toBeLessThanOrEqual(3);
      seen.push(...body.runs.map((r: { id: string }) => r.id));
      before = body.next;
      pages += 1;
    } while (before && pages < 10);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(seen.length);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it("says there is no next page on the last one, and answers an unknown run with none", async () => {
    const all = j((await H.call(OPERATOR, "GET", `/api/ops/runs?client=${H.A.tenantId}`)).json);
    expect(all.next).toBeNull();
    const none = await H.call(OPERATOR, "GET", `/api/ops/runs?before=${crypto.randomUUID()}`);
    expect(none.status).toBe(200);
    expect(j(none.json)).toMatchObject({ runs: [], next: null });
  });

  it("gives each run the time it waited on people, on the list and the run", async () => {
    const all = j((await H.call(OPERATOR, "GET", `/api/ops/runs?client=${H.A.tenantId}`)).json);
    const byId = new Map(all.runs.map((r: { id: string }) => [r.id, r]));
    expect(j(byId.get(waited)).waitedMs).toBe(168 * H_MS);
    expect(j(byId.get(ids[1])).waitedMs).toBe(0);
    const one = j((await H.call(OPERATOR, "GET", `/api/ops/runs/${waited}`)).json);
    expect(one.run.waitedMs).toBe(168 * H_MS);
  });
});
