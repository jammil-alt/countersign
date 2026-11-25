// Step model §8 (stream H): a Loop skill is agent mode that only reads. It is refused when saved
// with an action that isn't a Get, has no switch on its test set (publishing needs at least one
// case and every case passing on that exact version), has no one-step rollback, and keeps its turns
// with each case's result. Against a real database as cs_worker, with the FakeModel.

import { resolveCustomSkill, runSkillCase } from "@countersign/agents";
import {
  type LoopTestCase,
  matchOutput,
  newSkillVersionProblems,
  type SkillDefinition,
  toolLookup,
} from "@countersign/core";
import { skillVersion, testCase, withOperator } from "@countersign/db";
import { FakeModel, type FakeTurn } from "@countersign/llm";
import { RECONCILE_SKILLS } from "@countersign/pack-bookkeeping";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { installLibrarySkills } from "./routes/packs";
import { MemoryTestSuiteJobs } from "./testbench/instances";
import { executeSuite, type SuiteParams } from "./testbench/suite";

const jobs = new MemoryTestSuiteJobs();
const h = await createApiHarness({ testSuites: jobs });
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const loopDef = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: "custom:find-why",
  name: "Find why",
  description: "Looks a record up and says why it is off",
  category: "investigation",
  mode: "agent",
  instructions: "Look the record up. Say why it is off.",
  tools: [],
  reads: ["testkit.record.query"],
  loop: { goal: "Say why the record is off.", maxTurns: 4, atLimit: "hand_back" },
  input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  output: {
    type: "object",
    properties: { why: { type: "string" } },
    required: ["why"],
  },
  ...over,
});

async function runSuite(params: SuiteParams, transport: FakeModel) {
  const H = h as ApiHarness;
  return executeSuite({ db: H.db, platform: H.platform, transport }, params, {
    do: (_name, fn) => fn(),
  });
}

