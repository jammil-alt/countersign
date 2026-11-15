// §1.104: "Vendor contracts and invoice review", the Purchasing area's template, against the
// platform: its processes validate as a template (every skill and tool registered, every write to
// anyone outside behind approval, the contract read on the cheap model), the pack's install puts
// it in the back office, and the operator forks it into a client that has the pack, which gets
// its own agent (invariant 11: nothing of another client comes with it).

import { parseSkillRef, processes } from "@countersign/core";
import { agent, agentVersion } from "@countersign/db";
import { DEFAULT_MODELS, knownModelIds } from "@countersign/llm";
import { materialsManifest } from "@countersign/pack-materials";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";
import { createPlatform, deploymentConnectors } from "./platform";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
type J = any;

const platform = createPlatform({ connectors: deploymentConnectors({}, false) });
const ctx = {
  skills: Object.fromEntries(platform.catalog.list().map((s) => [s.id, s])),
  tools: platform.tools.specs(),
  events: platform.events.byType(),
  models: knownModelIds(),
};

const template = materialsManifest.templates.find((t) => t.slug === "vendor-contracts");
const latest = template?.versions?.at(-1);

describe("the vendor contracts template", () => {
  it("validates against the platform as a template", () => {
    if (!latest) throw new Error("no template");
    const r = processes.validateAnyBundle(latest, ctx);
    expect(r.errors).toEqual([]);
    expect(latest.workflows.map((w) => [w.slug, w.workflow.schemaVersion])).toEqual([
      ["contract-intake", 4],
      ["invoice-review", 4],
    ]);
  });

  it("lists every skill its steps use, reads the contract on the cheap model, and asks first", () => {
    if (!latest) throw new Error("no template");
    const listed = new Map(latest.definition.skills.map((s) => [parseSkillRef(s.skill).id, s]));
    expect(listed.get("materials.read-contract")?.model?.id).toBe(DEFAULT_MODELS.classification);
    for (const w of latest.workflows) {
      if (w.workflow.schemaVersion !== 4) continue;
      for (const { step } of processes.allSteps(w.workflow)) {
        if (step.kind === "skill")
          expect(listed.has(parseSkillRef(step.skill).id), step.id).toBe(true);
        if (step.kind === "write") {
          const external =
            step.action !== undefined || ctx.tools[step.tool ?? ""]?.sideEffect === "external";
          if (external) expect(step.checks?.approval?.required, step.id).toBe("required");
          expect(processes.approvalLoosenings(step.checks?.approval, "checks.approval")).toEqual(
            [],
          );
        }
      }
    }
    expect(latest.definition.permissions.mode).toBe("suggest_only");
  });
});

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("installing and forking it", () => {
  const H = h as ApiHarness;

  it("installs with the pack and forks into a client that has it", async () => {
    const on = await H.call(
      OPERATOR,
      "POST",
      `/api/ops/clients/${H.A.tenantId}/packs/materials/enable`,
    );
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(isNull(agent.tenantId), eq(agent.slug, "vendor-contracts")));
    expect(tpl?.kind).toBe("template");
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tpl?.id}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Vendor contracts",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const [v] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.id, (fork.json as J).version.id));
    expect(v?.tenantId).toBe(H.A.tenantId);
    const bundle = v?.bundle as J;
    expect(bundle.workflows.map((w: J) => w.slug)).toEqual(["contract-intake", "invoice-review"]);
  });
});
