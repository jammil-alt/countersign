// The builder's palette of tools (`stepTools`, docs/plan.md §1.86 "Skill model"): a conversation's
// and a reach-out's handlers stay steps of their own, and the hidden AI the splits replaced and the
// account agent's handlers are offered only where the agent's version already calls them.

import { describe, expect, it } from "vitest";
import { createPlatform, deploymentConnectors } from "./platform";
import { stepTools } from "./routes/ops-lineage";

const platform = createPlatform({ connectors: deploymentConnectors({}, false) });

describe("the builder's palette of tools", () => {
  it("leaves out an engine's handler and the hidden AI, and offers it where already used", () => {
    const fresh = new Set(stepTools(platform));
    expect(fresh.has("comms.converse")).toBe(false);
    expect(fresh.has("docs.extract")).toBe(false);
    expect(fresh.has("account.pause_agent")).toBe(false);
    expect(stepTools(platform, new Set(["docs.extract"]))).toContain("docs.extract");
  });
});
