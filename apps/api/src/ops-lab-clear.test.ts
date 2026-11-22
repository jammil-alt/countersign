// Clearing the lab's Drafts on a test environment (docs/plan.md §1.173): one press stops every
// build in progress on the board and discards the drafts never published. Nothing is deleted: a
// stopped build and a discarded draft still open, and a draft restores. A published template and
// a build from a template stay as they are, and production never clears.
import { agent, build, buildEvent } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { admin, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";
import { CLEARED_REASON, clearsDrafts } from "./routes/ops-lab-clear";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

type Json = Record<string, unknown>;
const CLEAR = "/api/ops/lab/drafts/clear";

describe("where Drafts may be cleared", () => {
  it("is staging and development, never production or an unnamed environment", () => {
    expect(clearsDrafts({ ENVIRONMENT: "staging" })).toBe(true);
    expect(clearsDrafts({ ENVIRONMENT: " Development " })).toBe(true);
    expect(clearsDrafts({ ENVIRONMENT: "production" })).toBe(false);
    expect(clearsDrafts({ ENVIRONMENT: "" })).toBe(false);
    expect(clearsDrafts({} as { ENVIRONMENT: string })).toBe(false);
  });
});

describe.skipIf(!h)("clearing the lab's Drafts", () => {
  const H = h as NonNullable<typeof h>;
  const ok = async (method: string, path: string, body?: unknown) => {
    const res = await H.call(OPERATOR, method, path, body);
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    return res.json as Json;
  };
  const template = async (slug: string) => {
    const made = await ok("POST", "/api/ops/templates", { slug, bundle: testBundle() });
    return made as { agent: { id: string }; version: { id: string } };
  };

  it("is the operator's only", async () => {
    expect((await H.call(admin("a"), "GET", CLEAR)).status).toBe(403);
    expect((await H.call(admin("a"), "POST", CLEAR)).status).toBe(403);
  });

  it("stops the builds in progress and discards the unpublished drafts, keeping everything", async () => {
    // A published template: it stays.
    const live = await template("kept-live");
    await ok("POST", `/api/ops/agents/${live.agent.id}/versions/${live.version.id}/publish`);
    // A draft with no build, and a build with its own draft.
    const loose = await template("loose-draft");
    const own = await template("build-draft");
    const withDraft = (
      await ok("POST", "/api/ops/builds", { kind: "agent", title: "With a draft" })
    ).build as { id: string };
    await H.t.db.update(build).set({ agentId: own.agent.id }).where(eq(build.id, withDraft.id));
    const noDraft = (await ok("POST", "/api/ops/builds", { kind: "skill", title: "A skill" }))
      .build as { id: string };

    expect(await ok("GET", CLEAR)).toEqual({ allowed: true, builds: 2, drafts: 2 });
    expect(await ok("POST", CLEAR)).toEqual({ builds: 2, drafts: 2 });
    // Nothing is left to clear, and the board is empty.
    expect(await ok("GET", CLEAR)).toEqual({ allowed: true, builds: 0, drafts: 0 });
    expect((await ok("GET", "/api/ops/builds?status=open")).builds).toEqual([]);

    // The archive: both builds are stopped and still open by their address, with why.
    const stopped = (await ok("GET", "/api/ops/builds?status=stopped")).builds as { id: string }[];
    expect(stopped.map((b) => b.id).sort()).toEqual([withDraft.id, noDraft.id].sort());
    const page = await ok("GET", `/api/ops/builds/${withDraft.id}`);
    expect((page.build as { status: string }).status).toBe("stopped");
    const events = await H.t.db.select().from(buildEvent).where(eq(buildEvent.buildId, noDraft.id));
    expect(events.some((e) => e.reason === CLEARED_REASON)).toBe(true);

    // The drafts are discarded, not deleted, and one restores.
    const rows = await H.t.db.select().from(agent);
    const status = (id: string) => rows.find((a) => a.id === id)?.status;
    expect(status(loose.agent.id)).toBe("disabled");
    expect(status(own.agent.id)).toBe("disabled");
    expect(status(live.agent.id)).toBe("active");
    const back = await ok("POST", `/api/ops/agents/${loose.agent.id}/restore`);
    expect((back.agent as { status: string }).status).toBe("active");
  });
});
