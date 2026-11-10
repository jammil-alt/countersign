// Template updates (three-way merge into a client draft) and promotion (into a template draft,
// client-specific values stripped), against a real database as cs_worker.

import {
  type AgentBundle,
  type AnyAgentBundle,
  cloneJson,
  holdsProcess,
  selectableBetween,
  uuidv7,
} from "@countersign/core";
import { afterAll, describe, expect, it } from "vitest";
import type { AgentsError } from "../errors";
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
  detach,
  fork,
  publish,
  relink,
  updateOperational,
} from "./agents";
import {
  createPromotionDraft,
  createUpdateDraft,
  holdsRecordId,
  previewPromotion,
  previewUpdate,
  updateInfo,
} from "./lineage";

const harness = await createHarness();
afterAll(() => harness?.close());

/** A stored bundle these fixtures made of v3 workflows (the column holds v3 or v4). */
function v3(bundle: AnyAgentBundle): AgentBundle {
  if (holdsProcess(bundle)) throw new Error("fixture: expected v3 workflows");
  return bundle as AgentBundle;
}

function step(bundle: AnyAgentBundle, id: string) {
  const s = v3(bundle).workflows[0]?.workflow.steps.find((x) => x.id === id);
  if (!s) throw new Error(`no step ${id}`);
  return s;
}

function edit(bundle: AnyAgentBundle, fn: (b: AgentBundle) => void): AgentBundle {
  const out = cloneJson(v3(bundle));
  fn(out);
  return out;
}

