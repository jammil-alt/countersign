// §1.77: the agent platform's pieces as the Worker wires them: web research is off unless
// MARKETING_RESEARCH=on; a client in HIPAA mode is refused `web.*` and `hackernews.*` even with the
// model vendor covered; Hacker News and LinkedIn are offered everywhere, LinkedIn "not available
// yet" until our app's keys are set; and `linkedin.post` is always signed.

import {
  HACKERNEWS_CONNECTOR_ID,
  LINKEDIN_CONNECTOR_ID,
  LINKEDIN_POST_TOOL,
} from "@countersign/connectors";
import { parseCoveredProcessors } from "@countersign/core";
import { describe, expect, it } from "vitest";
import { hipaaToolPolicy } from "./compliance/policy";
import { deploymentConnectors } from "./platform";
import { researchOn } from "./runs/execute";

describe("web research and the forum connectors", () => {
  it("keeps research off unless the owner turns it on", () => {
    expect(researchOn({})).toBe(false);
    expect(researchOn({ MARKETING_RESEARCH: "off" })).toBe(false);
    expect(researchOn({ MARKETING_RESEARCH: "yes" })).toBe(false);
    expect(researchOn({ MARKETING_RESEARCH: " ON " })).toBe(true);
  });

  it("refuses web research and Hacker News to a client in HIPAA mode", async () => {
    const covered = parseCoveredProcessors("cloudflare neon workos anthropic");
    const hipaa = hipaaToolPolicy(async () => ({ hipaa: true }), covered);
    const plain = hipaaToolPolicy(async () => ({ hipaa: false }), covered);
    for (const [toolId, connectorId] of [
      ["web.search", null],
      ["web.fetch", null],
      ["hackernews.search", HACKERNEWS_CONNECTOR_ID],
    ] as const) {
      expect(await hipaa.refuseTool({ tenantId: "t", toolId, connectorId })).toMatch(
        /no signed BAA; this client is in HIPAA mode/,
      );
      expect(await plain.refuseTool({ tenantId: "t", toolId, connectorId })).toBeNull();
    }
    // LinkedIn is the client's own page: not a processor of ours.
    expect(
      await hipaa.refuseTool({
        tenantId: "t",
        toolId: LINKEDIN_POST_TOOL,
        connectorId: LINKEDIN_CONNECTOR_ID,
      }),
    ).toBeNull();
  });

  it("offers Hacker News and LinkedIn, LinkedIn signing in only with our app's keys", () => {
    const off = deploymentConnectors({}, false);
    const hn = off.find((c) => c.manifest.id === HACKERNEWS_CONNECTOR_ID);
    const li = off.find((c) => c.manifest.id === LINKEDIN_CONNECTOR_ID);
    expect(hn?.manifest.auth).toBe("none");
    expect(li?.isConfigured?.()).toBe(false);
    const on = deploymentConnectors(
      { LINKEDIN_CLIENT_ID: "id", LINKEDIN_CLIENT_SECRET: "secret", OAUTH_STATE_SECRET: "s" },
      true,
    );
    const live = on.find((c) => c.manifest.id === LINKEDIN_CONNECTOR_ID);
    expect(live?.isConfigured?.()).toBe(true);
    expect(live?.manifest.tools.find((t) => t.id === LINKEDIN_POST_TOOL)?.approval).toBe("always");
  });
});
