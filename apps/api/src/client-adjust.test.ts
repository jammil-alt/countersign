// Client adjustments and feedback through the API (docs/builder-plan.md §7, B5): the client admin
// changes a setting we marked as adjustable on the agent's Settings; within its bounds or tighter
// it becomes a new version by code (published at once on a live copy) and is written into the
// manual's decisions with who and when; beyond its bounds it files a request to us. Nothing but a
// marked setting can be changed (the never class). "This is wrong because…" on a manual line files
// a request linked to it. No portal answer carries the agent's version (invariant 11), and one
// client never reaches another's (invariant 1).
import {
  type AdjustableSettingInput,
  type AgentBundle,
  type AgentBundleInput,
  AgentBundle as AgentBundleSchema,
  adjustRoutes,
  forbiddenPortalFields,
} from "@countersign/core";
import { agent, agentChange, agentVersion, issue, issueEvent } from "@countersign/db";
import { desc, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  admin,
  createApiHarness,
  forbiddenKeys,
  OPERATOR,
  storedSkill,
  testBundle,
  user,
} from "./api.test-helper";

for (const level of process.env.SHOW_LOGS ? [] : (["warn", "error"] as const)) {
  vi.spyOn(console, level).mockImplementation(() => {});
}

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type Json = any;

const SKILL = {
  schemaVersion: 1,
  id: "custom:adjust-floor",
  name: "Check a record",
  description: "Whether a record is right",
  category: "purchasing",
  mode: "task",
  model: { id: "claude-haiku-5-5" },
  instructions: "Check the record.",
  tools: [],
  input: { type: "object", properties: { line: { type: "string" } }, required: ["line"] },
  output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
  parameters: [{ name: "floor", label: "Lowest confidence", type: "number", default: 0.8 }],
};

const ADJUSTABLE: AdjustableSettingInput[] = [
  {
    id: "param-floor",
    label: "How sure a check must be",
    target: { kind: "parameter", skill: "custom:adjust-floor", parameter: "floor", type: "number" },
    bounds: { min: "0.5", max: "0.95" },
    // A higher floor only asks a person more often.
    tighter: "higher",
    decisionId: "floor",
  },
  {
    id: "schedule-daily",
    label: "When it checks",
    target: { kind: "schedule", workflow: "fix-record", triggerId: "trg-daily" },
    bounds: { options: ["0 7 * * 1-5", "0 7 * * 1"] },
  },
];

function adjustBundle(): AgentBundle {
  const b = testBundle("Record checker") as AgentBundleInput;
  const [w] = b.workflows;
  return AgentBundleSchema.parse({
    ...b,
    definition: {
      ...b.definition,
      skills: [{ skill: "custom:adjust-floor", settings: {}, parameters: { floor: 0.8 } }],
      adjustable: ADJUSTABLE,
      manual: {
        whatItDoes: "Checks records.",
        decisions: [
          {
            id: "floor",
            what: "A check below 80% sure goes to a person",
            why: "Strict first.",
            value: "0.8",
            kind: "client_setup",
            risk: "normal",
          },
        ],
      },
    },
    workflows: [
      {
        ...w,
        workflow: {
          ...(w?.workflow as object),
          moreTriggers: [{ id: "trg-daily", on: { type: "schedule", cron: "0 7 * * 1-5" } }],
        },
      },
    ],
  });
}

describe("client adjustments: the contract", () => {
  it("keeps the portal's routes to the client, with no forbidden fields", () => {
    expect(adjustRoutes.portalAgentAdjustable.roles).toEqual(["client_admin", "client_user"]);
    expect(adjustRoutes.portalAgentAdjust.roles).toEqual(["client_admin"]);
    expect(adjustRoutes.portalManualFeedback.roles).toEqual(["client_admin", "client_user"]);
    for (const r of Object.values(adjustRoutes)) {
      expect(forbiddenPortalFields(r.response)).toEqual([]);
    }
  });
});

