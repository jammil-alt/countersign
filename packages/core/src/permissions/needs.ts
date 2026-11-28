// Connectors C1 (docs/connectors-plan.md §4): what an agent needs of a client's connections, worked
// out from its steps' tools and skills, never typed by hand and never stored; where a client's
// connections fall short of it (the gaps); and the matrix that allows exactly what it needs.
// Pure: the portal, the back office, Getting started and the setup guard all read these.

import { ACTION_SPECS } from "../process/actions";
import type { Step } from "../process/schema";
import { walkSteps } from "../process/walk";
import type { AutomationDefinition } from "../schemas/automation";
import {
  type AgentMode,
  DEFAULT_PERMISSIONS,
  type PermissionEntity,
  type PermissionLevel,
  type PermissionMatrix,
  type Verb,
} from "../schemas/permissions";
import { type SkillDefinition, skillTools } from "../schemas/skill";
import { isAlwaysSigned, type ToolSpec } from "../schemas/tool";
import { mergedAction } from "../steps/catalog";
import { Workflow as StepWorkflow } from "../steps/schema";
import { eachStep } from "../steps/walk";
import { lookupSkill, type TypingContext } from "../template/typer";
import { effectiveLevel, entityOfCall, readEntities } from "./entities";
import { bindingConnector, type GrantLimits, grantAllowsTool, stricterLevel } from "./grants";

/** The least a need asks: a read `on`, a write `ask` (Needs approval). */
export type ConnectorNeedLevel = "on" | "ask";

/** Where a need comes from: one step of one of the agent's processes. */
export interface NeedSource {
  /** The process's slug. */
  workflow: string;
  stepId: string;
  stepName: string;
}

/** One thing an agent needs on a client's connection (docs/connectors-plan.md §4.3). */
export interface ConnectorNeed {
  connector: string;
  verb: Verb;
  /** The record type, when the tool or the skill names one. */
  entity?: string | undefined;
  /** The tool behind it; absent for a skill's declared need (`SkillDefinition.needs`). */
  tool?: string | undefined;
  /** The least it needs: reads `on`, writes `ask` (Needs approval). */
  level: ConnectorNeedLevel;
  /** A step set to run without approval, in an agent in `act` mode, would run on its own. */
  wantsAuto: boolean;
  /**
   * A write action without `via` resolves to whichever of its connectors the agent is bound to:
   * needs sharing this key are alternatives, and one of them met is enough.
   */
  anyOf?: string | undefined;
  /** Why, from the skills that declare it. */
  why: string[];
  because: NeedSource[];
}

export interface NeedsContext extends TypingContext {
  /** The connector ids there are: a read tool whose `source` is one reads through it. */
  connectors: ReadonlySet<string>;
}

/** What one skill needs, before it is placed in a step. */
export type SkillNeedItem = Pick<ConnectorNeed, "connector" | "verb" | "entity" | "tool"> & {
  why?: string | undefined;
};

/** The connector a tool works through, if any: its `connector`, else a connector `source`. */
function toolConnector(tool: ToolSpec, connectors: ReadonlySet<string>): string | undefined {
  return tool.connector ?? (connectors.has(tool.source) ? tool.source : undefined);
}

/**
 * A tool's need: its connector, verb and record type. Null for a tool that touches no client tool
 * (a platform or pack tool, or an `internal` one that keeps our own records).
 */
export function toolNeed(tool: ToolSpec, connectors: ReadonlySet<string>): SkillNeedItem | null {
  if (tool.sideEffect === "internal") return null;
  const connector = toolConnector(tool, connectors);
  if (connector === undefined) return null;
  return {
    connector,
    verb: tool.sideEffect === "none" ? "read" : tool.verb,
    ...(tool.entity ? { entity: tool.entity } : {}),
    tool: tool.id,
  };
}

/**
 * The connectors a skill says it requires (`requiresConnectors`) that neither its tools nor its
 * declared `needs` cover. Built-in skills have none (a test holds them to it).
 */
export function uncoveredConnectors(
  skill: Pick<SkillDefinition, "handler" | "tools" | "reads" | "needs" | "requiresConnectors">,
  ctx: Pick<NeedsContext, "tools" | "connectors">,
): string[] {
  const covered = new Set(skillNeedsOwn(skill, ctx).map((n) => n.connector));
  return skill.requiresConnectors.filter((c) => !covered.has(c));
}