describe.skipIf(!h)("Loop skills (step model §8)", () => {
  const H = h as ApiHarness;
  let skillId = "";
  let v1 = "";

  it("is refused when it lists an action that isn't a Get, or has tools of its own", async () => {
    const write = await H.call(OPERATOR, "POST", "/api/ops/skills", {
      definition: loopDef({ reads: ["testkit.record.update"] }),
    });
    expect(write.status).toBe(422);
    expect(JSON.stringify(write.json)).toContain("A Loop only reads");
    const tools = await H.call(OPERATOR, "POST", "/api/ops/skills", {
      definition: loopDef({ tools: ["testkit.record.query"] }),
    });
    expect(tools.status).toBe(422);
    const none = await H.call(OPERATOR, "POST", "/api/ops/skills", {
      definition: loopDef({ reads: [] }),
    });
    expect(none.status).toBe(422);
    expect(JSON.stringify(none.json)).toContain("at least one action");
    // Agent mode without a loop stays retired.
    const plain = await H.call(OPERATOR, "POST", "/api/ops/skills", {
      definition: loopDef({ loop: undefined }),
    });
    expect(plain.status).toBe(422);
  });

  it("saves with Get actions only, as a draft", async () => {
    const created = await H.call(OPERATOR, "POST", "/api/ops/skills", { definition: loopDef() });
    expect(created.status, JSON.stringify(created.json)).toBe(200);
    skillId = j(created.json).skill.id;
    v1 = j(created.json).version.id;
    expect(j(created.json).version.status).toBe("draft");
    // A new version with a write is refused too.
    const next = await H.call(OPERATOR, "POST", `/api/ops/skills/${skillId}/versions`, {
      definition: loopDef({ reads: ["testkit.record.query", "testkit.record.update"] }),
    });
    expect(next.status).toBe(422);
  });

  it("can't be published without a test set, and the gate has no switch", async () => {
    const empty = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/skills/${skillId}/versions/${v1}/publish`,
    );
    expect(empty.status).toBe(422);
    expect(j(empty.json).error.code).toBe("tests_failing");
    expect(j(empty.json).error.message).toContain("needs a test set");
    const off = await H.call(OPERATOR, "PUT", `/api/ops/skills/${skillId}/require-tests`, {
      required: false,
      reason: "Just this once",
    });
    expect(off.status).toBe(422);
    expect(j(off.json).error.code).toBe("loop_tests_required");
    const still = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/skills/${skillId}/versions/${v1}/publish`,
    );
    expect(still.status).toBe(422);
  });

  it("publishes once every case passes on that version, keeping each turn", async () => {
    const made = await H.call(OPERATOR, "POST", "/api/ops/tests", {
      targetKind: "skill",
      targetId: skillId,
      name: "r1 is a duplicate",
      input: { id: "r1" },
      fixtures: [
        {
          tool: "testkit.record.query",
          input: { ids: ["r1"] },
          output: { records: [{ id: "r1", amount: "12.50", duplicateOf: "r0" }] },
        },
      ],
      expected: { why: "duplicate of r0" },
      matcher: { kind: "subset" },
      // Not marked required: a Loop's whole set gates it.
      required: false,
    });
    expect(made.status, JSON.stringify(made.json)).toBe(200);

    // A failing run: the gate stays shut.
    await H.call(OPERATOR, "POST", "/api/ops/tests/run", {
      targetKind: "skill",
      targetId: skillId,
      versionId: v1,
    });
    await runSuite(
      jobs.started.at(-1) as SuiteParams,
      new FakeModel([
        { toolUse: { name: "testkit__record__query", input: { ids: ["r1"] } } },
        { toolUse: { name: "finish", input: { why: "a typo" } } },
      ]),
    );
    const shut = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/skills/${skillId}/versions/${v1}/publish`,
    );
    expect(shut.status).toBe(422);
    expect(j(shut.json).error.message).toContain("did not pass");

    // A passing run on the same version opens it.
    await H.call(OPERATOR, "POST", "/api/ops/tests/run", {
      targetKind: "skill",
      targetId: skillId,
      versionId: v1,
    });
    const params = jobs.started.at(-1) as SuiteParams;
    await runSuite(
      params,
      new FakeModel([
        {
          text: "Look r1 up first.",
          toolUse: { name: "testkit__record__query", input: { ids: ["r1"] } },
        },
        { toolUse: { name: "finish", input: { why: "duplicate of r0" } } },
      ]),
    );
    const run = await H.call(OPERATOR, "GET", `/api/ops/tests/runs/${params.suiteRunId}`);
    const result = j(run.json).results[0];
    expect(result.status).toBe("pass");
    expect(result.diff.turns).toHaveLength(2);
    expect(result.diff.turns[0]).toMatchObject({
      n: 1,
      said: "Look r1 up first.",
      finished: false,
      calls: [{ tool: "testkit.record.query", status: "succeeded" }],
    });
    expect(result.diff.turns[0].calls[0].output).toMatchObject({
      records: [{ duplicateOf: "r0" }],
    });
    expect(result.diff.turns[1]).toMatchObject({ finished: true });

    const ok = await H.call(OPERATOR, "POST", `/api/ops/skills/${skillId}/versions/${v1}/publish`);
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(j(ok.json).version.status).toBe("live");
  });

  it("is gated per version: a new draft needs its own passing run", async () => {
    const saved = await H.call(OPERATOR, "POST", `/api/ops/skills/${skillId}/versions`, {
      definition: loopDef({ instructions: "Look the record up twice if you must." }),
    });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    const v2 = j(saved.json).version.id;
    const shut = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/skills/${skillId}/versions/${v2}/publish`,
    );
    expect(shut.status).toBe(422);
    expect(j(shut.json).error.message).toContain("run the test set");
  });

  it("can't be rolled back in one step", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/skills/${skillId}/rollback`, {
      versionId: v1,
    });
    expect(res.status).toBe(422);
    expect(j(res.json).error.code).toBe("loop_rollback");
  });

  // The first Loop: the Bookkeeping leftovers investigation, read only (§10a).
  describe("the Bookkeeping leftovers Loop", () => {
    const def = RECONCILE_SKILLS.find((x) => x.id === "bookkeeping.investigate-leftovers");
    const ITEM_A = "11111111-1111-4111-8111-111111111111";
    const ITEM_B = "22222222-2222-4222-8222-222222222222";
    const RECON = "33333333-3333-4333-8333-333333333333";

    it("only reads, by the platform's own tools", () => {
      if (!def) throw new Error("the Loop isn't in the pack");
      const lookup = toolLookup(H.platform.tools.specs());
      expect(newSkillVersionProblems(def, lookup)).toEqual([]);
      for (const t of def.reads ?? []) expect(lookup(t)?.sideEffect, t).toBe("none");
    });

    it("looks, then hands back proposals, and a write it tries is refused", async () => {
      if (!def) throw new Error("the Loop isn't in the pack");
      const model = new FakeModel([
        {
          text: "Open the reconciliation.",
          toolUse: { name: "bookkeeping__reconcile__open", input: { reconciliationId: RECON } },
        },
        // It tries to propose the match itself: not an action a Loop is offered.
        {
          toolUse: {
            name: "bookkeeping__reconcile__propose",
            input: {
              reconciliationId: RECON,
              aItemIds: [ITEM_A],
              bItemIds: [ITEM_B],
              reason: "same deposit",
              confidence: 0.9,
            },
          },
        },
        {
          toolUse: {
            name: "finish",
            input: {
              proposals: [
                {
                  aItemIds: [ITEM_A],
                  bItemIds: [ITEM_B],
                  reason: "The same deposit, dated two days apart.",
                  confidence: 0.9,
                },
              ],
              unexplained: "Nothing else is left.",
              sources: [RECON, ITEM_A, ITEM_B],
            },
          },
        },
      ]);
      const run = await runSkillCase(
        { tools: H.platform.tools, transport: model },
        {
          definition: def,
          tenantId: null,
          input: { reconciliationId: RECON },
          fixtures: [
            {
              tool: "bookkeeping.reconcile.open",
              output: {
                reconciliationId: RECON,
                unmatched: [
                  { id: ITEM_A, side: "a", effect: "250.00", description: "Deposit" },
                  { id: ITEM_B, side: "b", effect: "250.00", description: "DEP 0412" },
                ],
              },
            },
          ],
        },
      );
      expect(run.status, run.error ?? "").toBe("succeeded");
      expect(run.output).toMatchObject({ proposals: [{ aItemIds: [ITEM_A] }] });
      expect(run.turns.map((t) => t.calls.map((c) => [c.tool, c.status]))).toEqual([
        [["bookkeeping.reconcile.open", "succeeded"]],
        [["bookkeeping.reconcile.propose", "refused"]],
        [],
      ]);
      expect(run.turns[2]?.finished).toBe(true);
      // Only the reads were offered.
      const offered = (model.requests[0]?.tools ?? []).map((t) => t.name);
      expect(offered).toEqual(
        expect.arrayContaining(["bookkeeping__reconcile__open", "bookkeeping__transactions__open"]),
      );
      expect(offered).not.toContain("bookkeeping__reconcile__propose");
    });
  });

  // Review of #681: the test-set gate has no side doors.
  describe("a Loop that never passed its tests can't be used", () => {
    const REF = "custom:find-why";
    const bundleWith = (slug: string, step: Record<string, unknown>, skillRef?: string) => ({
      schemaVersion: 1,
      definition: {
        schemaVersion: 2,
        identity: { name: "Investigator", role: "looks into things", mission: "Find out why." },
        kind: "functional",
        model: { id: "claude-opus-5-5", maxTokens: 1024 },
        instructions: "Only do what the workflow says.",
        skills: skillRef ? [{ skill: skillRef, settings: {} }] : [],
        extraTools: [],
        canCommand: [],
        permissions: { mode: "suggest_only" },
        budgets: { maxSteps: 12, maxCostUsd: "0.50" },
        memory: { enabled: false },
      },
      workflows: [
        {
          slug,
          name: "Look into it",
          workflow: {
            schemaVersion: 5,
            triggers: [{ id: "trg", on: { type: "manual", input: {} } }],
            outputs: [
              {
                id: "o_report",
                name: "What it found",
                kind: "report",
                report: { to: ["client_admin"], message: "{{steps.s_loop.output.why}}" },
              },
            ],
            steps: [
              {
                id: "s_loop",
                kind: "loop",
                name: "Find why",
                goal: "Say why the record is off.",
                reads: ["testkit.record.query"],
                output: [{ name: "why", type: "text", required: true }],
                ...step,
              },
              { id: "s_end", kind: "end", name: "Report it", outputs: ["o_report"] },
            ],
          },
        },
      ],
    });
    const publishTemplate = async (slug: string, bundle: unknown) => {
      const made = await H.call(OPERATOR, "POST", "/api/ops/templates", { slug, bundle });
      expect(made.status, JSON.stringify(made.json)).toBe(200);
      return H.call(
        OPERATOR,
        "POST",
        `/api/ops/agents/${j(made.json).agent.id}/versions/${j(made.json).version.id}/publish`,
      );
    };

    it("refuses an agent whose Loop is written in the step", async () => {
      const res = await publishTemplate("loop-inline", bundleWith("main", {}));
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.json)).toContain(
        "Save this Loop as a skill and pass its tests before publishing.",
      );
    });

    it("refuses a pinned version that is still a draft, and a run can't resolve it", async () => {
      // v1 is live (above); v2 is a draft whose tests never passed.
      const [v2] = await H.t.db
        .select()
        .from(skillVersion)
        .where(and(eq(skillVersion.skillId, skillId), eq(skillVersion.version, 2)));
      expect(v2?.status).toBe("draft");
      const res = await publishTemplate(
        "loop-draft",
        bundleWith("main", { skill: `${REF}@2` }, `${REF}@2`),
      );
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.json)).toContain("is a draft");
      await withOperator(H.db, [], async (tx) => {
        expect(await resolveCustomSkill(tx, { tenantId: null, ref: `${REF}@2` })).toBeNull();
        // The live one resolves, pinned or not; the designer's own newest lookup still sees the draft.
        expect(await resolveCustomSkill(tx, { tenantId: null, ref: `${REF}@1` })).toMatchObject({
          version: 1,
        });
        expect(await resolveCustomSkill(tx, { tenantId: null, ref: REF })).toMatchObject({
          version: 1,
        });
        expect(
          await resolveCustomSkill(tx, { tenantId: null, ref: REF, newest: true }),
        ).toMatchObject({ version: 2 });
      });
    });

    it("publishes an agent whose Loop is the saved, published one", async () => {
      const res = await publishTemplate(
        "loop-saved",
        bundleWith("main", { skill: `${REF}@1` }, `${REF}@1`),
      );
      expect(res.status, JSON.stringify(res.json)).toBe(200);
    });

    it("refuses a step that names a skill that isn't a Loop", async () => {
      const res = await publishTemplate(
        "loop-not",
        bundleWith("main", { skill: "docs.extract" }, "docs.extract"),
      );
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.json)).toContain("isn't a Loop");
    });

    it("won't install a pack's Loop without its test set, and keeps its cases when it has one", async () => {
      const def = {
        ...loopDef({ id: "custom:pack-loop", name: "Pack Loop" }),
      } as unknown as SkillDefinition;
      const services = { platform: H.platform } as never;
      const pack = (loopTests: unknown) =>
        ({
          manifest: { name: "Test", version: "1", librarySkills: [def], loopTests },
          handlers: {},
        }) as never;
      await expect(
        withOperator(H.db, [], (tx) =>
          installLibrarySkills(tx, services, pack(undefined), H.A.admin),
        ),
      ).rejects.toThrow(/ships it without a test set/);
      const cases: LoopTestCase[] = [
        {
          name: "r1",
          input: { id: "r1" },
          fixtures: [],
          replay: [{ call: { tool: "finish", input: { why: "x" } } }],
          expected: { why: "x" },
          matcher: { kind: "subset", tolerances: {} },
        },
      ];
      const made = await withOperator(H.db, [], (tx) =>
        installLibrarySkills(tx, services, pack({ "custom:pack-loop": cases }), H.A.admin),
      );
      expect(made).toHaveLength(1);
      const kept = await H.t.db
        .select()
        .from(testCase)
        .where(eq(testCase.targetId, made[0]?.skillId ?? ""));
      expect(kept.map((c) => c.name)).toEqual(["r1"]);
    });
  });

  // Every Loop a pack or the platform ships carries its test set, and CI replays it.
  describe("shipped Loops", () => {
    const turns = (c: LoopTestCase): FakeTurn[] =>
      c.replay.map((t) => ({
        ...(t.said ? { text: t.said } : {}),
        toolUse: { name: t.call.tool.replaceAll(".", "__"), input: t.call.input },
      }));

    it("has a test set for every built-in Loop", () => {
      const shipped = new Set(
        H.platform.packs.flatMap((p) => Object.keys(p.manifest.loopTests ?? {})),
      );
      for (const def of H.platform.catalog.list()) {
        if (def.loop) expect(shipped.has(def.id), `${def.id} ships without a test set`).toBe(true);
      }
    });

    it("passes every shipped test set in replay", async () => {
      let ran = 0;
      for (const pack of H.platform.packs) {
        const defs = [...pack.manifest.skills, ...(pack.manifest.librarySkills ?? [])];
        for (const [id, cases] of Object.entries(pack.manifest.loopTests ?? {})) {
          const def = defs.find((d) => d.id === id);
          if (!def) throw new Error(`${id} has a test set but no skill`);
          for (const c of cases) {
            const run = await runSkillCase(
              { tools: H.platform.tools, transport: new FakeModel(turns(c)) },
              { definition: def, tenantId: null, input: c.input, fixtures: c.fixtures },
            );
            expect(run.status, `${id} / ${c.name}: ${run.error}`).toBe("succeeded");
            const match = matchOutput(c.matcher, c.expected, run.output);
            expect(match.pass, `${id} / ${c.name}: ${JSON.stringify(match.diff)}`).toBe(true);
            // A replay never writes: every call it made was a read the fixtures answered.
            expect(run.toolCalls.every((t) => t.status === "succeeded")).toBe(true);
            ran += 1;
          }
        }
      }
      expect(ran).toBeGreaterThan(0);
    });
  });
});