describe.skipIf(!h)("client adjustments and feedback", () => {
  const H = h as NonNullable<typeof h>;
  const A = () => H.A;

  async function ok(who: string, method: string, path: string, body?: unknown): Promise<Json> {
    const res = await H.call(who, method, path, body);
    expect(res.status, `${who} ${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return res.json;
  }
  const status = async (who: string, method: string, path: string, body?: unknown) => {
    const res = await H.call(who, method, path, body);
    return { status: res.status, json: res.json as Json };
  };
  const versions = (id: string) =>
    H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.agentId, id))
      .orderBy(desc(agentVersion.version));
  const row = async (id: string) =>
    (await H.t.db.select().from(agent).where(eq(agent.id, id)))[0] as typeof agent.$inferSelect;
  const bundleOf = (v: { bundle: unknown } | undefined) => (v as { bundle: AgentBundle }).bundle;
  const floorOf = (v: { bundle: unknown } | undefined) =>
    bundleOf(v).definition.skills[0]?.parameters?.floor;
  const cronOf = (v: { bundle: unknown } | undefined) =>
    (bundleOf(v).workflows[0]?.workflow.moreTriggers?.[0]?.on as { cron?: string } | undefined)
      ?.cron;

  let id = "";

  it("lists what the client may adjust, and nothing of the version", async () => {
    // The client's own skill, so a version the client admin makes can go live from the portal.
    await storedSkill(H, SKILL, A().tenantId);
    const created = await ok(OPERATOR, "POST", `/api/ops/clients/${A().tenantId}/agents`, {
      slug: "record-checker",
      bundle: adjustBundle(),
    });
    id = created.agent.id as string;
    const got = await ok(admin("a"), "GET", `/api/services/${id}/adjustable`);
    expect(got.settings.map((s: Json) => [s.id, s.kind, s.current, s.min, s.max])).toEqual([
      ["param-floor", "number", "0.8", "0.5", "0.95"],
      ["schedule-daily", "schedule", "0 7 * * 1-5", null, null],
    ]);
    expect(forbiddenKeys(got)).toEqual([]);
    expect(JSON.stringify(got)).not.toContain("custom:adjust-floor");
    expect(JSON.stringify(got)).not.toContain("trg-daily");
    // A client user reads them too; another client never.
    await ok(user("a"), "GET", `/api/services/${id}/adjustable`);
    expect((await status(admin("b"), "GET", `/api/services/${id}/adjustable`)).status).toBe(404);
  });

  it("applies a change within the bounds as a new version, written in the manual", async () => {
    const set = (who: string, settingId: string, body: unknown) =>
      status(who, "POST", `/api/services/${id}/adjustable/${settingId}`, body);
    // Only the client admin changes one, and only in their own client.
    expect((await set(user("a"), "param-floor", { value: "0.9" })).status).toBe(403);
    expect((await set(admin("b"), "param-floor", { value: "0.9" })).status).toBe(404);
    // Only what we marked: an approval, a step or anything else is not a setting.
    expect((await set(admin("a"), "approval-update", { value: "off" })).status).toBe(404);
    // Not a number.
    const bad = await set(admin("a"), "param-floor", { value: "very" });
    expect(bad.status).toBe(422);
    expect(bad.json.error.message).toBe("Write a number.");

    const v1 = (await versions(id))[0];
    const done = await set(admin("a"), "param-floor", { value: "0.9" });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json).toMatchObject({ outcome: "applied", request: null });
    expect(done.json.message).toBe(
      "Saved. How sure a check must be is now 0.9; it applies once we put this version live.",
    );
    expect(done.json.settings[0]).toMatchObject({
      current: "0.9",
      changedBy: expect.any(String),
      changedSide: "client",
    });
    const all = await versions(id);
    expect(all).toHaveLength(2);
    expect(all[0]?.parentVersionId).toBe(v1?.id);
    expect(floorOf(all[0])).toBe(0.9);
    expect(all[0]?.changeNote).toContain("Settings change from");
    // Only the setting and the manual changed: steps, approvals and the bounds are as they were.
    expect(bundleOf(all[0]).workflows).toEqual(bundleOf(v1).workflows);
    expect(bundleOf(all[0]).definition.adjustable).toEqual(bundleOf(v1).definition.adjustable);
    expect(bundleOf(all[0]).definition.permissions).toEqual(bundleOf(v1).definition.permissions);
    // The manual's decision says it was changed, by whom and when.
    const decision = bundleOf(all[0]).definition.manual?.decisions[0];
    expect(decision).toMatchObject({
      id: "floor",
      what: "A check below 80% sure goes to a person",
      value: "0.9",
      status: "changed",
      side: "client",
      by: expect.any(String),
      at: expect.any(String),
    });

    // The same value again changes nothing.
    const same = await set(admin("a"), "param-floor", { value: "0.9" });
    expect(same.json.outcome).toBe("unchanged");
    expect(await versions(id)).toHaveLength(2);
  });

  it("goes live at once on a live copy, and a tightening may pass the bounds", async () => {
    const [draft] = await versions(id);
    await ok(OPERATOR, "PATCH", `/api/ops/agents/${id}/operation`, {
      bindings: { testkit: A().connectionId },
    });
    await ok(OPERATOR, "POST", `/api/ops/agents/${id}/versions/${draft?.id}/publish`);
    expect((await row(id)).liveVersionId).toBe(draft?.id);
    // 0.97 is above the bounds' 0.95, but higher is tighter here: applied, not a request.
    const tight = await ok(admin("a"), "POST", `/api/services/${id}/adjustable/param-floor`, {
      value: "0.97",
    });
    expect(tight.outcome).toBe("applied");
    expect(tight.message).toBe("Saved. How sure a check must be is now 0.97; new runs use it.");
    const [latest] = await versions(id);
    expect(floorOf(latest)).toBe(0.97);
    expect((await row(id)).liveVersionId).toBe(latest?.id);
    // A schedule from the ones we allow.
    const sched = await ok(admin("a"), "POST", `/api/services/${id}/adjustable/schedule-daily`, {
      value: "0 7 * * 1",
    });
    expect(sched.outcome).toBe("applied");
    const [now] = await versions(id);
    expect(cronOf(now)).toBe("0 7 * * 1");
    expect(bundleOf(now).definition.manual?.decisions.map((d) => [d.id, d.value])).toEqual([
      ["floor", "0.97"],
      ["set-schedule-daily", "0 7 * * 1"],
    ]);
  });

  it("files a request to us for a change beyond the bounds, and changes nothing", async () => {
    const before = await versions(id);
    const asked = await ok(admin("a"), "POST", `/api/services/${id}/adjustable/param-floor`, {
      value: "0.3",
      note: "Too many checks reach us.",
    });
    expect(asked.outcome).toBe("requested");
    expect(asked.request).toMatchObject({ id: expect.any(String), number: expect.any(Number) });
    expect(asked.message).toContain(`request #${asked.request.number}`);
    expect(await versions(id)).toHaveLength(before.length);
    const [filed] = await H.t.db.select().from(issue).where(eq(issue.id, asked.request.id));
    expect(filed).toMatchObject({ tenantId: A().tenantId, agentId: id, source: "portal" });
    expect(filed?.title).toBe('Change "How sure a check must be" to 0.3');
    expect(filed?.description).toContain("It is outside what we set up: between 0.5 and 0.95.");
    expect(filed?.description).toContain("Why: Too many checks reach us.");
    const [created] = await H.t.db
      .select()
      .from(issueEvent)
      .where(eq(issueEvent.issueId, asked.request.id));
    expect((created?.payload as Json)?.about).toMatchObject({
      kind: "adjustable",
      agentId: id,
      settingId: "param-floor",
      asked: "0.3",
      current: "0.97",
    });
    // A schedule we don't offer is a request too.
    const other = await ok(admin("a"), "POST", `/api/services/${id}/adjustable/schedule-daily`, {
      value: "0 * * * *",
    });
    expect(other.outcome).toBe("requested");
    // Each change is logged on the agent's changes.
    const logged = await H.t.db.select().from(agentChange).where(eq(agentChange.agentId, id));
    expect(
      logged
        .map((c) => c.change as Json)
        .filter((c) => c.kind === "adjust")
        .map((c) => [c.setting, c.outcome]),
    ).toEqual([
      ["param-floor", "applied"],
      ["param-floor", "applied"],
      ["schedule-daily", "applied"],
      ["param-floor", "requested"],
      ["schedule-daily", "requested"],
    ]);
  });

  it("shows the change in the portal's manual by the client's own person", async () => {
    const manual = await ok(admin("a"), "GET", `/api/services/${id}/manual`);
    const floor = manual.decisions.find((d: Json) => d.id === "floor");
    expect(floor).toMatchObject({
      status: "changed",
      statusWords: "Changed",
      side: "client",
      by: expect.any(String),
      at: expect.any(String),
    });
    expect(forbiddenKeys(manual)).toEqual([]);
  });

  it("files feedback on a manual line as a request linked to it", async () => {
    const before = (await versions(id)).length;
    const send = (who: string, body: unknown) =>
      status(who, "POST", `/api/services/${id}/manual/feedback`, body);
    const res = await send(user("a"), {
      section: "decision",
      lineId: "floor",
      line: "A check below 80% sure goes to a person",
      because: "We check every record by hand anyway.",
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const [filed] = await H.t.db.select().from(issue).where(eq(issue.id, res.json.request.id));
    expect(filed?.title).toBe("Wrong in the manual: A check below 80% sure goes to a person");
    expect(filed?.description).toBe(
      [
        `On Record checker's manual (Decisions): "A check below 80% sure goes to a person"`,
        "",
        "This is wrong because: We check every record by hand anyway.",
      ].join("\n"),
    );
    const [created] = await H.t.db
      .select()
      .from(issueEvent)
      .where(eq(issueEvent.issueId, res.json.request.id));
    expect((created?.payload as Json)?.about).toMatchObject({
      kind: "manual_line",
      agentId: id,
      section: "decision",
      decisionId: "floor",
    });
    // A line from How it works has no decision to link.
    const how = await send(admin("a"), {
      section: "how",
      lineId: "update",
      line: "Update the record",
      because: "It doesn't do this.",
    });
    expect(how.status).toBe(200);
    // A decision the manual doesn't hold, or another client's agent: not found.
    expect(
      (await send(admin("a"), { section: "decision", lineId: "nope", line: "x", because: "y" }))
        .status,
    ).toBe(404);
    expect(
      (await send(admin("b"), { section: "decision", lineId: "floor", line: "x", because: "y" }))
        .status,
    ).toBe(404);
    // Nothing but the requests: no version.
    expect(await versions(id)).toHaveLength(before);
  });
});