function skillNeedsOwn(
  skill: Pick<SkillDefinition, "handler" | "tools" | "reads" | "needs">,
  ctx: Pick<NeedsContext, "tools" | "connectors">,
): SkillNeedItem[] {
  const out: SkillNeedItem[] = [];
  for (const id of new Set([...skillTools(skill), ...(skill.reads ?? [])])) {
    const tool = ctx.tools?.[id];
    const need = tool ? toolNeed(tool, ctx.connectors) : null;
    if (need) out.push(need);
  }
  for (const n of skill.needs ?? []) {
    out.push({
      connector: n.connector,
      verb: n.verb,
      ...(n.entity ? { entity: n.entity } : {}),
      why: n.why,
    });
  }
  return out;
}

/**
 * What a skill needs of a client's connections: its tools' needs (`tools`, `handler`, `reads`),
 * its declared `needs`, and, for a stored skill that names a connector in `requiresConnectors` and
 * nothing else about it, a read on that connector (the least it can mean).
 */
// DECISION: a `requiresConnectors` entry no tool or need covers reads as "read on the connector",
// so skill versions stored before `needs` keep asking for their connector without guessing a write.
export function skillNeeds(
  skill: Pick<SkillDefinition, "handler" | "tools" | "reads" | "needs" | "requiresConnectors">,
  ctx: Pick<NeedsContext, "tools" | "connectors">,
): SkillNeedItem[] {
  const own = skillNeedsOwn(skill, ctx);
  const covered = new Set(own.map((n) => n.connector));
  for (const c of skill.requiresConnectors) {
    if (!covered.has(c)) {
      own.push({ connector: c, verb: "read" });
      covered.add(c);
    }
  }
  return own;
}

/** A step that runs a write without approval when the agent may (`not_required`). */
function skipsApproval(step: Step, override?: Step["checks"]): boolean {
  const approval = override?.approval ?? step.checks?.approval;
  return approval?.required === "not_required";
}

/** Collects needs, merged by connector, verb, record type, tool and alternative group. */
class NeedSet {
  private readonly byKey = new Map<string, ConnectorNeed>();

  add(
    item: SkillNeedItem,
    from: NeedSource,
    opts: { wantsAuto: boolean; anyOf?: string | undefined },
  ) {
    const key = [
      item.connector,
      item.verb,
      item.entity ?? "",
      item.tool ?? "",
      opts.anyOf ?? "",
    ].join("|");
    const level: ConnectorNeedLevel = item.verb === "read" ? "on" : "ask";
    const had = this.byKey.get(key);
    if (!had) {
      this.byKey.set(key, {
        connector: item.connector,
        verb: item.verb,
        ...(item.entity ? { entity: item.entity } : {}),
        ...(item.tool ? { tool: item.tool } : {}),
        level,
        wantsAuto: opts.wantsAuto && item.verb !== "read",
        ...(opts.anyOf ? { anyOf: opts.anyOf } : {}),
        why: item.why ? [item.why] : [],
        because: [from],
      });
      return;
    }
    had.wantsAuto ||= opts.wantsAuto && item.verb !== "read";
    if (item.why && !had.why.includes(item.why)) had.why.push(item.why);
    if (!had.because.some((b) => b.workflow === from.workflow && b.stepId === from.stepId)) {
      had.because.push(from);
    }
  }

  list(): ConnectorNeed[] {
    return [...this.byKey.values()];
  }
}

interface WalkCtx {
  ctx: NeedsContext;
  set: NeedSet;
  mode: AgentMode;
  workflow: string;
}

