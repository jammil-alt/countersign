// Wave 3b (docs/plan.md §1.86, readers): every server reader of a stored bundle reads a published
// v4 version (processes) as well as a v3 one: the connectors a bundle needs, promotion's
// stripping, the account agent's publish guard, forks, copies and the reviewed update merge. Against
// a real database as cs_worker, with the harness's testkit.

import { TESTKIT_QUERY_TOOL, TESTKIT_UPDATE_TOOL } from "@countersign/connectors";
import {
  type AnyAgentBundle,
  cloneJson,
  holdsProcess,
  type ProcessAgentBundle,
  processes,
  toProcessBundle,
  uuidv7,
} from "@countersign/core";
import type { Tx } from "@countersign/db";
import { afterAll, describe, expect, it } from "vitest";
import {
  createHarness,
  type Harness,
  LOOKUP_STEP,
  makeBundle,
  UPDATE_STEP,
} from "../log/harness.test-helper";
import {
  copyClientAgent,
  createTemplate,
  createVersion,
  fork,
  getAgent,
  publish,
  requiredConnectors,
  updateOperational,
  validateForPublish,
} from "./agents";
import { createAutomation, publishAutomation } from "./automations";
import { createUpdateDraft, previewPromotion, stripForPromotion, updateInfo } from "./lineage";
import { convertLookup, skillContext } from "./skills";

const harness = await createHarness();
afterAll(() => harness?.close());

/** The harness's bundle read as v4 processes (ids kept), as the builder saves it. */
function v4Bundle(h: Harness, edit?: (b: ProcessAgentBundle) => void): ProcessAgentBundle {
  const b = toProcessBundle(makeBundle(), convertLookup(h.catalog, h.tools));
  edit?.(b);
  return b;
}

function processOf(b: AnyAgentBundle): processes.Process {
  const w = b.workflows[0]?.workflow;
  if (w?.schemaVersion !== 4) throw new Error("fixture: expected a process");
  return w;
}

