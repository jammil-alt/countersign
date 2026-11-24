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
import { draftAgent } from "@countersign/agents";
import {
  isToolWrapper,
  newStepSkillReason,
  PLATFORM_EVENT_TYPES,
  processes,
  toolLookup,
} from "@countersign/core";
import { createLlmClient, FakeModel, type LlmRequest } from "@countersign/llm";
import { describe, expect, it } from "vitest";
import { createPlatform, deploymentConnectors } from "../platform";
import { platformBuilderContext } from "../routes/ops-builder";
import { ACCOUNT_TOOL_PREFIX, SPLIT_MODEL_TOOLS } from "../routes/ops-lineage";

const platform = createPlatform({ connectors: deploymentConnectors({} as never, false) });
const ctx = platformBuilderContext(platform).context;

/** The Builder's first request for a draft that must run (draft it now), caught before any model. */
async function firstRequest(): Promise<LlmRequest> {
  let seen: LlmRequest | undefined;
  const model = new FakeModel([
    (req: LlmRequest) => {
      seen = req;
      return { refusal: true };
    },
  ]);
  await draftAgent(
    { description: "When the UCC file arrives by email, read it.", worksFirst: true, ctx },
    { llm: createLlmClient({ transport: model }), validate: async () => [] },
  ).catch(() => null);
  if (!seen) throw new Error("the Builder asked nothing");
  return seen;
}

const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

describe("what the Builder knows", async () => {
  const req = await firstRequest();
  const system = text(req.system);
  const first = text(req.messages[0]?.content);
  const catalog = JSON.parse(
    first.slice(first.indexOf("<catalog>") + 9, first.indexOf("</catalog>")),
  ) as {
    skills: { id: string }[];
    tools: { id: string }[];
    connectors: { id: string }[];
    events: { type: string }[];
  };

  it("is told every step kind, way in and check the schema has", () => {
    for (const kind of processes.STEP_KINDS) expect(system, kind).toContain(`- ${kind}: `);
    for (const kind of Object.keys(processes.TRIGGER_GUIDE)) {
      expect(system, kind).toContain(`- ${kind}: `);
    }
    for (const kind of Object.keys(processes.CHECK_GUIDE)) {
      expect(system, kind).toContain(`- ${kind}: `);
    }
  });

  it("sees every connector and every platform event in its catalog", () => {
    const connectors = new Set(catalog.connectors.map((c) => c.id));
    for (const c of platform.connectors.list()) {
      expect(connectors.has(c.manifest.id), c.manifest.id).toBe(true);
    }
    const events = new Set(catalog.events.map((e) => e.type));
    for (const e of PLATFORM_EVENT_TYPES) expect(events.has(e), e).toBe(true);
  });

  it("holds back a skill or a tool only for a stated reason", () => {
    const offered = new Set(catalog.skills.map((s) => s.id));
    const lookup = toolLookup(platform.tools.specs());
    for (const def of platform.catalog.list()) {
      if (offered.has(def.id)) continue;
      const why = isToolWrapper(def)
        ? "wraps one tool"
        : newStepSkillReason(def, lookup, platform.superseded);
      expect(why, `${def.id} is held back with no reason`).toBeTruthy();
    }
    const stepOnlyTools = new Set(
      processes.STEP_ONLY_SKILLS.map((id) => platform.catalog.get(id)?.handler),
    );
    const tools = new Set(catalog.tools.map((t) => t.id));
    for (const t of platform.tools.list()) {
      if (tools.has(t.spec.id)) continue;
      expect(
        SPLIT_MODEL_TOOLS.has(t.spec.id) ||
          t.spec.id.startsWith(ACCOUNT_TOOL_PREFIX) ||
          stepOnlyTools.has(t.spec.id),
        `${t.spec.id} is held back with no reason`,
      ).toBe(true);
    }
  });

  // The skills that run only as a step of their own are skills to the Builder, never tools: it
  // was shown forms.request's tool and couldn't send a form and wait for it (2026-11-24).
  it("is offered Request info, Reach out and Converse as skill steps, not their tools", () => {
    const skills = new Set(catalog.skills.map((s) => s.id));
    const tools = new Set(catalog.tools.map((t) => t.id));
    for (const id of processes.STEP_ONLY_SKILLS) {
      expect(skills.has(id), id).toBe(true);
      const handler = platform.catalog.get(id)?.handler;
      if (handler) expect(tools.has(handler), handler).toBe(false);
    }
    expect(system).toContain("forms.request");
  });

  it("can name every skill and tool the guide's examples use", () => {
    const skills = new Set(catalog.skills.map((s) => s.id));
    const tools = new Set(catalog.tools.map((t) => t.id));
    for (const [kind, entry] of Object.entries(processes.STEP_GUIDE)) {
      const ex = entry.example as { skill?: string; tool?: string };
      if (ex.skill) expect(skills.has(ex.skill), `${kind}: skill ${ex.skill}`).toBe(true);
      if (ex.tool) expect(tools.has(ex.tool), `${kind}: tool ${ex.tool}`).toBe(true);
    }
  });

  it("writes what it is given, for a person to read, when asked", () => {
    const out = process.env.BUILDER_KNOWLEDGE_REPORT;
    if (!out) return;
    const offered = new Set(catalog.skills.map((s) => s.id));
    const lookup = toolLookup(platform.tools.specs());
    const held = platform.catalog
      .list()
      .filter((d) => !offered.has(d.id))
      .map(
        (d) =>
          `- ${d.id}: ${isToolWrapper(d) ? "wraps one tool (a read or write step uses the tool)" : newStepSkillReason(d, lookup, platform.superseded)}`,
      );
    const heldTools = platform.tools
      .list()
      .map((t) => t.spec.id)
      .filter((id) => !catalog.tools.some((t) => t.id === id));
    const lines = [
      "# What the Builder is given",
      "",
      `System prompt: ${system.length.toLocaleString("en-US")} characters. First message: ${first.length.toLocaleString("en-US")} characters, of which the catalog is most.`,
      "",
      `Catalog: ${catalog.skills.length} skills, ${catalog.tools.length} tools, ${catalog.connectors.length} connectors, ${catalog.events.length} event types.`,
      "",
      "## Skills held back",
      ...held,
      "",
      "## Tools held back",
      ...heldTools.map((id) => `- ${id}`),
      "",
      "## Skills offered",
      ...catalog.skills.map((s) => `- ${s.id}`),
      "",
      "## The system prompt",
      "",
      system,
    ];
    writeFileSync(out, lines.join("\n"));
  });
});
