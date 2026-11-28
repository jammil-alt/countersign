// The supervisor (Sloan, docs/plan.md §1.28) through the back office: it is added to a client from
// the back office once (its template installed, forked and published), only an operator who serves
// the client can add it, and onboarding turns it on.

import { afterAll, describe, expect, it } from "vitest";
import { type ApiHarness, admin, createApiHarness, OPERATOR } from "./api.test-helper";

// biome-ignore lint/suspicious/noExplicitAny: response bodies are read loosely in tests.
const j = (v: unknown) => v as any;

const h = await createApiHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("the supervisor", () => {
  const H = h as ApiHarness;

  it("is added to a client from the back office once, forked and published", async () => {
    const res = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {});
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(j(res.json)).toMatchObject({ created: true, supervisor: { slug: "supervisor" } });
    const supervisorId = j(res.json).supervisor.id;
    expect(j(res.json).supervisor.liveVersionId).toBeTruthy();
    const again = await H.call(OPERATOR, "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {});
    expect(j(again.json)).toMatchObject({ created: false, supervisor: { id: supervisorId } });
    // Clients can't add one, and an operator only to the clients they serve (others don't exist
    // for them).
    expect(
      (await H.call(admin("a"), "POST", `/api/ops/clients/${H.A.tenantId}/supervisor`, {})).status,
    ).toBe(403);
    expect(
      (await H.call(OPERATOR, "POST", `/api/ops/clients/${H.C.tenantId}/supervisor`, {})).status,
    ).toBe(404);
  });

  it('onboarding turns it on: a new client starts with Sloan on (§1.47 "On by default")', async () => {
    const res = await H.call(OPERATOR, "POST", "/api/ops/clients", {
      name: "Onboarded with a supervisor",
      supervisor: true,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const health = await H.call(
      OPERATOR,
      "GET",
      `/api/ops/clients/${j(res.json).client.id}/health`,
    );
    expect(j(health.json).supervisor).toMatchObject({ slug: "supervisor", runStatus: "active" });
  });
});