function addTool(
  w: WalkCtx,
  toolId: string,
  from: NeedSource,
  autoStep: boolean,
  anyOf?: string,
  input?: unknown,
): void {
  const tool = w.ctx.tools?.[toolId];
  if (!tool) return;
  const found = toolNeed(tool, w.ctx.connectors);
  if (!found) return;
  // Connectors C4: a tool whose input names the record type (HubSpot's, Zoho's, Odoo's) needs the
  // type the step's own input names, when it names one plainly ("purchase.order"), as the publish
  // check reads it; a type left to a template is not known until the run.
  // DECISION (docs/plan.md §1.161, C4): such a need without a plain type stays on the verb alone.
  const named = !found.entity && tool.entityInput ? entityOfCall(tool, input) : undefined;
  const need = named ? { ...found, entity: named } : found;
  // A step's approval only matters for the writes it makes; a verb a person always signs never
  // runs on its own (§1.73).
  const wantsAuto =
    autoStep && w.mode === "act" && tool.sideEffect === "external" && !isAlwaysSigned(tool);
  w.set.add(need, from, { wantsAuto, anyOf });
}

function visitStep(w: WalkCtx, step: Step, from: NeedSource, override?: Step["checks"]): void {
  const autoStep = skipsApproval(step, override);
  switch (step.kind) {
    case "read":
      addTool(w, step.tool, from, false, undefined, step.input);
      return;
    case "write": {
      if (step.tool !== undefined) {
        addTool(w, step.tool, from, autoStep, undefined, step.input);
        return;
      }
      if (step.action === undefined) return;
      const tools = ACTION_SPECS[step.action].tools;
      if (step.via !== undefined) {
        const id = tools[step.via];
        if (id) addTool(w, id, from, autoStep);
        return;
      }
      // DECISION: an action without `via` needs one of its connectors, whichever the agent is
      // bound to: each candidate is a need in one `anyOf` group, met when any one is.
      const group = `${from.workflow}/${from.stepId}`;
      for (const id of Object.values(tools)) addTool(w, id, from, autoStep, group);
      return;
    }
    case "skill": {
      const def = lookupSkill(step.skill, w.ctx);
      if (!def) return;
      for (const item of skillNeeds(def, w.ctx)) {
        const tool = item.tool ? w.ctx.tools?.[item.tool] : undefined;
        const wantsAuto =
          autoStep &&
          w.mode === "act" &&
          item.verb !== "read" &&
          (tool === undefined || !isAlwaysSigned(tool));
        w.set.add(item, from, { wantsAuto });
      }
      return;
    }
    case "process": {
      const def: AutomationDefinition | undefined = w.ctx.automations?.[step.process];
      if (!def) return;
      // Its steps are the agent's too; this agent's approval overrides apply by inner step id.
      walkSteps({ steps: def.steps }, ({ step: inner }) =>
        visitStep(
          w,
          inner,
          from,
          step.approvals?.[inner.id] ? { approval: step.approvals[inner.id] } : undefined,
        ),
      );
      return;
    }
    default:
      return;
  }
}

/** A skill's needs, placed in a step (`autoStep`: it runs without approval where it may). */
function addSkill(w: WalkCtx, ref: string, from: NeedSource, autoStep: boolean): void {
  const def = lookupSkill(ref, w.ctx);
  if (!def) return;
  for (const item of skillNeeds(def, w.ctx)) {
    const tool = item.tool ? w.ctx.tools?.[item.tool] : undefined;
    const wantsAuto =
      autoStep &&
      w.mode === "act" &&
      item.verb !== "read" &&
      (tool === undefined || !isAlwaysSigned(tool));
    w.set.add(item, from, { wantsAuto });
  }
}

/**
 * An action a v5 step or output names: a merged one (`email.send`, `accounting.bill.create`) needs
 * one of its connectors, whichever the agent is bound to (one `anyOf` group, as an action write
 * without `via`); any other is its tool.
 */
function addAction(
  w: WalkCtx,
  action: string,
  from: NeedSource,
  autoStep: boolean,
  input?: unknown,
): void {
  const merged = mergedAction(action);
  if (!merged) {
    addTool(w, action, from, autoStep, undefined, input);
    return;
  }
  const group = `${from.workflow}/${from.stepId}`;
  for (const id of Object.values(merged.tools)) addTool(w, id, from, autoStep, group);
}

