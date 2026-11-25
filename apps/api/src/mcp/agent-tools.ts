// An agent's steps and their settings through the MCP server (docs/plan.md §1.34, "Builds and
// step settings"): read every step of a template or client agent, change a step's settings as a
// new draft version, and publish that draft. Each runs the back office's own agent routes as this
// operator (`invokeRoute`: roles, client scope, the bundle's schema and validation, audit), so a
// change made here is a version like one made in the builder (invariant 3), checked the same way.
//
// DECISION (owner, 2026-11-24): a step's own settings only; adding, removing or moving steps and
// paths stays in the builder. A change that turns an approval off, takes it away, or moves the
// agent to act is refused here, in the draft and at publish: that loosening is a person's, in the
// back office (invariant 8). An agent never published is published there too (its first publish
// is how it goes live), so agent_publish only publishes a new version of an agent already live,
// with the two-step confirm and the change shown first.

import {
  type AnyAgentBundle,
  allSteps,
  classifyChange,
  isUuid,
  processes,
  type RouteSpec,
  routes,
} from "@countersign/core";
import { z } from "zod";
import { HttpError, invokeRoute, type RouteInput } from "../http";
import { CONFIRM_ARG } from "./confirm";
import type { OpsToolCtx } from "./ops-tools";
import { clip, dataResult } from "./output";
import type { Tool } from "./protocol";
import { issueFor, useToken } from "./two-step";

const READ = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;
const WRITE = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const Id = z.string().refine(isUuid, "not an id").describe("A Mezonas id (uuid)");
const AgentId = Id.describe("An agent's id (uuid): agents_list, client_get, or a build's draft");

function route<R extends RouteSpec>(ctx: OpsToolCtx, spec: R, raw: RouteInput = {}) {
  return invokeRoute(ctx.app, ctx.c, ctx.session, spec, raw, ctx.via ?? "mcp");
}

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** A step's fields that hold other steps: the builder's, never changed here. */
const STRUCTURE = new Set(["id", "kind", "steps", "paths", "otherwise"]);

interface Located {
  workflow: { index: number; slug: string; name: string };
  step: Json;
  pointer: (string | number)[];
}

/** Every step of every workflow in the bundle, v3 workflows and v4 processes alike, in run order. */
export function stepsOf(bundle: unknown): Located[] {
  const out: Located[] = [];
  const workflows = isObj(bundle) && Array.isArray(bundle.workflows) ? bundle.workflows : [];
  workflows.forEach((w: unknown, index) => {
    if (!isObj(w) || !isObj(w.workflow)) return;
    const wf = w.workflow as { schemaVersion?: number; steps?: unknown };
    if (!Array.isArray(wf.steps)) return;
    const meta = { index, slug: String(w.slug ?? ""), name: String(w.name ?? w.slug ?? "") };
    const locs =
      wf.schemaVersion === 4
        ? processes.allSteps(wf as Parameters<typeof processes.allSteps>[0])
        : allSteps(wf as Parameters<typeof allSteps>[0]);
    for (const l of locs) out.push({ workflow: meta, step: l.step as Json, pointer: l.pointer });
  });
  return out;
}

/** The value at a pointer under `root`. */
function at(root: unknown, pointer: readonly (string | number)[]): unknown {
  let here: unknown = root;
  for (const seg of pointer) {
    if (here === null || typeof here !== "object") return undefined;
    here = (here as Record<string | number, unknown>)[seg];
  }
  return here;
}

/** The steps (and their paths) a step sits inside, outermost first: "Check amount › Over 5,000". */
function within(workflow: unknown, pointer: readonly (string | number)[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < pointer.length - 1; i++) {
    if (typeof pointer[i] !== "number" || pointer[i - 1] !== "steps") continue;
    const outer = at(workflow, pointer.slice(0, i + 1));
    if (!isObj(outer)) continue;
    let label = String(outer.name || outer.id);
    const next = pointer[i + 1];
    if (next === "paths" && typeof pointer[i + 2] === "number") {
      const p = (outer.paths as Json[] | undefined)?.[pointer[i + 2] as number];
      if (p) label += ` › ${String(p.name || p.id)}`;
    } else if (next === "otherwise") {
      label += " › otherwise";
    }
    out.push(label);
  }
  return out;
}

