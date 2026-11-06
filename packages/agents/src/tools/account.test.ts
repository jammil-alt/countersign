// Sloan's account tools (docs/plan.md §1.47): every result's schema passes the portal's
// forbidden-field walk, the tools write only internal records, the chat skill offers only
// platform tools, and a leaky view is cut to the portal's shape before the model sees it.

import { forbiddenPortalFields } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { ACCOUNT_SKILLS, ACCOUNT_TOOLS, type AccountPort } from "./account";
import { PLATFORM_TOOLS } from "./platform";
import type { PlatformStore, ToolInvocation } from "./types";

describe("the account tools", () => {
  it("return nothing a portal response may not carry", () => {
    for (const t of ACCOUNT_TOOLS) {
      expect(forbiddenPortalFields(t.output), t.spec.id).toEqual([]);
    }
  });

  it("are the platform's own and never write to a client's tool", () => {
    for (const t of ACCOUNT_TOOLS) {
      expect(t.spec.source).toBe("platform");
      expect(["none", "internal"]).toContain(t.spec.sideEffect);
      expect(PLATFORM_TOOLS).toContain(t);
    }
  });

  it("give the chat skill only registered platform tools", () => {
    const ids = new Set(PLATFORM_TOOLS.map((t) => t.spec.id));
    for (const s of ACCOUNT_SKILLS) {
      for (const id of s.tools) expect(ids.has(id), id).toBe(true);
      // TODO(W2-E): account.pass_to_agent, once message triggers exist.
      expect(s.tools).not.toContain("account.pass_to_agent");
    }
  });

  it("cut a view to the portal's shape before the model reads it", async () => {
    const leaky = {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Pia",
      status: "active",
      stage: "live",
      pause: null,
      accountAgent: false,
      description: null,
      current: null,
      bundle: { instructions: "secret" },
      costUsd: "1.20",
    };
    const port = { services: async () => [leaky] } as unknown as AccountPort;
    const tool = ACCOUNT_TOOLS.find((t) => t.spec.id === "account.services");
    if (!tool) throw new Error("no account.services");
    const ctx: ToolInvocation = {
      tenantId: "t",
      agentId: "a",
      agentVersionId: "v",
      runId: "r",
      stepRunId: "s",
      stepId: "answer",
      mode: "live",
      platform: {} as PlatformStore,
      account: port,
    };
    const out = tool.output.parse(await tool.run({}, ctx)) as { services: object[] };
    expect(out.services[0]).not.toHaveProperty("bundle");
    expect(out.services[0]).not.toHaveProperty("costUsd");
    await expect(tool.run({}, { ...ctx, account: undefined })).rejects.toThrow(/not available/);
  });
});