/** The step model (docs/step-model-plan.md §4): a v5 workflow's needs, step by step and output. */
function visitStepModel(w: WalkCtx, workflow: StepWorkflow): void {
  eachStep(workflow.steps, ({ step }) => {
    const from = { workflow: w.workflow, stepId: step.id, stepName: step.name };
    if (step.kind === "loop") {
      if (step.skill) addSkill(w, step.skill, from, false);
      for (const id of step.reads) addTool(w, id, from, false);
      return;
    }
    if (step.kind !== "do") return;
    const autoStep = step.checks?.approval?.required === "not_required";
    const uses = step.uses;
    if (uses?.type === "action") addAction(w, uses.action, from, autoStep, step.input);
    else if (uses?.type === "skill") addSkill(w, uses.skill, from, autoStep);
    else if (uses?.type === "automation") {
      const def: AutomationDefinition | undefined = w.ctx.automations?.[uses.automation];
      if (def) walkSteps({ steps: def.steps }, ({ step: inner }) => visitStep(w, inner, from));
    }
  });
  for (const o of workflow.outputs) {
    if (!o.action) continue;
    const from = { workflow: w.workflow, stepId: o.id, stepName: o.name };
    const autoStep = o.checks?.approval?.required === "not_required";
    addAction(w, o.action.action, from, autoStep, o.action.input);
  }
}

/**
 * What an agent (a template or a client agent) needs of a client's connections, from every step of
 * every process it has, each need with the steps it comes from. Reads need `on`; writes need `ask`
 * and want `auto` where a step is set to run without approval in an agent in `act` mode.
 */
export function agentNeeds(
  bundle: {
    definition: { permissions: { mode: AgentMode } };
    workflows: readonly { slug: string; workflow: { schemaVersion: number; steps?: unknown } }[];
  },
  ctx: NeedsContext,
): ConnectorNeed[] {
  const set = new NeedSet();
  for (const w of bundle.workflows) {
    const walk: WalkCtx = { ctx, set, mode: bundle.definition.permissions.mode, workflow: w.slug };
    const parsed = StepWorkflow.safeParse(w.workflow);
    if (parsed.success) visitStepModel(walk, parsed.data);
  }
  return set.list();
}

// ── Gaps ─────────────────────────────────────────────────────────────────────────────────────

/** A client's connection, as the gap check reads it. */
export interface NeedsConnection {
  id: string;
  connector: string;
  /** `connected`, `error`, `disconnected` or `pending`. */
  status: string;
  permissions: Partial<PermissionMatrix> | null | undefined;
}

export interface AccessState {
  connections: readonly NeedsConnection[];
  /**
   * The agent's bindings (binding key → connection id). Absent when there is no client agent yet
   * (a template checked against a client): then any connection of the connector counts.
   */
  bindings?: Readonly<Record<string, string>> | undefined;
  /** The agent's grant by connection id; null or absent = no narrowing. */
  grants?: Readonly<Record<string, GrantLimits | null | undefined>> | undefined;
  /** Each connector's `permissionEntities`, for scopes. */
  declared?: Readonly<Record<string, readonly PermissionEntity[] | undefined>> | undefined;
}

/**
 * Why a need isn't met:
 * - `not_connected`: the client has no connection of the connector (or one half-way);
 * - `broken`: it has one, in error or disconnected;
 * - `not_bound`: connected, but this agent isn't bound to it;
 * - `off_on_connection`: the connection's settings turn the row off;
 * - `scope_excludes`: the connection narrows the row to a scope that leaves the tool out;
 * - `off_in_grant`: the agent's grant turns it off, or leaves the tool out;
 * - `could_run_alone`: met, but a step set to run without approval will still ask (a suggestion).
 */
export type GapKind =
  | "not_connected"
  | "broken"
  | "not_bound"
  | "off_on_connection"
  | "scope_excludes"
  | "off_in_grant"
  | "could_run_alone";

export interface AccessGap {
  kind: GapKind;
  connector: string;
  connectionId?: string | undefined;
  /** The needs it holds up, in the order they came. */
  needs: ConnectorNeed[];
  /** False only for `could_run_alone`: the agent works, asking first. */
  blocking: boolean;
  /** Who makes the fix: the client (sign in, allow a row) or us (bind, grant, ask). */
  fixBy: "client" | "mezonas";
}

const FIX_BY: Record<GapKind, AccessGap["fixBy"]> = {
  not_connected: "client",
  broken: "client",
  not_bound: "mezonas",
  off_on_connection: "client",
  scope_excludes: "client",
  off_in_grant: "mezonas",
  // DECISION: On its own is only ever ours to propose and the client's to approve (§5.4, §7.2).
  could_run_alone: "mezonas",
};

