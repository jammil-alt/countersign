// v0.18 (owner, 2026-11-15; docs/plan.md §1.103): what each step reads and saves. A step's tools
// say it (`ToolSpec.sideEffect`, `entity` and `area`, ARCHITECTURE §12.0): a read or a write step
// by its own tool, a write action by the tools it can resolve to, and a skill step by its skill's
// tools, rolled up. What a step needs of the client follows: the connectors of its tools and its
// skill's `requiresConnectors`, the packs of its tools and its skill's `requiresPacks`. Pure: the
// builder words it (and warns when the client lacks something); nothing here is a gate.

import { skillTools } from "../schemas/skill";
import { SHARED_AREA, type ToolSpec } from "../schemas/tool";
import { lookupSkill, type TypingContext } from "../template/typer";
import { ACTION_SPECS } from "./actions";
import type { Process, Step } from "./schema";
import { walkSteps } from "./walk";

/** Reads (no side effect), saves (our records, `internal`) or changes (a client's tool). */
export type DataVerb = "reads" | "saves" | "changes";

/** One thing a step does with data, from one tool. */
export interface DataTouch {
  verb: DataVerb;
  tool: string;
  /** The record type, when the tool names one (`vendor`, `bill`). */
  entity?: string | undefined;
  /** A platform or pack tool's area (`purchasing`, `shared`). */
  area?: string | undefined;
  /** The connector of a client tool the step reads from or changes. */
  connector?: string | undefined;
  /** The pack a pack tool belongs to (its `source`). */
  pack?: string | undefined;
}

/** What a step does with data, and what it needs of the client to do it. */
export interface StepDataUse {
  /**
   * False for steps that keep no data of their own: a person, a conversation, a notice, logic, a
   * hand-off, an automation (its own steps say) and a missing step.
   */
  applies: boolean;
  touches: DataTouch[];
  /** Connectors the step needs connected: its tools' and its skill's (`requiresConnectors`). */
  connectors: string[];
  /** Packs the step needs on: its tools' and its skill's (`requiresPacks`). */
  packs: string[];
  /** The skill's or tool's id when the context doesn't know it: its data is unknown. */
  unknown?: string | undefined;
}

export interface DataUseContext extends TypingContext {
  /** The connectors there are, by id: a tool whose `source` is one reads from that tool. */
  connectors?: ReadonlySet<string> | undefined;
}

const NONE: StepDataUse = { applies: false, touches: [], connectors: [], packs: [] };

/** Where one tool's data lives and what it does with it. */
export function toolDataTouch(
  tool: ToolSpec,
  ctx: Pick<DataUseContext, "connectors"> = {},
): DataTouch {
  const connector =
    tool.connector ?? (ctx.connectors?.has(tool.source) === true ? tool.source : undefined);
  // DECISION (v0.18): a tool from neither the platform nor a connector is its pack's (`source` is
  // the pack id); the pack is what the client must have on.
  const pack = connector === undefined && tool.source !== "platform" ? tool.source : undefined;
  const verb: DataVerb =
    tool.sideEffect === "external" ? "changes" : tool.sideEffect === "internal" ? "saves" : "reads";
  return {
    verb,
    tool: tool.id,
    ...(tool.entity ? { entity: tool.entity } : {}),
    ...(tool.area ? { area: tool.area } : {}),
    ...(connector ? { connector } : {}),
    ...(pack ? { pack } : {}),
  };
}

function fromTools(ids: readonly string[], ctx: DataUseContext): StepDataUse {
  const touches: DataTouch[] = [];
  const connectors = new Set<string>();
  const packs = new Set<string>();
  for (const id of ids) {
    const tool = ctx.tools?.[id];
    if (!tool) continue;
    const t = toolDataTouch(tool, ctx);
    touches.push(t);
    if (t.connector) connectors.add(t.connector);
    if (t.pack) packs.add(t.pack);
  }
  return { applies: true, touches, connectors: [...connectors], packs: [...packs] };
}

/** What one step reads, saves and changes, and what it needs of the client. */
export function stepDataUse(step: Step, ctx: DataUseContext): StepDataUse {
  switch (step.kind) {
    case "read":
      return ctx.tools?.[step.tool]
        ? fromTools([step.tool], ctx)
        : { ...NONE, applies: true, unknown: step.tool };
    case "write": {
      if (step.tool !== undefined) {
        return ctx.tools?.[step.tool]
          ? fromTools([step.tool], ctx)
          : { ...NONE, applies: true, unknown: step.tool };
      }
      if (step.action === undefined) return { ...NONE, applies: true };
      // An action resolves when it runs: the tool of its `via`, else any of its connectors'.
      const tools = ACTION_SPECS[step.action].tools;
      const ids =
        step.via !== undefined
          ? [tools[step.via]].filter((t): t is string => t !== undefined)
          : Object.values(tools);
      const use = fromTools(ids, ctx);
      // DECISION (v0.18): an action without `via` needs one of its connectors, not each, so none is
      // listed as needed here; the publish check already asks for a binding that resolves it.
      return step.via !== undefined ? use : { ...use, connectors: [] };
    }
    case "skill": {
      const def = lookupSkill(step.skill, ctx);
      if (!def) return { ...NONE, applies: true, unknown: step.skill };
      const use = fromTools(skillTools(def), ctx);
      return {
        ...use,
        connectors: [...new Set([...use.connectors, ...def.requiresConnectors])],
        packs: [...new Set([...use.packs, ...def.requiresPacks])],
      };
    }
    default:
      return NONE;
  }
}

/** True when the step keeps nothing: it only reads, or uses no tool (kept in this run only). */
export function keepsNothing(use: StepDataUse): boolean {
  return use.applies && use.unknown === undefined && use.touches.every((t) => t.verb === "reads");
}

/** Whether a touch is on the shared business records (§5.2). */
export function isSharedRecord(t: Pick<DataTouch, "area">): boolean {
  return t.area === SHARED_AREA;
}

/** Every step of a process with what it does with data, in run order. */
export function processDataUse(
  process: Pick<Process, "steps">,
  ctx: DataUseContext,
): { step: Step; use: StepDataUse }[] {
  const out: { step: Step; use: StepDataUse }[] = [];
  walkSteps(process, ({ step }) => out.push({ step, use: stepDataUse(step, ctx) }));
  return out;
}
