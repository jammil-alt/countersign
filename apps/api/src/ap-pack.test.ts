// Plan entry §1.233: the AP pack against the platform. Its template validates as a template (every
// skill and tool registered, nothing written outside without approval), the generic install route
// switches the pack on with its configuration alone and installs "Bills to pay" in the back
// office, and the operator forks it into the client, which gets its own agent.

import { parseSkillRef, processes } from "@countersign/core";
import { agent, agentVersion, tenant } from "@countersign/db";
import { knownModelIds } from "@countersign/llm";
import { apManifest } from "@countersign/pack-materials";
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
const latest = apManifest.templates[0]?.versions?.at(-1);

describe("the Bills to pay template", () => {
  it("validates against the platform as a template", () => {
    if (!latest) throw new Error("no template");
    expect(processes.validateBundle(latest, ctx).errors).toEqual([]);
    expect(latest.workflows.map((w) => [w.slug, w.workflow.schemaVersion])).toEqual([
      ["bill-in", 4],
      ["pay-list", 4],
    ]);
  });

  it("lists every skill its steps use and writes nothing outside", () => {
    if (!latest) throw new Error("no template");
    const listed = new Set(latest.definition.skills.map((s) => parseSkillRef(s.skill).id));
    for (const w of latest.workflows) {
      if (w.workflow.schemaVersion !== 4) continue;
      for (const { step } of processes.allSteps(w.workflow)) {
        if (step.kind === "skill")
          expect(listed.has(parseSkillRef(step.skill).id), step.id).toBe(true);
        if (step.kind === "write") {
          expect(step.action, step.id).toBeUndefined();
          expect(ctx.tools[step.tool ?? ""]?.sideEffect, step.id).not.toBe("external");
        }
      }
    }
  });
});

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("installing and forking it", () => {
  const H = h as ApiHarness;

  it("installs with its configuration alone and forks into the client", async () => {
    const on = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/packs/ap/install`, {
      config: { pay_day: "thursday", require_po: true },
    });
    expect(on.status, JSON.stringify(on.json)).toBe(200);
    const [t] = await H.t.db.select().from(tenant).where(eq(tenant.id, H.A.tenantId));
    expect((t?.settings as J)?.packs?.ap).toMatchObject({ pay_day: "thursday", require_po: true });
    const [tpl] = await H.t.db
      .select()
      .from(agent)
      .where(and(isNull(agent.tenantId), eq(agent.slug, "bills-to-pay")));
    expect(tpl?.kind).toBe("template");
    const fork = await H.call(OPERATOR, "POST", `/api/ops/templates/${tpl?.id}/fork`, {
      clientId: H.A.tenantId,
      serviceName: "Bills to pay",
    });
    expect(fork.status, JSON.stringify(fork.json)).toBe(200);
    const [v] = await H.t.db
      .select()
      .from(agentVersion)
      .where(eq(agentVersion.id, (fork.json as J).version.id));
    expect(v?.tenantId).toBe(H.A.tenantId);
    expect((v?.bundle as J)?.workflows?.map((w: J) => w.slug)).toEqual(["bill-in", "pay-list"]);
  });
});