const GAP_ORDER: readonly GapKind[] = [
  "not_connected",
  "broken",
  "not_bound",
  "off_on_connection",
  "scope_excludes",
  "off_in_grant",
  "could_run_alone",
];

/** The connection a need goes through: the bound one, else (no agent yet) the best of the kind. */
function connectionFor(
  need: ConnectorNeed,
  state: AccessState,
): { connection?: NeedsConnection; kind?: GapKind } {
  const ofKind = state.connections.filter((c) => c.connector === need.connector);
  if (state.bindings) {
    const boundId = Object.entries(state.bindings).find(
      ([key]) => bindingConnector(key) === need.connector,
    )?.[1];
    const bound = boundId ? ofKind.find((c) => c.id === boundId) : undefined;
    if (bound) return { connection: bound };
    if (ofKind.some((c) => c.status === "connected")) return { kind: "not_bound" };
  }
  // No agent yet, or none bound and none connected: the best connection of the kind says it.
  const best =
    ofKind.find((c) => c.status === "connected") ??
    ofKind.find((c) => c.status === "error" || c.status === "disconnected");
  if (!best) return { kind: "not_connected" };
  return { connection: best };
}

function needTool(need: ConnectorNeed) {
  return {
    id: need.tool ?? `${need.connector}:${need.verb}:${need.entity ?? "*"}`,
    verb: need.verb,
    entity: need.entity,
  };
}

/** The level a need gets through a matrix and a grant (the gate's own rule, `effectiveLevel`). */
function levelThrough(
  need: ConnectorNeed,
  matrix: Partial<PermissionMatrix> | null | undefined,
  grant: GrantLimits | null | undefined,
  declared: readonly PermissionEntity[] | undefined,
): PermissionLevel {
  return effectiveLevel({ tool: needTool(need), matrix: matrix ?? undefined, grant, declared });
}

/** The gap one need has, if any (connection-level ones first). */
function needGap(
  need: ConnectorNeed,
  state: AccessState,
): { kind: GapKind; connectionId?: string } | null {
  const { connection, kind } = connectionFor(need, state);
  if (kind) return { kind };
  if (!connection) return { kind: "not_connected" };
  if (connection.status === "error" || connection.status === "disconnected") {
    return { kind: "broken", connectionId: connection.id };
  }
  if (connection.status !== "connected") return { kind: "not_connected" };
  const declared = state.declared?.[need.connector];
  const matrix = connection.permissions ?? DEFAULT_PERMISSIONS;
  const onConnection = levelThrough(need, matrix, null, declared);
  if (onConnection === "off") {
    // Off with the verb and the entity's own level both open: a scope leaves the tool out.
    const verbLevel = matrix[need.verb] ?? DEFAULT_PERMISSIONS[need.verb];
    const entities = readEntities(matrix);
    const entityLevel =
      need.entity && entities ? (entities[need.entity]?.[need.verb] ?? "auto") : "auto";
    const scoped = entities !== null && stricterLevel(verbLevel, entityLevel) !== "off";
    return { kind: scoped ? "scope_excludes" : "off_on_connection", connectionId: connection.id };
  }
  const grant = state.bindings ? state.grants?.[connection.id] : undefined;
  const withGrant = levelThrough(need, matrix, grant, declared);
  if (withGrant === "off" || (need.tool !== undefined && !grantAllowsTool(grant, need.tool))) {
    return { kind: "off_in_grant", connectionId: connection.id };
  }
  if (need.wantsAuto && withGrant !== "auto") {
    return { kind: "could_run_alone", connectionId: connection.id };
  }
  return null;
}

/**
 * Where a client's connections fall short of an agent's needs, one gap per connector, kind and
 * connection, each with the needs it holds up and who fixes it. Needs in an `anyOf` group are met
 * when any one of them is; then none of the group's blocking gaps is reported.
 */