/** A step's own settings: everything but the steps inside it, which are counted instead. */
export function ownSettings(step: Json, clipAt?: number): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(step)) {
    if (k === "steps" && Array.isArray(v)) out.stepsInside = v.length;
    else if (k === "paths" && Array.isArray(v)) {
      out.paths = v.map((p) =>
        isObj(p)
          ? {
              ...Object.fromEntries(Object.entries(p).filter(([pk]) => pk !== "steps")),
              stepsInside: Array.isArray(p.steps) ? p.steps.length : 0,
            }
          : p,
      );
    } else if (k === "otherwise" && isObj(v)) {
      out.otherwise = {
        ...Object.fromEntries(Object.entries(v).filter(([pk]) => pk !== "steps")),
        stepsInside: Array.isArray(v.steps) ? v.steps.length : 0,
      };
    } else out[k] = clipAt && k !== "id" && k !== "kind" && k !== "name" ? clip(v, clipAt) : v;
  }
  return out;
}

/** A step's approval: its own `approval.required`, or a v4 check's; null when it has none. */
function approvalOf(step: Json): string | null {
  if (isObj(step.approval)) return String(step.approval.required ?? "required");
  if (isObj(step.checks) && isObj(step.checks.approval)) {
    return String(step.checks.approval.required ?? "required");
  }
  return null;
}

/**
 * What a change from `before` to `after` loosens that only the back office may: an approval
 * turned off or taken away, or the agent moved to act. Empty when it loosens none of these.
 */
export function backOfficeOnly(before: unknown, after: unknown): string[] {
  const out: string[] = [];
  const modeOf = (b: unknown) => {
    const d = isObj(b) && isObj(b.definition) ? b.definition : {};
    return isObj(d.permissions) ? String(d.permissions.mode ?? "suggest_only") : "suggest_only";
  };
  if (modeOf(after) === "act" && modeOf(before) !== "act") out.push("moves the agent to act");
  const was = new Map(
    stepsOf(before).map((l) => [`${l.workflow.slug}/${String(l.step.id)}`, l.step] as const),
  );
  for (const l of stepsOf(after)) {
    const old = was.get(`${l.workflow.slug}/${String(l.step.id)}`);
    const now = approvalOf(l.step);
    const then = old ? approvalOf(old) : null;
    const name = String(l.step.name || l.step.id);
    if (now === "not_required" && then !== "not_required") {
      out.push(`turns approval off on "${name}"`);
    } else if (now === null && then !== null) {
      out.push(`takes the approval away from "${name}"`);
    }
  }
  return out;
}

/** Sets (or, with null, removes) a field by a dotted path such as `approval.required`. */
function setPath(target: Json, path: string, value: unknown): void {
  const parts = path.split(".");
  let here: Json = target;
  for (const part of parts.slice(0, -1)) {
    if (!isObj(here[part])) here[part] = {};
    here = here[part] as Json;
  }
  const last = parts.at(-1) as string;
  if (value === null) delete here[last];
  else here[last] = value;
}

/** The agent with its live and latest versions, from the back office's agent route. */
function agentRead(ctx: OpsToolCtx, id: string) {
  return route(ctx, routes.opsAgent, { params: { id } });
}

