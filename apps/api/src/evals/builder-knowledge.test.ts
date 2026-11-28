// What the Builder knows (owner, 2026-11-24: "there were multiple steps that it was not aware
// of... lets make sure we understand exactly what its knowledge base is and what we do to keep
// that current"). This builds the Builder's real first draft request, on this deployment's
// catalog, with no model, and checks it against the platform:
// - every step kind, way in and check the schema has is explained in its rules (core's guide);
// - every connector, event type and automation-free built-in it may use is in its catalog;
// - what the catalog holds back (skills that only wrap a tool, retired or replaced ones, account
//   and split-model tools) is held back for a stated reason, never by accident.
// With BUILDER_KNOWLEDGE_REPORT=<file> it writes what the Builder is given, section by section,
// so a person can read it: `pnpm --filter @countersign/api exec vitest run src/evals/builder-knowledge`.

import { writeFileSync } from "node:fs";
import {
  catalogBriefForPrompt,
  catalogForPrompt,
  draftStepAgent,
  narrowContext,
  STEP_ONLY_SKILLS,
  shortlistCatalogBlock,
} from "@countersign/agents";
import {
  isToolWrapper,
  newStepSkillReason,
  PLATFORM_EVENT_TYPES,
  processes,
  steps,
  toolLookup,
} from "@countersign/core";
import { createLlmClient, FakeModel, type LlmRequest } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { createPlatform, deploymentConnectors } from "../platform";
import { platformBuilderContext } from "../routes/ops-builder";

const platform = createPlatform({ connectors: deploymentConnectors({} as never, false) });
const ctx = platformBuilderContext(platform).context;

const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

// What the Builder is told and offered: every
// kind of step, way in and check in its rules; every connector and event; the Uses picker's
// actions, the areas' match profiles and the built-in Loops in its catalog.
async function firstStepRequest(): Promise<LlmRequest> {
  let seen: LlmRequest | undefined;
  const model = new FakeModel([
    (req: LlmRequest) => {
      seen = req;
      return { refusal: true };
    },
  ]);
  await draftStepAgent(
    { description: "When the UCC file arrives by email, read it.", worksFirst: true, ctx },
    { llm: createLlmClient({ transport: model }), validate: async () => [] },
  ).catch(() => null);
  if (!seen) throw new Error("the Builder asked nothing");
  return seen;
}

describe("what the Builder knows", async () => {
  const req = await firstStepRequest();
  const system = text(req.system);
  const first = text(req.messages[0]?.content);
  const catalog = JSON.parse(
    first.slice(first.indexOf("<catalog>") + 9, first.indexOf("</catalog>")),
  ) as {
    actions: { actions: { id: string; kind: string }[] }[];
    matchProfiles: { id: string }[];
    skills: { id: string }[];
    loops: { id: string }[];
    connectors: { id: string }[];
    events: { type: string }[];
  };

  it("is told every kind of step, way in and check", () => {
    for (const kind of steps.STEP_KINDS) expect(system, kind).toContain(`- ${kind}:`);
    for (const kind of Object.keys(processes.TRIGGER_GUIDE)) {
      expect(system, kind).toContain(`- ${kind}: `);
    }
    for (const kind of Object.keys(processes.CHECK_GUIDE)) {
      expect(system, kind).toContain(`- ${kind}: `);
    }
  });

  it("sees every connector, every platform event, the areas' profiles and the built-in Loops", () => {
    const connectors = new Set(catalog.connectors.map((c) => c.id));
    for (const c of platform.connectors.list()) {
      expect(connectors.has(c.manifest.id), c.manifest.id).toBe(true);
    }
    const events = new Set(catalog.events.map((e) => e.type));
    for (const e of PLATFORM_EVENT_TYPES) expect(events.has(e), e).toBe(true);
    const profiles = new Set(catalog.matchProfiles.map((p) => p.id));
    for (const p of platform.packs.flatMap((x) => x.manifest.matchProfiles)) {
      expect(profiles.has(p.id), p.id).toBe(true);
    }
    const loops = new Set(catalog.loops.map((l) => l.id));
    for (const def of platform.catalog.list().filter((d) => d.loop !== undefined)) {
      expect(loops.has(def.id), def.id).toBe(true);
    }
  });

  it("is offered the Uses picker's actions, merged ones included, never an engine's", () => {
    const actions = new Set(catalog.actions.flatMap((g) => g.actions.map((a) => a.id)));
    expect(actions.has("accounting.bill.create")).toBe(true);
    for (const id of ["forms.request", "comms.reach_out", "comms.converse"]) {
      expect(actions.has(id), id).toBe(false);
    }
    // Request info, Reach out and Converse are a person's or a contact's Do, not skills to pick.
    const skills = new Set(catalog.skills.map((s) => s.id));
    for (const id of STEP_ONLY_SKILLS) expect(skills.has(id), id).toBe(false);
  });

  it("holds back a skill only for a stated reason", () => {
    const offered = new Set([
      ...catalog.skills.map((s) => s.id),
      ...catalog.loops.map((l) => l.id),
    ]);
    const lookup = toolLookup(platform.tools.specs());
    for (const def of platform.catalog.list()) {
      if (offered.has(def.id)) continue;
      const why = isToolWrapper(def)
        ? "wraps one tool"
        : newStepSkillReason(def, lookup, platform.superseded);
      expect(why, `${def.id} is held back with no reason`).toBeTruthy();
    }
  });

  // Two rounds (owner, 2026-11-24): the shortlist reads the catalog in short; the draft sees a
  // UCC agent's shortlist in full and the rest by id.
  const whole = JSON.stringify(catalogForPrompt(ctx)).length;
  const brief = JSON.stringify(catalogBriefForPrompt(ctx)).length;
  const ucc = narrowContext(ctx, {
    skills: ["data.read-table", "forms.request"],
    tools: [
      "zoho_crm.record.search",
      "zoho_crm.record.get",
      "zoho_crm.record.update",
      "sales.match_records",
      "data.table.write",
      "data.list.group",
    ],
    automations: [],
    events: ["document.received", "inbound.message"],
  });
  const shortlisted = shortlistCatalogBlock(catalogForPrompt(ucc.ctx), ucc.more).length;

  it("reads a fraction of the catalog in two rounds", () => {
    expect(brief).toBeLessThan(whole / 3);
    expect(shortlisted).toBeLessThan(whole / 4);
  });

  it("writes what it is given, for a person to read, when asked", () => {
    const out = process.env.BUILDER_KNOWLEDGE_REPORT;
    if (!out) return;
    const offered = new Set(catalog.skills.map((s) => s.id));
    const lines = [
      "# What the Builder is given",
      "",
      `System prompt: ${system.length.toLocaleString("en-US")} characters. First message: ${first.length.toLocaleString("en-US")} characters, of which the catalog is most.`,
      "",
      `Catalog: ${catalog.skills.length} skills, ${catalog.actions.flatMap((g) => g.actions).length} actions, ${catalog.connectors.length} connectors, ${catalog.events.length} event types.`,
      "",
      `In one round the draft reads the whole catalog: ${whole.toLocaleString("en-US")} characters. In two rounds the shortlist reads it in short (${brief.toLocaleString("en-US")}), and the draft reads its shortlist in full with the rest by id (a UCC agent's: ${shortlisted.toLocaleString("en-US")}).`,
      "",
      "## Skills offered",
      ...[...offered].map((id) => `- ${id}`),
      "",
      "## The system prompt",
      "",
      system,
    ];
    writeFileSync(out, lines.join("\n"));
  });
});
