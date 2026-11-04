// Agent and skill versions, forking, operational fields and activation, against a real database
// as cs_worker (RLS and grants apply).

import { cloneJson, nodeIds } from "@countersign/core";
import { agent, agentChange, connection, run, skill } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { AgentsError } from "../errors";
import {
  ALERT_SKILL,
  createHarness,
  type Harness,
  LOOKUP_STEP,
  makeBundle,
} from "../log/harness.test-helper";
import { createRun, finishRun } from "../log/run-log";
import {
  activate,
  activationProblems,
  createTemplate,
  createVersion,
  fork,
  getAgent,
  listVersions,
  pause,
  publish,
  rollback,
  updateOperational,
} from "./agents";
import {
  createSkill,
  createSkillVersion,
  publishSkill,
  resolveCustomSkill,
  rollbackSkill,
} from "./skills";

const harness = await createHarness();

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    if (e instanceof AgentsError) return e.code;
    throw e;
  }
  return undefined;
}

afterAll(() => harness?.close());

describe.skipIf(!harness)("agent registry", () => {
  const h = harness as Harness;

  it("versions: no-op refused, publish, rollback as a copy", async () => {
    await h.ops(async (tx) => {
      const { agent: tpl, version: v1 } = await createTemplate(tx, {
        slug: "versions",
        bundle: makeBundle(),
      });
      expect(v1.version).toBe(1);
      expect(v1.status).toBe("draft");
      expect(await code(createVersion(tx, { agentId: tpl.id, bundle: makeBundle() }))).toBe(
        "no_op",
      );

      await publish(tx, { agentId: tpl.id, versionId: v1.id, ctx: h.ctx });
      const v2 = await createVersion(tx, {
        agentId: tpl.id,
        bundle: makeBundle({ instructions: "Check records twice." }),
        changeNote: "stricter",
      });
      expect(v2.version).toBe(2);
      expect(v2.parentVersionId).toBe(v1.id);
      await publish(tx, { agentId: tpl.id, versionId: v2.id, ctx: h.ctx });

      const live = await rollback(tx, { agentId: tpl.id, toVersionId: v1.id, ctx: h.ctx });
      expect(live.version).toBe(3);
      expect(live.bundleHash).toBe(v1.bundleHash);
      expect(live.parentVersionId).toBe(v2.id);
      expect(live.changeNote).toBe("Rollback to v1");
      expect((await getAgent(tx, tpl.id)).liveVersionId).toBe(live.id);
      const statuses = (await listVersions(tx, tpl.id)).map((v) => [v.version, v.status]);
      expect(statuses).toEqual([
        [3, "live"],
        [2, "retired"],
        [1, "retired"],
      ]);
      // Rolling back to what is already live is a no-op.
      expect(await code(rollback(tx, { agentId: tpl.id, toVersionId: v1.id, ctx: h.ctx }))).toBe(
        "no_op",
      );
    });
  });

  it("publish refuses a bundle that does not validate", async () => {
    await h.ops(async (tx) => {
      const bad = makeBundle();
      const wf = bad.workflows[0];
      if (wf?.workflow.steps[0]?.kind !== "skill") throw new Error("fixture");
      wf.workflow.steps[0].skill = "test.nope";
      const { agent: tpl, version } = await createTemplate(tx, { slug: "invalid", bundle: bad });
      const err = await publish(tx, { agentId: tpl.id, versionId: version.id, ctx: h.ctx }).catch(
        (e: AgentsError) => e,
      );
      expect(err).toBeInstanceOf(AgentsError);
      expect((err as AgentsError).code).toBe("invalid_bundle");
      expect(JSON.stringify((err as AgentsError).details)).toContain("unknown_skill");
    });
  });

  it("fork keeps step ids and records its base; templates stay invisible to client sessions", async () => {
    const { tplId, tv } = await h.ops(async (tx) => {
      const { agent: tpl, version } = await createTemplate(tx, {
        slug: "forkable",
        bundle: makeBundle(),
      });
      const live = await publish(tx, { agentId: tpl.id, versionId: version.id, ctx: h.ctx });
      return { tplId: tpl.id, tv: live };
    });
    const forked = await h.ops((tx) =>
      fork(tx, { tenantId: h.A.tenantId, slug: "checker", templateVersionId: tv.id }),
    );
    expect(forked.agent.tenantId).toBe(h.A.tenantId);
    expect(forked.agent.templateId).toBe(tplId);
    expect(forked.agent.linked).toBe(true);
    expect(forked.agent.runStatus).toBe("draft");
    expect(forked.version.version).toBe(1);
    expect(forked.version.basedOnTemplateVersionId).toBe(tv.id);
    expect(forked.version.bundle).toEqual(tv.bundle);
    expect(forked.version.bundleHash).toBe(tv.bundleHash);
    const ids = (b: typeof tv.bundle) => b.workflows.flatMap((w) => nodeIds(w.workflow));
    expect(ids(forked.version.bundle)).toEqual(ids(tv.bundle));
    expect(ids(forked.version.bundle)).toContain(LOOKUP_STEP);

    // A client session can't see the template, so it can't fork it either.
    const seen = await h.client(h.A, (tx) => tx.select().from(agent).where(eq(agent.id, tplId)));
    expect(seen).toEqual([]);
    expect(
      await code(
        h.client(h.A, (tx) =>
          fork(tx, { tenantId: h.A.tenantId, slug: "sneaky", templateVersionId: tv.id }),
        ),
      ),
    ).toBe("not_found");
    // Client B sees nothing of A's fork.
    const fromB = await h.client(h.B, (tx) =>
      tx.select().from(agent).where(eq(agent.id, forked.agent.id)),
    );
    expect(fromB).toEqual([]);
  });

  it("operational fields change without a version and are logged; bindings stay in-client", async () => {
    const { agent: a } = await h.ops(async (tx) => {
      const { version } = await createTemplate(tx, { slug: "ops-fields", bundle: makeBundle() });
      return fork(tx, {
        tenantId: h.A.tenantId,
        slug: "ops-fields",
        templateVersionId: version.id,
      });
    });
    await h.ops(async (tx) => {
      const updated = await updateOperational(tx, {
        agentId: a.id,
        actorId: h.operatorId,
        patch: {
          bindings: { testkit: h.A.connectionId },
          approver: "operator",
          serviceName: "Checks",
        },
      });
      expect(updated.bindings).toEqual({ testkit: h.A.connectionId });
      expect(updated.approver).toBe("operator");
      expect((await listVersions(tx, a.id)).length).toBe(1);
      const changes = await tx.select().from(agentChange).where(eq(agentChange.agentId, a.id));
      expect(changes.map((c) => (c.change as { kind: string }).kind)).toContain("operational");
      // B's connection can't be bound to A's agent.
      expect(
        await code(
          updateOperational(tx, {
            agentId: a.id,
            patch: { bindings: { testkit: h.B.connectionId } },
          }),
        ),
      ).toBe("invalid_state");
    });
  });

  it("activation refuses until bound, published and test-run; pause stops it", async () => {
    const { agent: a, version } = await h.ops(async (tx) => {
      const { version: tv } = await createTemplate(tx, { slug: "activate", bundle: makeBundle() });
      return fork(tx, { tenantId: h.A.tenantId, slug: "activate", templateVersionId: tv.id });
    });
    const problems0 = await h.ops((tx) => activationProblems(tx, { agentId: a.id, ctx: h.ctx }));
    expect(problems0.join()).toContain("no live version");

    // Publishing an unbound client agent fails: its action step needs the testkit connection.
    expect(
      await code(h.ops((tx) => publish(tx, { agentId: a.id, versionId: version.id, ctx: h.ctx }))),
    ).toBe("invalid_bundle");
    await h.ops((tx) =>
      updateOperational(tx, { agentId: a.id, patch: { bindings: { testkit: h.A.connectionId } } }),
    );
    await h.ops((tx) => publish(tx, { agentId: a.id, versionId: version.id, ctx: h.ctx }));

    const problems1 = await h.ops((tx) => activationProblems(tx, { agentId: a.id, ctx: h.ctx }));
    expect(problems1).toEqual(["v1 has no passing test run on this client"]);
    expect(await code(h.ops((tx) => activate(tx, { agentId: a.id, ctx: h.ctx })))).toBe(
      "activation_refused",
    );

    // A failed test run doesn't count; a succeeded one does.
    await h.client(h.A, async (tx) => {
      const failed = await createRun(tx, {
        tenantId: h.A.tenantId,
        agentId: a.id,
        workflowSlug: "check-record",
        mode: "test",
      });
      await finishRun(tx, { tenantId: h.A.tenantId, runId: failed.id, status: "failed" });
    });
    expect(await code(h.ops((tx) => activate(tx, { agentId: a.id, ctx: h.ctx })))).toBe(
      "activation_refused",
    );
    await h.client(h.A, async (tx) => {
      const ok = await createRun(tx, {
        tenantId: h.A.tenantId,
        agentId: a.id,
        workflowSlug: "check-record",
        mode: "test",
      });
      expect(ok.config).toEqual({
        bindings: { testkit: h.A.connectionId },
        approver: null,
        approverRules: { revision: 0, rules: [] },
      });
      await finishRun(tx, { tenantId: h.A.tenantId, runId: ok.id, status: "succeeded" });
    });
    const active = await h.ops((tx) => activate(tx, { agentId: a.id, ctx: h.ctx }));
    expect(active.runStatus).toBe("active");

    // A disconnected connection blocks activation again.
    await h.ops((tx) => pause(tx, { agentId: a.id }));
    await h.t.db
      .update(connection)
      .set({ status: "disconnected" })
      .where(eq(connection.id, h.A.connectionId));
    const problems2 = await h.ops((tx) => activationProblems(tx, { agentId: a.id, ctx: h.ctx }));
    expect(problems2).toEqual(["the testkit connection is disconnected"]);
    await h.t.db
      .update(connection)
      .set({ status: "pending" })
      .where(eq(connection.id, h.A.connectionId));
    const runs = await h.client(h.A, (tx) => tx.select().from(run).where(eq(run.agentId, a.id)));
    expect(runs.length).toBe(2);
    // Paused: no live runs start.
    expect(
      await code(
        h.client(h.A, (tx) =>
          createRun(tx, {
            tenantId: h.A.tenantId,
            agentId: a.id,
            workflowSlug: "check-record",
            mode: "live",
          }),
        ),
      ),
    ).toBe("invalid_state");
  });
});