function agentHeader(a: Awaited<ReturnType<typeof agentRead>>["agent"], ctx: OpsToolCtx) {
  const client = a.tenantId
    ? (ctx.session.memberships.find((m) => m.tenantId === a.tenantId)?.tenantName ?? null)
    : null;
  return {
    id: a.id,
    name: a.name,
    slug: a.slug,
    kind: a.kind,
    client: a.tenantId ? { id: a.tenantId, name: client } : null,
    status: a.status,
    stage: a.stage ?? null,
    templateId: a.templateId,
    linked: a.linked,
    liveVersionId: a.liveVersionId,
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────────────────────

const agentsList: Tool<OpsToolCtx> = {
  name: "agents_list",
  title: "List agents",
  description:
    "A client's agents (with client), or the templates (without): id, name, status, go-live stage, live version and template. Open one's steps with agent_steps.",
  input: z.strictObject({
    client: Id.optional().describe(
      "A client's id (uuid), from clients_list; leave out for templates",
    ),
  }),
  annotations: READ,
  async run(ctx, args) {
    const { client } = args as { client?: string };
    const agents = client
      ? (await route(ctx, routes.opsClientAgents, { params: { id: client } })).agents
      : (await route(ctx, routes.opsTemplates, {})).templates;
    return dataResult(
      "agents_list",
      `${agents.length} ${client ? "agent" : "template"}${agents.length === 1 ? "" : "s"}.`,
      agents.map((a) => ({
        id: a.id,
        name: a.name,
        slug: a.slug,
        kind: a.kind,
        status: a.status,
        stage: a.stage ?? null,
        liveVersionId: a.liveVersionId,
        templateId: a.templateId,
        linked: a.linked,
        testCopy: a.testCopy,
      })),
    );
  },
};

const agentSteps: Tool<OpsToolCtx> = {
  name: "agent_steps",
  title: "An agent's steps and settings",
  description:
    "Every step of an agent (a template or a client agent), workflow by workflow in run order, with each step's settings: kind, input, approval and checks, model, review, skill settings and the rest. version latest (default) reads the newest version, a draft if one is ahead of live; live reads what runs now. With step, only that step, nothing shortened. Also the workflows' triggers and what would stop the draft from publishing.",
  input: z.strictObject({
    agent: AgentId,
    version: z.enum(["latest", "live"]).default("latest"),
    step: z.string().min(1).max(100).optional().describe("One step's id"),
  }),
  annotations: READ,
  async run(ctx, args) {
    const a = args as { agent: string; version: "latest" | "live"; step?: string };
    const read = await agentRead(ctx, a.agent);
    const v = a.version === "live" ? read.live : (read.latest ?? read.live);
    if (!v) throw new HttpError(404, "not_found", `the agent has no ${a.version} version`);
    const isLive = v.id === read.agent.liveVersionId;
    const steps = stepsOf(v.bundle);
    const bundle = v.bundle as AnyAgentBundle;
    const version = {
      id: v.id,
      version: v.version,
      status: v.status,
      live: isLive,
      changeNote: v.changeNote,
      createdAt: v.createdAt,
    };
    const draftAhead = !!read.latest && read.latest.id !== read.agent.liveVersionId;
    if (a.step) {
      const found = steps.filter((l) => l.step.id === a.step);
      if (found.length === 0) throw new HttpError(404, "not_found", "step not found");
      return dataResult("agent_steps", "The step's settings.", {
        agent: agentHeader(read.agent, ctx),
        version,
        steps: found.map((l) => ({
          workflow: l.workflow.slug,
          within: within(bundle.workflows[l.workflow.index]?.workflow, l.pointer),
          settings: ownSettings(l.step),
        })),
      });
    }
    const workflows = (bundle.workflows ?? []).map((w, index) => {
      const wf = w.workflow as unknown as Json;
      return {
        slug: w.slug,
        name: w.name,
        enabled: w.enabled,
        triggers:
          wf.triggers ?? [wf.trigger, ...((wf.moreTriggers as unknown[]) ?? [])].filter(Boolean),
        steps: steps
          .filter((l) => l.workflow.index === index)
          .map((l) => ({
            within: within(wf, l.pointer),
            settings: ownSettings(l.step, 1500),
          })),
      };
    });
    const errors = !isLive && read.latestErrors?.length ? read.latestErrors : [];
    return dataResult(
      "agent_steps",
      `${steps.length} step${steps.length === 1 ? "" : "s"} in v${v.version} (${isLive ? "live" : "a draft, not live"}).${draftAhead && isLive ? " A draft is ahead of live: version latest reads it." : ""}`,
      { agent: agentHeader(read.agent, ctx), version, draftAhead, workflows, errors },
    );
  },
};

const agentStepUpdate: Tool<OpsToolCtx> = {
  name: "agent_step_update",
  title: "Change a step's settings",
  description:
    "Change one step's settings and save it as a new draft version of the agent (the live version keeps running until agent_publish). set maps fields to new values: top level (input, model, review, settings, name, purpose) or dotted (approval.approver, checks.approval.mode); null removes one. Read the step with agent_steps first: an object given whole replaces it. The step's id, kind and the steps inside it are the builder's and can't be set here, nor can an approval be turned off or taken away (the back office does that). Answers what would stop the draft from publishing.",
  input: z.strictObject({
    agent: AgentId,
    step: z.string().min(1).max(100).describe("The step's id"),
    workflow: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe("The workflow's slug, if the step id is in more than one"),
    set: z.record(z.string().min(1).max(200), z.unknown()),
    note: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("The change note (default: what changed)"),
  }),
  annotations: WRITE,
  async run(ctx, args) {
    const a = args as {
      agent: string;
      step: string;
      workflow?: string;
      set: Record<string, unknown>;
      note?: string;
    };
    ctx.audit.target = { agent: a.agent, step: a.step };
    const keys = Object.keys(a.set);
    if (keys.length === 0) throw new HttpError(422, "invalid_request", "nothing to set");
    const structural = keys.filter((k) => STRUCTURE.has(k.split(".")[0] as string));
    if (structural.length > 0) {
      throw new HttpError(
        422,
        "builder_only",
        `${structural.join(", ")} can't be set here: a step's id, kind and the steps inside it are changed in the builder`,
      );
    }
    const read = await agentRead(ctx, a.agent);
    const base = read.latest ?? read.live;
    if (!base) throw new HttpError(404, "not_found", "the agent has no version yet");
    const bundle = structuredClone(base.bundle) as Json;
    const found = stepsOf(bundle).filter(
      (l) => l.step.id === a.step && (!a.workflow || l.workflow.slug === a.workflow),
    );
    if (found.length === 0) throw new HttpError(404, "not_found", "step not found");
    if (found.length > 1) {
      throw new HttpError(
        422,
        "ambiguous_step",
        `the step is in ${found.map((l) => l.workflow.slug).join(", ")}: give workflow`,
      );
    }
    const [loc] = found as [Located];
    for (const [k, v] of Object.entries(a.set)) setPath(loc.step, k, v);
    const loosens = backOfficeOnly(base.bundle, bundle);
    if (loosens.length > 0) {
      throw new HttpError(
        409,
        "back_office_only",
        `this ${loosens.join("; ")}: turning an approval off or letting the agent act is done in the back office`,
      );
    }
    const name = String(loc.step.name || loc.step.id);
    const saved = await route(ctx, routes.opsSaveVersion, {
      params: { id: a.agent },
      body: {
        bundle,
        parentVersionId: base.id,
        changeNote:
          a.note ?? `Changed "${name}": ${keys.join(", ")} (through Claude)`.slice(0, 500),
      },
    });
    ctx.audit.target = { agent: a.agent, step: a.step, version: saved.version.id };
    const vsLive = read.live ? classifyChange(read.live.bundle, bundle) : null;
    return dataResult(
      "agent_step_update",
      [
        `Saved v${saved.version.version}, a draft: the live version keeps running until it is published.`,
        saved.errors.length > 0
          ? `${saved.errors.length} problem${saved.errors.length === 1 ? "" : "s"} would stop it from publishing (below).`
          : read.live
            ? "It would publish: agent_publish previews it."
            : "This agent was never published: publish it from the back office.",
      ].join(" "),
      {
        version: saved.version,
        step: { workflow: loc.workflow.slug, settings: ownSettings(loc.step) },
        errors: saved.errors,
        againstLive: vsLive,
      },
    );
  },
};

const agentPublish: Tool<OpsToolCtx> = {
  name: "agent_publish",
  title: "Publish an agent's draft",
  description:
    "Publish the agent's latest draft version, so it runs from now on in place of the live one. Only for an agent already live (a first publish is the back office's), a draft that validates, and a change that turns no approval off and doesn't let the agent act. Publishing a template changes no client agent. Two steps: call it without confirm_token to see the change and get a token; then call it again with the same agent and that confirm_token.",
  input: z.strictObject({
    agent: AgentId,
    [CONFIRM_ARG]: z
      .string()
      .min(1)
      .max(4000)
      .optional()
      .describe("From the first call's answer; leave out to preview"),
  }),
  annotations: { ...WRITE, destructiveHint: true },
  async run(ctx, args) {
    const a = args as { agent: string; [CONFIRM_ARG]?: string };
    ctx.audit.target = { agent: a.agent };
    const read = await agentRead(ctx, a.agent);
    const { live, latest } = read;
    if (!live) {
      throw new HttpError(
        409,
        "back_office_only",
        "this agent was never published: its first publish is done in the back office",
      );
    }
    if (!latest || latest.id === live.id) {
      throw new HttpError(409, "nothing_to_publish", "no draft is ahead of the live version");
    }
    ctx.audit.target = { agent: a.agent, version: latest.id };
    const loosens = backOfficeOnly(live.bundle, latest.bundle);
    if (loosens.length > 0) {
      throw new HttpError(
        409,
        "back_office_only",
        `v${latest.version} ${loosens.join("; ")}: publish it from the back office`,
      );
    }
    if (read.latestErrors?.length) {
      throw new HttpError(
        422,
        "invalid_bundle",
        `v${latest.version} doesn't validate: ${read.latestErrors.length} problem${read.latestErrors.length === 1 ? "" : "s"}; agent_steps lists them`,
        read.latestErrors,
      );
    }
    // The token is bound to the draft it previewed: a newer draft saved since needs a new preview.
    const bound = { agent: a.agent, version: latest.id };
    const token = a[CONFIRM_ARG];
    if (!token) {
      const diff = await route(ctx, routes.opsVersionDiff, {
        params: { id: a.agent, vid: latest.id },
        query: { against: live.id },
      });
      const change = classifyChange(live.bundle, latest.bundle);
      const issued = await issueFor(ctx, "agent_publish", bound);
      const who =
        read.agent.kind === "template"
          ? "It is a template: no client agent changes until one takes the update."
          : "It runs for the client from the next run.";
      return dataResult(
        "agent_publish",
        [
          `Preview, nothing changed yet. This will publish v${latest.version} of "${read.agent.name}" in place of v${live.version}, as you, in Mezonas ${ctx.config.environment}. ${who}`,
          change.class === "never"
            ? `Our check reads it as a change that loosens or may loosen something: ${change.reasons.join("; ")}. Look before you confirm.`
            : "Our check reads it as a change that loosens nothing.",
          issued.offer,
        ].join("\n"),
        {
          agent: agentHeader(read.agent, ctx),
          from: { id: live.id, version: live.version },
          to: { id: latest.id, version: latest.version, changeNote: latest.changeNote },
          check: change,
          changes: clip(diff.changes, 12_000),
        },
      );
    }
    await useToken(ctx, "agent_publish", bound, token);
    const out = await route(ctx, routes.opsPublish, { params: { id: a.agent, vid: latest.id } });
    ctx.audit.outcome = "done";
    return dataResult("agent_publish", `Published v${out.version.version}.`, {
      version: out.version,
    });
  },
};

export const AGENT_TOOLS: readonly Tool<OpsToolCtx>[] = [
  agentsList,
  agentSteps,
  agentStepUpdate,
  agentPublish,
];
