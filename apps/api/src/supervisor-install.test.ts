// Where the seed never runs (production), the supervisor template isn't there until someone installs
// it. Adding the supervisor, from the new-client form or a client's Health page, installs the
// seeded template's newest version first instead of failing with `no_template` (2026-11-10).

import { SUPERVISOR_SLUG } from "@countersign/core";
import { agent } from "@countersign/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { latestSeededVersion } from "./account/templates";
import { type ApiHarness, createApiHarness, OPERATOR } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("adding the supervisor without its template", () => {
  const H = h as ApiHarness;

  const templates = () =>
    H.t.db
      .select()
      .from(agent)
      .where(and(isNull(agent.tenantId), eq(agent.slug, SUPERVISOR_SLUG)));

  it("installs the template, then forks it into the new client", async () => {
    expect(await templates()).toEqual([]);
    const res = await H.call(OPERATOR, "POST", "/api/ops/clients", {
      name: "First production client",
      supervisor: true,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const health = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${j(res.json).client.id}/health`,
    );
    // Sloan on by default (docs/plan.md §1.47): installed, forked and turned on.
    expect(j(health.json).supervisor).toMatchObject({ slug: "supervisor", runStatus: "active" });

    const [template] = await templates();
    expect(template?.kind).toBe("template");
    expect(template?.liveVersionId).toBeTruthy();
    const latest = latestSeededVersion(SUPERVISOR_SLUG);
    expect(latest).toBeGreaterThanOrEqual(1);
  });

  it("installs it once: the next client forks the same template", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(await templates()).toHaveLength(1);
  });
});
