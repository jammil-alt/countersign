// B3 (docs/builder-plan.md §8, tier 3): `manual.read` gives an agent another agent's manual for
// the same client, by name, slug or id, as the client-safe view made by code: never its
// instructions, never what it learned, and never an agent of another client (invariant 1).

import { AgentManual } from "@countersign/core";
import { agent, agentVersion, memoryNote } from "@countersign/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ManualReadResult, manualRead } from "../tools/manual";
import type { ToolInvocation } from "../tools/types";
import { type Client, createHarness, type Harness, makeBundle } from "./harness.test-helper";
import { dbManualsPort } from "./manuals-port";
import { dbPlatformStore } from "./platform-store";

const h = await createHarness();
afterAll(() => h?.close());

describe.skipIf(!h)("manual.read", () => {
  const H = h as Harness;
  const ids: Record<string, { agentId: string; versionId: string }> = {};

  async function seed(c: Client, slug: string, name: string, what: string) {
    const bundle = makeBundle({ instructions: `SECRET for ${slug}` });
    bundle.definition.manual = AgentManual.parse({
      whatItDoes: what,
      decisions: [{ id: "d1", what: `${name} keeps freight out`, kind: "assumption" }],
    });
    const [a] = await H.t.db
      .insert(agent)
      .values({ tenantId: c.tenantId, kind: "client", slug, name })
      .returning();
    const [v] = await H.t.db
      .insert(agentVersion)
      .values({
        tenantId: c.tenantId,
        agentId: a?.id as string,
        version: 1,
        bundle,
        bundleHash: `h-${slug}-${c.tenantId}`,
        status: "live",
        authorType: "operator",
      })
      .returning();
    await H.t.db
      .update(agent)
      .set({ liveVersionId: v?.id as string })
      .where(eq(agent.id, a?.id as string));
    await H.t.db
      .insert(memoryNote)
      .values({ tenantId: c.tenantId, agentId: a?.id as string, note: `${slug} learned this` });
    return { agentId: a?.id as string, versionId: v?.id as string };
  }

  beforeAll(async () => {
    ids.intake = await seed(H.A, "invoice-intake", "Invoice intake", "Reads invoices for A.");
    ids.review = await seed(H.A, "ap-review", "AP review", "Reviews bills.");
    ids.other = await seed(H.B, "b-intake", "B intake", "Reads invoices for B.");
  });

  const invoke = (c: Client, agentId: string): ToolInvocation => ({
    tenantId: c.tenantId,
    agentId,
    agentVersionId: "v",
    runId: "0192f7a0-0000-7000-8000-00000000d001",
    stepRunId: "0192f7a0-0000-7000-8000-00000000d002",
    stepId: "s",
    mode: "live",
    platform: dbPlatformStore(H.db),
    manuals: dbManualsPort(H.db),
  });

  it("reads another agent's manual of the same client, by name, slug or id", async () => {
    const ctx = invoke(H.A, ids.review?.agentId as string);
    for (const name of [
      "Invoice intake",
      "invoice intake",
      "invoice-intake",
      ids.intake?.agentId,
    ]) {
      const out = await manualRead.run({ agent: name as string }, ctx);
      expect(out, String(name)).toMatchObject({
        found: true,
        sources: [ids.intake?.versionId],
        manual: { whatItDoes: "Reads invoices for A.", written: true },
      });
    }
    const out = (await manualRead.run({ agent: "invoice-intake" }, ctx)) as ManualReadResult;
    const text = JSON.stringify(out);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("learned this");
    expect(out.manual?.decisions.map((d) => d.what)).toEqual(["Invoice intake keeps freight out"]);
    expect(manualRead.output.safeParse(out).success).toBe(true);
  });

  it("never finds another client's agent", async () => {
    const ctx = invoke(H.A, ids.review?.agentId as string);
    for (const name of ["B intake", "b-intake", ids.other?.agentId]) {
      expect(await manualRead.run({ agent: name as string }, ctx)).toEqual({
        agent: name,
        found: false,
        manual: null,
        sources: [],
      });
    }
    // And B finds its own.
    const fromB = (await manualRead.run(
      { agent: "b-intake" },
      invoke(H.B, ids.other?.agentId as string),
    )) as ManualReadResult;
    expect(fromB.manual?.whatItDoes).toBe("Reads invoices for B.");
  });

  it("is a read the tool registry knows, with no side effect", () => {
    expect(manualRead.spec.sideEffect).toBe("none");
    expect(H.tools.get("manual.read")).toBeTruthy();
  });
});