export function accessGaps(needs: readonly ConnectorNeed[], state: AccessState): AccessGap[] {
  const each = needs.map((need) => ({ need, gap: needGap(need, state) }));
  const groupMet = new Set<string>();
  for (const { need, gap } of each) {
    if (need.anyOf && (gap === null || gap.kind === "could_run_alone")) groupMet.add(need.anyOf);
  }
  const out = new Map<string, AccessGap>();
  for (const { need, gap } of each) {
    if (!gap) continue;
    if (need.anyOf && groupMet.has(need.anyOf) && gap.kind !== "could_run_alone") continue;
    const key = `${need.connector}|${gap.kind}|${gap.connectionId ?? ""}`;
    const had = out.get(key);
    if (had) {
      had.needs.push(need);
      continue;
    }
    out.set(key, {
      kind: gap.kind,
      connector: need.connector,
      ...(gap.connectionId ? { connectionId: gap.connectionId } : {}),
      needs: [need],
      blocking: gap.kind !== "could_run_alone",
      fixBy: FIX_BY[gap.kind],
    });
  }
  return [...out.values()].sort(
    (a, b) =>
      GAP_ORDER.indexOf(a.kind) - GAP_ORDER.indexOf(b.kind) ||
      a.connector.localeCompare(b.connector),
  );
}

/** True when nothing blocks the agent: every gap left is a suggestion. */
export function needsMet(gaps: readonly AccessGap[]): boolean {
  return gaps.every((g) => !g.blocking);
}

// ── Allowing what an agent needs ─────────────────────────────────────────────────────────────

export interface AllowNeedsResult {
  matrix: PermissionMatrix;
  /** Rows it turned on (connector-wide verbs have no entity). */
  allowed: { verb: Verb; entity?: string | undefined }[];
  /** Needs it can't meet by levels alone: a scope that leaves the tool out, or a delete. */
  unresolved: ConnectorNeed[];
}

/**
 * A connection's matrix with one connector's needs allowed at their least level (reads on, writes
 * Needs approval), and nothing else loosened. Never `auto`: On its own is a separate yes (§5.4).
 * Used for "Allow what Buyer needs", a change request's rows, and a connection made for an agent
 * (§5.2, the low-risk default plus the agent's needs).
 */
// DECISION: where a verb is off for the whole connection, it opens the verb and pins each other
// record type the connector declares for that verb at `off`, so only the needed rows open. A tool
// of that connector with no record type does open with the verb: the matrix has no finer level.
export function allowNeeds(
  matrix: Partial<PermissionMatrix> | null | undefined,
  needs: readonly ConnectorNeed[],
  declared: readonly PermissionEntity[] | undefined,
): AllowNeedsResult {
  const out: PermissionMatrix = {
    ...DEFAULT_PERMISSIONS,
    ...(matrix ?? {}),
  } as PermissionMatrix;
  const entities = { ...(readEntities(out) ?? {}) };
  for (const [k, v] of Object.entries(entities)) entities[k] = { ...v };
  const allowed: AllowNeedsResult["allowed"] = [];
  const unresolved: ConnectorNeed[] = [];
  const target = (verb: Verb): PermissionLevel => (verb === "read" ? "auto" : "approval");
  const note = (verb: Verb, entity?: string) => {
    if (!allowed.some((a) => a.verb === verb && a.entity === entity)) {
      allowed.push(entity ? { verb, entity } : { verb });
    }
  };

  for (const need of needs) {
    if (need.verb === "delete") {
      unresolved.push(need);
      continue;
    }
    const verb = need.verb;
    if (out[verb] === "off") {
      out[verb] = target(verb);
      // Keep every other declared record type of this verb as it was: off.
      for (const e of declared ?? []) {
        if (e.id === need.entity || !e.verbs.includes(verb)) continue;
        const own = entities[e.id] ?? {};
        if (own[verb] === undefined) entities[e.id] = { ...own, [verb]: "off" };
      }
      note(verb);
    }
    if (need.entity) {
      const own = entities[need.entity] ?? {};
      if (own[verb] === "off") {
        entities[need.entity] = { ...own, [verb]: target(verb) };
        note(verb, need.entity);
      }
    }
    const after = effectiveLevel({
      tool: needTool(need),
      matrix: { ...out, entities },
      grant: null,
      declared,
    });
    if (after === "off") unresolved.push(need);
  }
  const result: PermissionMatrix = { ...out };
  if (Object.keys(entities).length > 0) result.entities = entities;
  else delete result.entities;
  return { matrix: result, allowed, unresolved };
}