describe.skipIf(!harness)("template updates and promotion", () => {
  const h = harness as Harness;

  /** A published template and a published fork of it in client A. */
  async function setup(slug: string, base: AgentBundle = makeBundle()) {
    return h.ops(async (tx) => {
      const { agent: tpl, version: t1 } = await createTemplate(tx, { slug, bundle: base });
      await publish(tx, { agentId: tpl.id, versionId: t1.id, ctx: h.ctx });
      const { agent: a, version: c1 } = await fork(tx, {
        tenantId: h.A.tenantId,
        slug,
        templateVersionId: t1.id,
      });
      await updateOperational(tx, {
        agentId: a.id,
        patch: { bindings: { testkit: h.A.connectionId } },
      });
      await publish(tx, { agentId: a.id, versionId: c1.id, ctx: h.ctx });
      return { tpl, t1, a, c1 };
    });
  }

  it("merges a template update with a client's customization into a merge draft", async () => {
    const { tpl, t1, a, c1 } = await setup("update-clean");
    const t2 = await h.ops(async (tx) => {
      const c2 = await createVersion(tx, {
        agentId: a.id,
        bundle: edit(c1.bundle, (b) => {
          step(b, LOOKUP_STEP).name = "Look it up for A";
        }),
      });
      await publish(tx, { agentId: a.id, versionId: c2.id, ctx: h.ctx });
      const v = await createVersion(tx, {
        agentId: tpl.id,
        bundle: edit(t1.bundle, (b) => {
          step(b, UPDATE_STEP).name = "Update the record";
        }),
        releaseNote: "Clearer step names",
      });
      return publish(tx, { agentId: tpl.id, versionId: v.id, ctx: h.ctx });
    });

    const info = await h.ops((tx) => updateInfo(tx, { agentId: a.id }));
    expect(info.available).toBe(true);
    expect(info.behind).toBe(1);
    expect(info.releaseNote).toBe("Clearer step names");

    const { version, preview } = await h.ops((tx) =>
      createUpdateDraft(tx, { agentId: a.id, actorId: h.operatorId, ctx: h.ctx }),
    );
    expect(preview.result.clean).toBe(true);
    expect(version.authorType).toBe("merge");
    expect(version.status).toBe("draft");
    expect(version.basedOnTemplateVersionId).toBe(t2.id);
    expect(version.mergedFromVersionIds).toEqual([t2.id]);
    expect(version.parentVersionId).toBe(preview.ours.id);
    expect(step(version.bundle, LOOKUP_STEP).name).toBe("Look it up for A");
    expect(step(version.bundle, UPDATE_STEP).name).toBe("Update the record");
    // Nothing published: the client's live version is unchanged until the operator publishes.
    const after = await h.ops((tx) => updateInfo(tx, { agentId: a.id }));
    expect(after.available).toBe(true);
  });

  it("reports conflicts, refuses the draft until they are resolved", async () => {
    const { tpl, t1, a, c1 } = await setup("update-conflict");
    await h.ops(async (tx) => {
      const c2 = await createVersion(tx, {
        agentId: a.id,
        bundle: edit(c1.bundle, (b) => {
          b.definition.instructions = "Client A's way.";
        }),
      });
      await publish(tx, { agentId: a.id, versionId: c2.id, ctx: h.ctx });
      const t2 = await createVersion(tx, {
        agentId: tpl.id,
        bundle: edit(t1.bundle, (b) => {
          b.definition.instructions = "The template's new way.";
        }),
      });
      await publish(tx, { agentId: tpl.id, versionId: t2.id, ctx: h.ctx });
    });
    const preview = await h.ops((tx) => previewUpdate(tx, { agentId: a.id }));
    expect(preview.result.clean).toBe(false);
    expect(preview.result.conflicts).toHaveLength(1);
    const conflict = preview.result.conflicts[0];
    expect(conflict?.ours).toBe("Client A's way.");
    expect(conflict?.theirs).toBe("The template's new way.");

    const err = await h
      .ops((tx) => createUpdateDraft(tx, { agentId: a.id, ctx: h.ctx }))
      .catch((e: AgentsError) => e);
    expect((err as AgentsError).code).toBe("merge_conflicts");

    const { version } = await h.ops((tx) =>
      createUpdateDraft(tx, {
        agentId: a.id,
        resolutions: [{ path: conflict?.path ?? "", choice: "theirs" }],
        ctx: h.ctx,
      }),
    );
    expect(version.bundle.definition.instructions).toBe("The template's new way.");
    expect(version.authorType).toBe("merge");
  });

  it("promotes a client's changes into a template draft without client-specific values", async () => {
    const base = makeBundle({ skillSettings: { threshold: 5 } });
    const { tpl, a, c1 } = await setup("promote", base);
    const recordId = uuidv7();
    const c2 = await h.ops(async (tx) => {
      const v = await createVersion(tx, {
        agentId: a.id,
        bundle: edit(c1.bundle, (b) => {
          const lookup = b.definition.skills.find((s) => s.skill === "test.lookup");
          if (!lookup) throw new Error("fixture");
          lookup.settings = { threshold: 7, vendor_list: "Acme, Bolt" };
          step(b, LOOKUP_STEP).name = "Look it up (better)";
          const update = step(b, UPDATE_STEP);
          if (update.kind !== "action") throw new Error("fixture");
          update.input = { id: recordId, amount: "2.00" };
        }),
      });
      return publish(tx, { agentId: a.id, versionId: v.id, ctx: h.ctx });
    });

    const preview = await h.ops((tx) => previewPromotion(tx, { agentId: a.id, ctx: h.ctx }));
    expect(preview.result.clean).toBe(true);
    const promoted = preview.result.bundle;
    const lookup = promoted.definition.skills.find((s) => s.skill === "test.lookup");
    // The generic setting is promoted; the client-specific one is not.
    expect(lookup?.settings).toEqual({ threshold: 7 });
    expect(step(promoted, LOOKUP_STEP).name).toBe("Look it up (better)");
    // The client's record id is replaced by the template's reference; other edits come along.
    const update = step(promoted, UPDATE_STEP);
    expect(update.kind === "action" && update.input).toEqual({
      id: "{{trigger.id}}",
      amount: "2.00",
    });
    expect(JSON.stringify(promoted)).not.toContain(recordId);
    expect(JSON.stringify(promoted)).not.toContain(h.A.connectionId);

    const { version } = await h.ops((tx) =>
      createPromotionDraft(tx, { agentId: a.id, actorId: h.operatorId, ctx: h.ctx }),
    );
    expect(version.agentId).toBe(tpl.id);
    expect(version.tenantId).toBeNull();
    expect(version.authorType).toBe("promote");
    expect(version.status).toBe("draft");
    expect(version.mergedFromVersionIds).toEqual([c2.id]);
    expect(version.bundle).toEqual(promoted);
  });

  it("promotes only the selected changes", async () => {
    const { tpl, a, c1 } = await setup("promote-some");
    await h.ops(async (tx) => {
      const v = await createVersion(tx, {
        agentId: a.id,
        bundle: edit(c1.bundle, (b) => {
          b.definition.instructions = "Client A's private way.";
          step(b, LOOKUP_STEP).name = "Look it up (better)";
        }),
      });
      await publish(tx, { agentId: a.id, versionId: v.id, ctx: h.ctx });
    });
    const all = await h.ops((tx) => previewPromotion(tx, { agentId: a.id, ctx: h.ctx }));
    const offered = selectableBetween(all.base.bundle, all.stripped).map((g) => g.id);
    expect(offered).toEqual(
      expect.arrayContaining(["bundle#/definition/instructions", `step:${LOOKUP_STEP}`]),
    );
    const { version } = await h.ops((tx) =>
      createPromotionDraft(tx, { agentId: a.id, changes: [`step:${LOOKUP_STEP}`], ctx: h.ctx }),
    );
    expect(version.agentId).toBe(tpl.id);
    expect(step(version.bundle, LOOKUP_STEP).name).toBe("Look it up (better)");
    expect(version.bundle.definition.instructions).toBe(c1.bundle.definition.instructions);
  });

  it("detaches and re-links a client agent with a new base", async () => {
    const { tpl, t1, a } = await setup("relink");
    const t2 = await h.ops(async (tx) => {
      const v = await createVersion(tx, {
        agentId: tpl.id,
        bundle: edit(t1.bundle, (b) => {
          b.definition.instructions = "Template v2.";
        }),
      });
      return publish(tx, { agentId: tpl.id, versionId: v.id, ctx: h.ctx });
    });
    expect((await h.ops((tx) => updateInfo(tx, { agentId: a.id }))).available).toBe(true);
    const detached = await h.ops((tx) => detach(tx, { agentId: a.id }));
    expect(detached.linked).toBe(false);
    const info = await h.ops((tx) => updateInfo(tx, { agentId: a.id }));
    expect(info.available).toBe(false);
    const err = await h
      .ops((tx) => previewUpdate(tx, { agentId: a.id }))
      .catch((e: AgentsError) => e);
    expect((err as AgentsError).code).toBe("not_linked");

    const v = await h.ops((tx) => relink(tx, { agentId: a.id, templateVersionId: t2.id }));
    expect(v.basedOnTemplateVersionId).toBe(t2.id);
    await h.ops((tx) => publish(tx, { agentId: a.id, versionId: v.id, ctx: h.ctx }));
    const relinked = await h.ops((tx) => updateInfo(tx, { agentId: a.id }));
    expect(relinked.linked).toBe(true);
    expect(relinked.base?.id).toBe(t2.id);
    expect(relinked.available).toBe(false);
  });

  it("copies a client agent into another client without the source client's values", async () => {
    const base = makeBundle({ skillSettings: { threshold: 5 } });
    const { a, c1 } = await setup("copy", base);
    const recordId = uuidv7();
    await h.ops(async (tx) => {
      const v = await createVersion(tx, {
        agentId: a.id,
        bundle: edit(c1.bundle, (b) => {
          const lookup = b.definition.skills.find((s) => s.skill === "test.lookup");
          if (!lookup) throw new Error("fixture");
          lookup.settings = { threshold: 7, vendor_list: "Acme, Bolt" };
          const update = step(b, UPDATE_STEP);
          if (update.kind !== "action") throw new Error("fixture");
          update.input = { id: recordId, amount: "2.00" };
        }),
      });
      await publish(tx, { agentId: a.id, versionId: v.id, ctx: h.ctx });
    });

    const { agent: copy, version } = await h.ops((tx) =>
      copyClientAgent(tx, {
        tenantId: h.B.tenantId,
        slug: "copy",
        sourceAgentId: a.id,
        ctx: h.ctx,
      }),
    );
    expect(copy.tenantId).toBe(h.B.tenantId);
    expect(copy.bindings).toEqual({});
    const lookup = version.bundle.definition.skills.find((s) => s.skill === "test.lookup");
    expect(lookup?.settings).toEqual({ threshold: 7 });
    const update = step(version.bundle, UPDATE_STEP);
    expect(update.kind === "action" && update.input).toEqual({
      id: "{{trigger.id}}",
      amount: "2.00",
    });
    expect(JSON.stringify(version.bundle)).not.toContain(recordId);
    expect(JSON.stringify(version.bundle)).not.toContain(h.A.connectionId);
  });

  it("treats uuids outside {{refs}} as record ids", () => {
    const id = uuidv7();
    expect(holdsRecordId(`{{steps.${id}.output.x}}`)).toBe(false);
    expect(holdsRecordId(id)).toBe(true);
    expect(holdsRecordId({ a: [1, `vendor ${id}`] })).toBe(true);
    expect(holdsRecordId("plain")).toBe(false);
  });
});
