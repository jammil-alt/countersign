// Lineage between templates and client agents through the API, against a real database as
// cs_worker (ARCHITECTURE §9.3, §14 "Lineage"; plan M6 "Done when"): template v2 merges into two
// client agents, one clean and one with a conflict resolved, keeping each client's customizations;
// one client's change is promoted into template v3 without its client-specific values; one client
// is rolled back; a client agent is detached and re-linked. Every route is operator-only (the
// contract test refuses client roles on all of them); an operator who doesn't serve the client
// sees nothing.

import { createSkill, publishSkill } from "@countersign/agents";
import { type AgentBundle, cloneJson, selectableBetween, uuidv7 } from "@countersign/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ApiHarness,
  admin,
  createApiHarness,
  OPERATOR,
  OTHER_OPERATOR,
  testBundle,
} from "./api.test-helper";

const h = await createApiHarness();
afterAll(() => h?.close());

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const SKILL = "custom:merge-watch";

function edit(bundle: AgentBundle, fn: (b: AgentBundle) => void): AgentBundle {
  const out = cloneJson(bundle);
  fn(out);
  return out;
}

function templateBundle(): AgentBundle {
  return edit(testBundle(), (b) => {
    b.definition.skills = [{ skill: SKILL, settings: { threshold_pct: 5 } }];
  });
}

function stepOf(bundle: AgentBundle, id: string) {
  for (const w of bundle.workflows) {
    const s = w.workflow.steps.find((x) => x.id === id);
    if (s) return s;
  }
  throw new Error(`no step ${id}`);
}

