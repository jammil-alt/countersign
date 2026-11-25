// Installing seeded platform templates from the back office (src/account/templates.ts): the newest
// seeded version when none is named, once; never an older seeded version over a newer one (one
// seeded version per platform agent since the step model, so none is older today).

import { agent, agentVersion } from "@countersign/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { latestSeededVersion } from "./account/templates";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: test JSON
const j = (x: unknown) => x as any;

describe.skipIf(!h)("platform template install", () => {
  const H = h as ApiHarness;
  const install = (slug: string, body: object) =>
    H.call(OPERATOR, "POST", `/api/ops/platform-templates/${slug}/install`, body);

  async function live(slug: string) {
    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(isNull(agent.tenantId), eq(agent.slug, slug)));
    const versions = await H.t.db
      .select({ id: agentVersion.id, version: agentVersion.version })
      .from(agentVersion)
      .where(eq(agentVersion.agentId, tpl?.id as string));
    return { liveVersionId: tpl?.liveVersionId, count: versions.length };
  }

  it("installs the newest seeded version when none is named, and again is a no-op", async () => {
    const res = await install("supervisor", {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toMatchObject({ version: { status: "live" }, installed: true });
    const again = await install("supervisor", {});
    expect(again.status).toBe(200);
    expect(j(again.json)).toMatchObject({ version: j(res.json).version, installed: false });
    const named = await install("supervisor", { version: latestSeededVersion("supervisor") });
    expect(j(named.json)).toMatchObject({ version: j(res.json).version, installed: false });
  });

  // Step model (docs/step-model-plan.md §12, R0): one seeded version per platform agent.
  it("answers 404 for a version the seed doesn't have, and leaves the live one", async () => {
    const before = await live("supervisor");
    const res = await install("supervisor", { version: 2 });
    expect(res.status, JSON.stringify(res.json)).toBe(404);
    expect(await live("supervisor")).toEqual(before);
  });

  it("answers 404 for a slug with no seeded versions", async () => {
    expect((await install("no-such-template", {})).status).toBe(404);
  });
});