function stepOf(b: AnyAgentBundle, id: string): processes.Step {
  const s = processes.findStep(processOf(b), id)?.step;
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

describe.skipIf(!harness)("readers of a published v4 version", () => {
  const h = harness as Harness;

  /** Binds a client A agent to A's testkit connection, so it publishes. */
  const bind = (tx: Tx, agentId: string) =>
    updateOperational(tx, { agentId, patch: { bindings: { testkit: h.A.connectionId } } });

  it("asks for the connector of a v4 read or write tool its skills don't name", () => {
    // No skills and no extra tools: only the process's write names the testkit.
    const b = v4Bundle(h, (x) => {
      x.definition.skills = [];
      processOf(x).steps = [
        { id: "w", name: "Write", kind: "write", tool: TESTKIT_UPDATE_TOOL, input: {} },
      ];
    });
    expect(requiredConnectors(b, {}, h.tools)).toEqual(["testkit"]);
    const read = v4Bundle(h, (x) => {
      x.definition.skills = [];
      processOf(x).steps = [
        { id: "r", name: "Read", kind: "read", tool: TESTKIT_QUERY_TOOL, input: {} },
      ];
    });
    expect(requiredConnectors(read, {}, h.tools)).toEqual(["testkit"]);
  });

  it("strips a v4 skill step's customized settings and literal record ids for promotion", () => {
    const record = uuidv7();
    const client = v4Bundle(h, (x) => {
      const s = stepOf(x, LOOKUP_STEP);
      if (s.kind !== "skill") throw new Error("fixture");
      s.customize = { settings: { vendor: record, tone: "plain" } };
      const w = stepOf(x, UPDATE_STEP);
      if (w.kind !== "write") throw new Error("fixture");
      w.input = { id: record, amount: "1.00" };
    });
    const out = stripForPromotion(client, makeBundle(), {});
    const s = stepOf(out, LOOKUP_STEP);
    const w = stepOf(out, UPDATE_STEP);
    if (s.kind !== "skill" || w.kind !== "write") throw new Error("fixture");
    expect(s.customize?.settings).toEqual({ tone: "plain" });
    // The base (v3) step's input is kept where the client's held a record id.
    expect(w.input).toEqual({ id: "{{trigger.id}}", amount: "1.00" });
    expect(JSON.stringify(out)).not.toContain(record);
  });

  it("refuses the account agent a v4 process step that pins an automation writing to a client's tool", async () => {
    await h.ops(async (tx) => {
      const made = await createAutomation(tx, {
        tenantId: null,
        definition: {
          schemaVersion: 1,
          slug: "fix-record",
          name: "Fix a record",
          steps: [
            {
              id: "write",
              name: "Write",
              kind: "action",
              tool: TESTKIT_UPDATE_TOOL,
              input: { id: "r1", amount: "1.00" },
            },
          ],
        },
        ctx: h.ctx,
      });
      await publishAutomation(tx, {
        automationId: made.automation.id,
        versionId: made.version.id,
        ctx: h.ctx,
      });
      const bundle = v4Bundle(h, (x) => {
        x.definition.kind = "platform";
        x.definition.skills = [];
        processOf(x).steps = [
          { id: "sub", name: "Fix it", kind: "process", process: "fix-record@1", input: {} },
        ];
      });
      const { agent: tpl } = await createTemplate(tx, {
        slug: "supervisor",
        bundle: { ...makeBundle(), definition: bundle.definition },
      });
      const version = await createVersion(tx, { agentId: tpl.id, bundle });
      const errors = await validateForPublish(tx, tpl, version.bundle, h.ctx);
      expect(errors.map((e) => [e.stepId, e.field, e.code])).toContainEqual([
        "sub",
        "process",
        "tool_not_allowed",
      ]);
    });
  });

  it("offers a template's v4 version to its v3 fork as a reviewed update, never applied", async () => {
    const { a, c1, t2 } = await h.ops(async (tx) => {
      const { agent: tpl, version: t1 } = await createTemplate(tx, {
        slug: "v4-update",
        bundle: makeBundle(),
      });
      await publish(tx, { agentId: tpl.id, versionId: t1.id, ctx: h.ctx });
      const { agent: a, version: c1 } = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "v4-update",
        templateVersionId: t1.id,
      });
      await bind(tx, a.id);
      await publish(tx, { agentId: a.id, versionId: c1.id, ctx: h.ctx });
      const next = v4Bundle(h, (x) => {
        stepOf(x, UPDATE_STEP).name = "Update the record";
      });
      const v2 = await createVersion(tx, { agentId: tpl.id, bundle: next });
      const t2 = await publish(tx, { agentId: tpl.id, versionId: v2.id, ctx: h.ctx });
      return { a, c1, t2 };
    });
    const info = await h.ops((tx) => updateInfo(tx, { agentId: a.id }));
    expect(info.available).toBe(true);
    expect(info.templateLive?.id).toBe(t2.id);
    const { version } = await h.ops((tx) =>
      createUpdateDraft(tx, { agentId: a.id, actorId: h.operatorId, ctx: h.ctx }),
    );
    expect(holdsProcess(version.bundle)).toBe(true);
    expect(stepOf(version.bundle, UPDATE_STEP).name).toBe("Update the record");
    expect(version.status).toBe("draft");
    expect(version.authorType).toBe("merge");
    // Invariant 11: the client agent still runs the version it had until the operator publishes.
    expect((await h.ops((tx) => getAgent(tx, a.id))).liveVersionId).toBe(c1.id);
  });

  it("forks, copies and promotes a published v4 version with its ids", async () => {
    const record = uuidv7();
    const { live, forked, copy } = await h.ops(async (tx) => {
      // A template's v1 (v3) and its v2 of v4 processes, published: what the builder saves.
      const { agent: tpl } = await createTemplate(tx, { slug: "v4-fork", bundle: makeBundle() });
      const t2 = await createVersion(tx, { agentId: tpl.id, bundle: v4Bundle(h) });
      const live = await publish(tx, { agentId: tpl.id, versionId: t2.id, ctx: h.ctx });
      const forked = await fork(tx, {
        tenantId: h.A.tenantId,
        slug: "v4-fork",
        templateVersionId: live.id,
      });
      await bind(tx, forked.agent.id);
      const edited = cloneJson(forked.version.bundle);
      const w = stepOf(edited, UPDATE_STEP);
      if (w.kind !== "write") throw new Error("fixture");
      w.input = { ...w.input, id: record };
      stepOf(edited, LOOKUP_STEP).name = "Look it up for A";
      const c2 = await createVersion(tx, { agentId: forked.agent.id, bundle: edited });
      await publish(tx, { agentId: forked.agent.id, versionId: c2.id, ctx: h.ctx });
      const copy = await copyClientAgent(tx, {
        tenantId: h.A.tenantId,
        slug: "v4-fork-copy",
        sourceAgentId: forked.agent.id,
        ctx: h.ctx,
      });
      return { live, forked, copy };
    });
    expect(forked.version.bundleHash).toBe(live.bundleHash);
    expect(forked.version.basedOnTemplateVersionId).toBe(live.id);
    expect(processes.nodeIds(processOf(forked.version.bundle))).toContain(UPDATE_STEP);
    // The copy is stripped of the client's record id, as promotion strips it.
    expect(JSON.stringify(copy.version.bundle)).not.toContain(record);
    expect(holdsProcess(copy.version.bundle)).toBe(true);
    const preview = await h.ops((tx) =>
      previewPromotion(tx, { agentId: forked.agent.id, ctx: h.ctx }),
    );
    expect(JSON.stringify(preview.stripped)).not.toContain(record);
    expect(preview.result.clean).toBe(true);
    expect(stepOf(preview.result.bundle, LOOKUP_STEP).name).toBe("Look it up for A");
    // The fork needs the testkit bound, from the v4 version's skills and write alike.
    const { skills } = await h.ops((tx) =>
      skillContext(tx, {
        tenantId: h.A.tenantId,
        bundle: forked.version.bundle,
        catalog: h.catalog,
      }),
    );
    expect(requiredConnectors(forked.version.bundle, skills, h.tools)).toEqual(["testkit"]);
  });
});
