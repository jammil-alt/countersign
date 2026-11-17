// Installing seeded platform templates from the back office (src/account/templates.ts): the newest
// seeded version when none is named, and never an older seeded version over a newer one.

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

  it("installs newer seeded versions in order", async () => {
    expect((await install("supervisor", { version: 2 })).status).toBe(200);
    const v3 = await install("supervisor", { version: 3 });
    expect(v3.status, JSON.stringify(v3.json)).toBe(200);
    expect(j(v3.json)).toMatchObject({ version: { status: "live" }, installed: true });
  });

  it("refuses going back to a seeded version in its history", async () => {
    const before = await live("supervisor");
    const res = await install("supervisor", { version: 2 });
    expect(res.status, JSON.stringify(res.json)).toBe(409);
    expect(j(res.json).error.code).toBe("older_version");
    expect(await live("supervisor")).toEqual(before);
  });

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

  it("refuses a seeded version older than the newest it holds, and leaves the live one", async () => {
    const before = await live("supervisor");
    // v4 and v5 were never installed here; v3 was. All are older than the newest held.
    for (const version of [1, 3, 4, 5]) {
      const res = await install("supervisor", { version });
      expect(res.status, `v${version}: ${JSON.stringify(res.json)}`).toBe(409);
      expect(j(res.json).error.code).toBe("older_version");
    }
    expect(await live("supervisor")).toEqual(before);
  });

  it("answers 404 for a slug with no seeded versions", async () => {
    expect((await install("no-such-template", {})).status).toBe(404);
  });
});