describe.skipIf(!harness)("skill registry", () => {
  const h = harness as Harness;
  const def = (instructions: string) => ({
    ...cloneJson(ALERT_SKILL),
    id: "custom:price-check",
    name: "Price check",
    instructions,
    producesAlerts: false,
  });

  it("operator skills: no-op refused, publish, rollback; shared skills are snapshotted into a client at publish", async () => {
    const shared = await h.ops(async (tx) => {
      const created = await createSkill(tx, {
        tenantId: null,
        definition: def("v1"),
        tools: h.tools,
      });
      expect(
        await code(createSkillVersion(tx, { skillId: created.skill.id, definition: def("v1") })),
      ).toBe("no_op");
      await publishSkill(tx, { skillId: created.skill.id, versionId: created.version.id });
      const v2 = await createSkillVersion(tx, { skillId: created.skill.id, definition: def("v2") });
      await publishSkill(tx, { skillId: created.skill.id, versionId: v2.id });
      const back = await rollbackSkill(tx, {
        skillId: created.skill.id,
        toVersionId: created.version.id,
      });
      expect(back.version).toBe(3);
      expect(back.definition.instructions).toBe("v1");
      return created.skill;
    });
    // Operator skills must be agent mode with known tools.
    expect(
      await code(
        h.ops((tx) =>
          createSkill(tx, {
            tenantId: null,
            definition: { ...def("x"), id: "custom:bad", tools: ["nope.tool"] },
            tools: h.tools,
          }),
        ),
      ),
    ).toBe("invalid_definition");

    // A client session can't read the shared skill...
    expect(
      await h.client(h.A, (tx) =>
        resolveCustomSkill(tx, { tenantId: h.A.tenantId, ref: "custom:price-check" }),
      ),
    ).toBeNull();

    // ...until a client agent that uses it is published (an operator session).
    const bundle = makeBundle({
      skills: [
        { skill: "test.lookup", settings: {} },
        { skill: "test.update-record", settings: {} },
        { skill: "custom:price-check", settings: {} },
      ],
    });
    await h.ops(async (tx) => {
      const { version: tv } = await createTemplate(tx, { slug: "uses-shared", bundle });
      const { agent: a, version } = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "uses-shared",
        templateVersionId: tv.id,
      });
      await updateOperational(tx, {
        agentId: a.id,
        patch: { bindings: { testkit: h.A.connectionId } },
      });
      await publish(tx, { agentId: a.id, versionId: version.id, ctx: h.ctx });
    });
    const resolved = await h.client(h.A, (tx) =>
      resolveCustomSkill(tx, { tenantId: h.A.tenantId, ref: "custom:price-check" }),
    );
    expect(resolved?.source).toBe("shared");
    expect(resolved?.version).toBe(3);
    expect(resolved?.definition.instructions).toBe("v1");
    // B got nothing.
    const bSkills = await h.client(h.B, (tx) => tx.select().from(skill));
    expect(bSkills).toEqual([]);
    expect(shared.tenantId).toBeNull();
  });
});