describe.skipIf(!h)("lineage API: updates, promotion, rollback, detach", () => {
  const H = h as ApiHarness;
  let templateId = "";
  let t1 = "";
  let t2 = "";
  const agents: Record<"A" | "B", { id: string; v: string[] }> = {
    A: { id: "", v: [] },
    B: { id: "", v: [] },
  };
  const NEW_STEP = uuidv7();
  const recordId = uuidv7();

  async function ok(method: string, path: string, body?: unknown) {
    const res = await H.call(OPERATOR, method, path, body);
    expect(res.status, `${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200);
    return j(res.json);
  }

  async function saveAndPublish(agentId: string, bundle: AgentBundle, changeNote: string) {
    const saved = await ok("POST", `/api/ops/agents/${agentId}/versions`, { bundle, changeNote });
    await ok("POST", `/api/ops/agents/${agentId}/versions/${saved.version.id}/publish`);
    return saved.version.id as string;
  }

  async function liveBundle(agentId: string): Promise<AgentBundle> {
    return (await ok("GET", `/api/ops/agents/${agentId}`)).live.bundle;
  }

  beforeAll(async () => {
    await H.t.db.transaction(async (tx) => {
      const s = await createSkill(tx, {
        tenantId: null,
        definition: {
          schemaVersion: 1,
          id: SKILL,
          name: "Merge watch",
          description: "Watches merges",
          category: "custom",
          mode: "agent",
          instructions: "Watch.",
          tools: [],
          input: { type: "object" },
          output: { type: "object" },
          settings: [
            { key: "threshold_pct", label: "Threshold %", type: "number", default: 5 },
            { key: "vendors", label: "Vendors", type: "string", default: "", clientSpecific: true },
          ],
        },
      });
      await publishSkill(tx, { skillId: s.skill.id, versionId: s.version.id });
    });

    const created = await ok("POST", "/api/ops/templates", {
      slug: "lineage-clerk",
      bundle: templateBundle(),
    });
    templateId = created.agent.id;
    t1 = created.version.id;
    await ok("POST", `/api/ops/agents/${templateId}/versions/${t1}/publish`);

    for (const [key, client] of [
      ["A", H.A],
      ["B", H.B],
    ] as const) {
      const forked = await ok("POST", `/api/ops/templates/${templateId}/fork`, {
        clientId: client.tenantId,
      });
      agents[key].id = forked.agent.id;
      agents[key].v.push(forked.version.id);
      await ok("PATCH", `/api/ops/agents/${forked.agent.id}/operation`, {
        bindings: { testkit: client.connectionId },
      });
      await ok("POST", `/api/ops/agents/${forked.agent.id}/versions/${forked.version.id}/publish`);
    }

    // Client A renames a step; client B rewrites the instructions, tunes the skill for itself
    // and points the action at one of its own records.
    agents.A.v.push(
      await saveAndPublish(
        agents.A.id,
        edit(templateBundle(), (b) => {
          stepOf(b, "confirm").name = "Confirm with A";
        }),
        "A's confirm step",
      ),
    );
    agents.B.v.push(
      await saveAndPublish(
        agents.B.id,
        edit(templateBundle(), (b) => {
          b.definition.instructions = "B's way.";
          b.definition.skills = [
            { skill: SKILL, settings: { threshold_pct: 7, vendors: "Acme, Bolt" } },
          ];
          const update = stepOf(b, "update");
          if (update.kind === "action") update.input = { id: recordId, amount: "12.00" };
        }),
        "B's way",
      ),
    );

    // Template v2: new instructions and a new last step.
    const v2 = await ok("POST", `/api/ops/agents/${templateId}/versions`, {
      bundle: edit(templateBundle(), (b) => {
        b.definition.instructions = "The template's v2 way.";
        b.workflows[0]?.workflow.steps.push({
          id: NEW_STEP,
          name: "Tell the team",
          kind: "notify",
          channel: "thread",
          message: "Done",
        });
      }),
      changeNote: "v2",
      releaseNote: "A closing note to the team",
    });
    t2 = v2.version.id;
    await ok("POST", `/api/ops/agents/${templateId}/versions/${t2}/publish`);
  });

  it("shows both clients behind, B with one conflict", async () => {
    const used = await ok("GET", `/api/ops/templates/${templateId}/used-by`);
    const by = (id: string) =>
      used.agents.find((a: { agent: { id: string } }) => a.agent.id === id);
    expect(by(agents.A.id)).toMatchObject({ behind: 1, conflicts: 0 });
    expect(by(agents.B.id)).toMatchObject({ behind: 1, conflicts: 1 });
  });

  it("merges template v2 into A cleanly, keeping A's customization", async () => {
    const preview = await ok("GET", `/api/ops/agents/${agents.A.id}/update-preview`);
    expect(preview.conflicts).toEqual([]);
    expect(preview.template.id).toBe(templateId);
    expect(preview.base.id).toBe(t1);
    expect(preview.theirs.id).toBe(t2);
    expect(preview.ours.id).toBe(agents.A.v[1]);
    expect(preview.labels[`step:${NEW_STEP}`]).toBe("Tell the team");

    const { version } = await ok("POST", `/api/ops/agents/${agents.A.id}/update`, {
      resolutions: [],
    });
    expect(version).toMatchObject({
      status: "draft",
      authorType: "merge",
      basedOnTemplateVersionId: t2,
      mergedFromVersionIds: [t2],
      parentVersionId: agents.A.v[1],
    });
    await ok("POST", `/api/ops/agents/${agents.A.id}/versions/${version.id}/publish`);
    agents.A.v.push(version.id);
    const live = await liveBundle(agents.A.id);
    expect(stepOf(live, "confirm").name).toBe("Confirm with A");
    expect(stepOf(live, NEW_STEP).name).toBe("Tell the team");
    expect(live.definition.instructions).toBe("The template's v2 way.");

    const detail = await ok("GET", `/api/ops/agents/${agents.A.id}`);
    expect(detail.update).toMatchObject({ available: false, behind: 0 });
  });

  it("refuses B's merge draft until its conflict is resolved, then keeps B's values", async () => {
    const preview = await ok("GET", `/api/ops/agents/${agents.B.id}/update-preview`);
    expect(preview.conflicts).toEqual([
      expect.objectContaining({
        path: "bundle#/definition/instructions",
        kind: "field",
        base: "Change records only when asked.",
        ours: "B's way.",
        theirs: "The template's v2 way.",
      }),
    ]);

    const refused = await H.call(OPERATOR, "POST", `/api/ops/agents/${agents.B.id}/update`, {
      resolutions: [],
    });
    expect(refused.status).toBe(409);
    expect(j(refused.json).error.code).toBe("merge_conflicts");

    const { version } = await ok("POST", `/api/ops/agents/${agents.B.id}/update`, {
      resolutions: [
        { path: "bundle#/definition/instructions", choice: "value", value: "B's way, in v2." },
      ],
      changeNote: "Template v2, B's instructions kept",
    });
    expect(version.changeNote).toBe("Template v2, B's instructions kept");
    await ok("POST", `/api/ops/agents/${agents.B.id}/versions/${version.id}/publish`);
    agents.B.v.push(version.id);
    const live = await liveBundle(agents.B.id);
    expect(live.definition.instructions).toBe("B's way, in v2.");
    expect(live.definition.skills).toEqual([
      { skill: SKILL, settings: { threshold_pct: 7, vendors: "Acme, Bolt" } },
    ]);
    expect(stepOf(live, NEW_STEP).name).toBe("Tell the team");
    // Client A's agent is untouched by B's merge.
    expect((await liveBundle(agents.A.id)).definition.instructions).toBe("The template's v2 way.");
  });

  it("promotes B's skill tuning into template v3 without B's values", async () => {
    const preview = await ok("GET", `/api/ops/agents/${agents.B.id}/promote-preview`);
    expect(preview.template.id).toBe(templateId);
    expect(preview.ours.id).toBe(t2);
    expect(preview.client.id).toBe(agents.B.v[2]);
    const theirs = preview.theirs.bundle as AgentBundle;
    expect(JSON.stringify(theirs)).not.toContain("Acme");
    expect(JSON.stringify(theirs)).not.toContain(recordId);
    // What stays with the client is listed.
    expect(preview.leftOut.map((c: { path: string }) => c.path)).toEqual(
      expect.arrayContaining([`skill:${SKILL}#/settings/vendors`, "step:update#/input/id"]),
    );
    const offered = selectableBetween(preview.base.bundle, theirs).map((g) => g.id);
    expect(offered).toEqual(
      expect.arrayContaining(["bundle#/definition/instructions", `skill:${SKILL}`]),
    );

    const { template, version } = await ok("POST", `/api/ops/agents/${agents.B.id}/promote`, {
      changes: [`skill:${SKILL}`],
      resolutions: [],
      releaseNote: "A higher threshold",
    });
    expect(template.id).toBe(templateId);
    expect(version).toMatchObject({
      agentId: templateId,
      status: "draft",
      authorType: "promote",
      parentVersionId: t2,
      mergedFromVersionIds: [agents.B.v[2]],
      releaseNote: "A higher threshold",
    });
    const v3 = await ok("GET", `/api/ops/agents/${templateId}/versions/${version.id}`);
    const bundle = v3.version.bundle as AgentBundle;
    expect(bundle.definition.skills).toEqual([{ skill: SKILL, settings: { threshold_pct: 7 } }]);
    expect(bundle.definition.instructions).toBe("The template's v2 way.");
    expect(JSON.stringify(bundle)).not.toContain(recordId);
    expect(JSON.stringify(bundle)).not.toContain(H.B.connectionId);
    await ok("POST", `/api/ops/agents/${templateId}/versions/${version.id}/publish`);
    // Publishing the template changes no client agent.
    expect((await liveBundle(agents.A.id)).definition.skills).toEqual([
      { skill: SKILL, settings: { threshold_pct: 5 } },
    ]);
  });

  it("rolls A back to before the update, which makes the update available again", async () => {
    const { version } = await ok("POST", `/api/ops/agents/${agents.A.id}/rollback`, {
      versionId: agents.A.v[1],
    });
    expect(version.basedOnTemplateVersionId).toBe(t1);
    const live = await liveBundle(agents.A.id);
    expect(live.workflows[0]?.workflow.steps.some((s) => s.id === NEW_STEP)).toBe(false);
    expect(stepOf(live, "confirm").name).toBe("Confirm with A");
    const detail = await ok("GET", `/api/ops/agents/${agents.A.id}`);
    expect(detail.update).toMatchObject({ available: true, behind: 2 });
  });

  it("detaches A, refuses its updates, and re-links it to template v3", async () => {
    const detached = await ok("POST", `/api/ops/agents/${agents.A.id}/detach`);
    expect(detached.agent.linked).toBe(false);
    const again = await H.call(OPERATOR, "POST", `/api/ops/agents/${agents.A.id}/detach`);
    expect(again.status).toBe(409);
    const preview = await H.call(OPERATOR, "GET", `/api/ops/agents/${agents.A.id}/update-preview`);
    expect(preview.status).toBe(409);
    expect(j(preview.json).error.code).toBe("not_linked");

    const tpl = await ok("GET", `/api/ops/agents/${templateId}`);
    const v3 = tpl.versions.find((v: { version: number }) => v.version === 3);
    const relinked = await ok("POST", `/api/ops/agents/${agents.A.id}/relink`, {
      templateVersionId: v3.id,
    });
    expect(relinked.agent.linked).toBe(true);
    expect(relinked.version).toMatchObject({ status: "live", basedOnTemplateVersionId: v3.id });
    const detail = await ok("GET", `/api/ops/agents/${agents.A.id}`);
    expect(detail.update).toMatchObject({ available: false, behind: 0 });
    // The bundle is A's as it was: re-linking moves only the base.
    expect(stepOf(await liveBundle(agents.A.id), "confirm").name).toBe("Confirm with A");

    const linkedAgain = await H.call(OPERATOR, "POST", `/api/ops/agents/${agents.A.id}/relink`, {
      templateVersionId: v3.id,
    });
    expect(linkedAgain.status).toBe(409);
  });

  it("refuses a template, a draft template version and a client the operator doesn't serve", async () => {
    const tplPreview = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/agents/${templateId}/update-preview`,
    );
    expect(tplPreview.status).toBe(422);
    const other = await H.call(
      OTHER_OPERATOR,
      "GET",
      `/api/ops/agents/${agents.B.id}/promote-preview`,
    );
    expect(other.status).toBe(404);
    const asClient = await H.call(
      admin("b"),
      "GET",
      `/api/ops/agents/${agents.B.id}/update-preview`,
    );
    expect(asClient.status).toBe(403);

    await ok("POST", `/api/ops/agents/${agents.B.id}/detach`);
    const draft = await ok("POST", `/api/ops/agents/${templateId}/versions`, {
      bundle: edit(templateBundle(), (b) => {
        b.definition.instructions = "Unpublished.";
      }),
    });
    const refused = await H.call(OPERATOR, "POST", `/api/ops/agents/${agents.B.id}/relink`, {
      templateVersionId: draft.version.id,
    });
    expect(refused.status).toBe(409);
  });
});
