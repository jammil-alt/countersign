// The manifest adds up the pack's areas (docs/marketing-plan.md §11): it is a valid PackManifest,
// every tool has its handler and is the pack's own read or record (never a write outside), every
// skill uses tools that exist, every template keeps approval on, and the areas' names never clash.
// Later milestones' tools, skills and templates are checked here as they arrive.

import {
  type AgentBundle,
  PackManifest,
  SkillDefinition,
  type Step,
  walkSteps,
} from "@countersign/core";
import { describe, expect, it } from "vitest";
import {
  MARKETING_ACTIONS,
  MARKETING_AREAS,
  MARKETING_HANDLERS,
  MARKETING_REPORTS,
  MARKETING_SKILLS,
  marketingManifest,
} from "./manifest";
import { SiteRangeQuery, siteRangeQuery } from "./pack";

/** Tools a marketing skill may use besides the pack's own: the platform's and connectors'. */
const OUTSIDE_TOOLS = new Set([
  "inbox.create",
  // M48: web research (platform), Hacker News (connector).
  "web.search",
  "web.fetch",
  "hackernews.search",
  "hackernews.thread",
  // M46, M49: the always-signed verbs (connectors).
  "website.publish",
  "website.meta",
  "linkedin.post",
]);

describe("the Marketing manifest", () => {
  it("parses, and names its events and tools after the pack", () => {
    expect(PackManifest.safeParse(marketingManifest).success).toBe(true);
    for (const e of marketingManifest.events) expect(e.type.startsWith("marketing.")).toBe(true);
    for (const t of marketingManifest.tools) expect(t.id.startsWith("marketing.")).toBe(true);
  });

  it("has a handler for every tool, and no tool that writes outside", () => {
    expect(Object.keys(MARKETING_HANDLERS).sort()).toEqual(
      marketingManifest.tools.map((t) => t.id).sort(),
    );
    for (const spec of marketingManifest.tools) {
      expect(MARKETING_HANDLERS[spec.id]?.spec).toEqual(spec);
      expect(spec.sideEffect).not.toBe("external");
      expect(spec.source).toBe("marketing");
    }
  });

  it("gives every skill tools that exist, and requires the pack", () => {
    const tools = new Set([...marketingManifest.tools.map((t) => t.id), ...OUTSIDE_TOOLS]);
    for (const skill of MARKETING_SKILLS) {
      expect(SkillDefinition.safeParse(skill).success, skill.id).toBe(true);
      expect(skill.id.startsWith("marketing."), skill.id).toBe(true);
      for (const t of [...(skill.handler ? [skill.handler] : []), ...skill.tools]) {
        expect(tools.has(t), `${skill.id} → ${t}`).toBe(true);
      }
      expect(skill.requiresPacks).toContain("marketing");
    }
  });

  it("ships templates with approval on in every step (invariant 8)", () => {
    for (const t of marketingManifest.templates) {
      const bundle: AgentBundle = t.bundle;
      for (const wf of bundle.workflows) {
        walkSteps(wf.workflow, ({ step }: { step: Step }) => {
          if (step.kind === "skill" || step.kind === "action") {
            expect(step.approval?.required ?? "required", `${t.slug} ${step.id}`).toBe("required");
          }
        });
      }
    }
  });

  it("adds up its areas, each name once", () => {
    expect(Object.keys(MARKETING_AREAS)).toEqual([
      "measure",
      "search",
      "content",
      "agents",
      "forum",
    ]);
    const reports = Object.values(MARKETING_AREAS).flatMap((a) => Object.keys(a.REPORTS));
    const actions = Object.values(MARKETING_AREAS).flatMap((a) => Object.keys(a.ACTIONS));
    expect(Object.keys(MARKETING_REPORTS).sort()).toEqual(reports.sort());
    expect(Object.keys(MARKETING_ACTIONS).sort()).toEqual(actions.sort());
    expect(MARKETING_REPORTS.overview?.title).toBe("Website");
    expect(Object.keys(MARKETING_ACTIONS)).toEqual(
      expect.arrayContaining(["add-site", "update-site"]),
    );
  });
});

describe("the reports' common query", () => {
  const SITE = "0195f3c0-0000-7000-8000-000000000001";

  it("takes a site and a range of days, in order", () => {
    expect(SiteRangeQuery.parse({ site: SITE, from: "2026-11-01", to: "2026-11-07" })).toEqual({
      site: SITE,
      from: "2026-11-01",
      to: "2026-11-07",
    });
    expect(SiteRangeQuery.parse({})).toEqual({});
    expect(SiteRangeQuery.safeParse({ from: "2026-11-08", to: "2026-11-01" }).success).toBe(false);
    expect(SiteRangeQuery.safeParse({ site: "mezonas.com" }).success).toBe(false);
    expect(SiteRangeQuery.safeParse({ other: "1" }).success).toBe(false);
  });

  it("is extended with a report's own parameters", async () => {
    const { z } = await import("zod");
    const q = siteRangeQuery({ path: z.string().startsWith("/").optional() });
    expect(q.parse({ path: "/pricing" })).toEqual({ path: "/pricing" });
    expect(q.safeParse({ path: "pricing" }).success).toBe(false);
  });
});
