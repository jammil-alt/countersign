// PLATFORM_QA STATE-7: a draft drifting from what's published. Versions are a line (a save from anything
// but the latest is refused as `stale_parent`), but publish takes any draft, including one older
// than the live version: a second tab still showing v2 publishes it after v3 went live.
import { agentVersion } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR, testBundle } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("STATE: publishing an older draft", () => {
  const H = h as ApiHarness;

  it("(PLATFORM_QA STATE-7) publishing a draft older than the live version is refused, so it can't silently undo the newer live version", async () => {
    const created = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/agents`, {
      slug: "state-7-clerk",
      bundle: testBundle(),
    });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    const id = j(created.json).agent.id as string;
    const v1 = j(created.json).version.id as string;
    await H.call(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { testkit: H.A.connectionId },
    });
    const p1 = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${v1}/publish`);
    expect(p1.status, JSON.stringify(p1.json)).toBe(200);

    const edit = (instructions: string) => {
      const b = testBundle();
      return { ...b, definition: { ...b.definition, instructions } };
    };
    // Tab 1 saves v2 and leaves it open as a draft.
    const s2 = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions`, {
      bundle: edit("Change records only when asked. Never touch closed periods."),
      parentVersionId: v1,
    });
    expect(s2.status, JSON.stringify(s2.json)).toBe(200);
    const v2 = j(s2.json).version.id as string;
    // Tab 2 builds v3 on it and publishes it.
    const s3 = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions`, {
      bundle: edit(
        "Change records only when asked. Never touch closed periods. Ask before amounts over 500.",
      ),
      parentVersionId: v2,
    });
    expect(s3.status, JSON.stringify(s3.json)).toBe(200);
    const v3 = j(s3.json).version.id as string;
    const p3 = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${v3}/publish`);
    expect(p3.status, JSON.stringify(p3.json)).toBe(200);

    // Tab 1 now presses Publish on v2.
    const p2 = await H.call(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${v2}/publish`);
    const [live] = await H.t.db
      .select({ version: agentVersion.version, status: agentVersion.status })
      .from(agentVersion)
      .where(eq(agentVersion.id, v3));
    // v3 stays live; v2 (which v3 already contains) is refused as behind it (use rollback instead).
    expect(live?.status).toBe("live");
    expect(p2.status, JSON.stringify(p2.json)).toBe(409);
    expect(j(p2.json).error).toMatchObject({
      code: "stale_parent",
      details: { latestVersionId: v3 },
    });
    expect(j(p2.json).error.message).toContain("roll back");
  });
});
