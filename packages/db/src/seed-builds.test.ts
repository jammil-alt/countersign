// The draft builds (SEED_DEMO=1): three builds in the Draft phase, each with its Builder-made draft
// agent; running it twice changes nothing, and each holds what the build routes would have written.

import { AnyAgentBundle } from "@countersign/core";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agent, agentVersion, build, buildEvent, buildItem, buildMessage } from "./schema";
import { seed } from "./seed";
import { seedDraftBuilds } from "./seed-builds";
import { FOX_RIVER_PROFILE, HARBOR_PROFILE, seedDemo } from "./seed-demo";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./testing";

const online = await databaseAvailable();

describe.skipIf(!online)("draft builds seed", () => {
  let t: TestDatabase;
  let ids: Record<string, string>;
  let input: Parameters<typeof seedDraftBuilds>[1];
  beforeAll(async () => {
    const created = await createTestDatabase();
    if (!created) throw new Error("database vanished");
    t = created;
    const base = await seed(t.db);
    const operatorId = base.users.operator;
    const harbor = await seedDemo(t.db, { operatorId, profile: HARBOR_PROFILE });
    const fox = await seedDemo(t.db, { operatorId, profile: FOX_RIVER_PROFILE });
    input = { operatorId, harborId: harbor.tenantId, foxRiverId: fox.tenantId };
    ids = await seedDraftBuilds(t.db, input);
  });
  afterAll(async () => {
    await t?.drop();
  });

  const count = async () => {
    const buildIds = Object.values(ids);
    return {
      builds: (await t.db.select().from(build)).length,
      items: (await t.db.select().from(buildItem).where(inArray(buildItem.buildId, buildIds)))
        .length,
      messages: (
        await t.db.select().from(buildMessage).where(inArray(buildMessage.buildId, buildIds))
      ).length,
      events: (await t.db.select().from(buildEvent).where(inArray(buildEvent.buildId, buildIds)))
        .length,
      versions: (await t.db.select().from(agentVersion)).length,
    };
  };

  it("adds three open builds in the Draft phase: a template's and one per demo client", async () => {
    const rows = await t.db
      .select()
      .from(build)
      .where(inArray(build.id, Object.values(ids)));
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r).toMatchObject({ kind: "agent", phase: "draft", status: "open" });
      expect(r.agentId).not.toBeNull();
    }
    expect(rows.map((r) => r.clientId).sort()).toEqual(
      [null, input.harborId, input.foxRiverId].sort(),
    );
  });

  it("gives each a draft agent: one Builder draft version, never live, as the build's client's", async () => {
    const rows = await t.db
      .select()
      .from(build)
      .where(inArray(build.id, Object.values(ids)));
    for (const r of rows) {
      const [a] = await t.db
        .select()
        .from(agent)
        .where(eq(agent.id, r.agentId as string));
      expect(a).toMatchObject({
        tenantId: r.clientId,
        kind: r.clientId ? "client" : "template",
        liveVersionId: null,
      });
      const versions = await t.db
        .select()
        .from(agentVersion)
        .where(eq(agentVersion.agentId, r.agentId as string));
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ status: "draft", authorType: "builder", version: 1 });
      expect(AnyAgentBundle.safeParse(versions[0]?.bundle).success).toBe(true);
    }
  });

  it("records both moves, and the brief's and fit-gap's records, as the routes do", async () => {
    const events = await t.db
      .select()
      .from(buildEvent)
      .where(eq(buildEvent.buildId, ids["vendor-statement-check"] as string));
    expect(events.filter((e) => e.kind === "phase").map((e) => [e.fromPhase, e.toPhase])).toEqual(
      expect.arrayContaining([
        ["intake", "fitgap"],
        ["fitgap", "draft"],
      ]),
    );
    expect(events.filter((e) => e.kind === "record")).toHaveLength(2);
  });

  it("changes nothing when it runs again", async () => {
    const before = await count();
    expect(await seedDraftBuilds(t.db, input)).toEqual(ids);
    expect(await count()).toEqual(before);
  });
});
