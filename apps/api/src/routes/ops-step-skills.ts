// Stream F of the step model (docs/step-model-plan.md §5, §10): rules and AI written in a step,
// stored behind it as the agent's skill; Save as skill; and Suggest's answer. Every handler runs in
// the operator's session, inside the request's transaction, as the other `/api/ops` routes do.

import {
  type AgentRow,
  findStepIn,
  getVersion,
  isStepSkill,
  latestVersion,
  parseVersionBundle,
  saveAsSkillRefusal,
  saveStepAsSkill,
  storeStepSkills,
  suggestStep,
  validateForPublish,
} from "@countersign/agents";
import { routes, type SkillDefinition, steps } from "@countersign/core";
import { knownModelIds } from "@countersign/llm";
import type { Hono } from "hono";
import { clientModels } from "../compliance/models";
import { type AppEnv, HttpError, mount, notFound } from "../http";
import { meteredLlm } from "../metering";
import { builderHttpError, existingUnder } from "./ops-builder";
import { actionCatalogFor, agentInScope, operatorSkills } from "./ops-lineage";

/** The workflow as the step model reads it, or the plain 422 the other step routes give. */
function readWorkflow(raw: unknown): steps.Workflow {
  const parsed = steps.Workflow.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError(422, "invalid_workflow", "the workflow doesn't read in the step model");
  }
  return parsed.data;
}

export function opsStepSkillRoutes(app: Hono<AppEnv>): void {
  // The rules and the AI written in the workflow's steps, stored behind them as the agent's own
  // skills (a client agent's are the client's; a template's are shared, as it is no client's).
  mount(app, routes.opsStepSkillsStore, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const workflow = readWorkflow(ctx.body.workflow);
    const stored = await storeStepSkills(ctx.tx, {
      agentId: row.id,
      tenantId: row.tenantId,
      workflow,
      authorId: ctx.session.user.id,
      tools: ctx.services.platform.tools,
    }).catch(skillHttpError);
    return { skills: stored };
  });

  // DECISION: "this client only" is a client agent's choice; a template is no client's, so what it
  // saves is shared (and "this client only" is refused there). Either way the skill is published
  // at once, so it is in the library and the Uses picker straight away; a shared skill reaches a
  // client's agent with that agent's next publish, as every shared skill does (invariant 11).
  mount(app, routes.opsStepSaveAsSkill, async (ctx) => {
    const row = await agentInScope(ctx, ctx.params.id);
    const { body } = ctx;
    const workflow = readWorkflow(body.workflow);
    const step = findStepIn(workflow.steps, body.stepId);
    if (!step) throw notFound(`step ${body.stepId}`);
    const refusal = saveAsSkillRefusal(step);
    if (refusal) throw new HttpError(422, "cannot_save_as_skill", refusal);
    if (body.scope === "client" && row.tenantId === null) {
      throw new HttpError(
        422,
        "no_client",
        "This agent is a template, which is no client's. Share the skill with every client instead.",
      );
    }
    const saved = await saveStepAsSkill(ctx.tx, {
      tenantId: body.scope === "client" ? row.tenantId : null,
      step,
      name: body.name,
      description: body.description,
      authorId: ctx.session.user.id,
      tools: ctx.services.platform.tools,
    }).catch(skillHttpError);
    return {
      step: saved.step,
      skill: {
        ref: saved.ref,
        name: body.name,
        description: body.description,
        scope: body.scope,
      },
    };
  });

  // One checker (staging, 2026-11-28: the page's own copy of the check, with what the browser had
  // loaded, flagged issues the server didn't have and blocked Try it). The draft is checked exactly
  // as saving it on the version it was edited from would check it (`opsSaveVersion`), and as
  // publishing checks it (`publish`): the same `validateForPublish`, the same `previous`. Nothing
  // is stored.
  // DECISION: the rules and AI written in a step aren't stored here (a save stores them and pins
  // them first): no check reads the pins, so the answer is the same and the check writes nothing.
  mount(app, routes.opsWorkflowCheck, async (ctx) => {
    const { tx, body, services } = ctx;
    const row = await agentInScope(ctx, ctx.params.id);
    const workflow = readWorkflow(body.workflow);
    const parent = body.parentVersionId
      ? await getVersion(tx, body.parentVersionId)
      : await latestVersion(tx, row.id);
    if (!parent || parent.agentId !== row.id) throw notFound("version");
    const stored = parent.bundle as { workflows: { slug: string }[] };
    if (!stored.workflows.some((w) => w.slug === body.slug)) {
      throw notFound(`workflow ${body.slug}`);
    }
    const bundle = parseVersionBundle({
      ...stored,
      workflows: stored.workflows.map((w) => (w.slug === body.slug ? { ...w, workflow } : w)),
    });
    const errors = await validateForPublish(tx, row, bundle, services.platform.ctx, {
      previous: await existingUnder(tx, parent.id),
    });
    return { errors };
  });

  // Suggest (§5): the Builder's AI on one step, or one field, held to the form's rules.
  mount(app, routes.opsStepSuggest, async (ctx) => {
    const { services, body } = ctx;
    const row = await agentInScope(ctx, ctx.params.id);
    const workflow = readWorkflow(body.workflow);
    const step = findStepIn(workflow.steps, body.stepId);
    if (!step) throw notFound(`step ${body.stepId}`);
    const world = await suggestWorld(ctx, row);
    const metered = meteredLlm(
      { db: services.db, defer: ctx.defer },
      {
        transport: clientModels(services, { clients: [row.tenantId], read: ctx.tx }),
        tenantId: row.tenantId,
        source: "builder",
      },
    );
    const result = await suggestStep(
      {
        workflow,
        stepId: body.stepId,
        how: body.how,
        ...(body.field ? { field: body.field } : {}),
        ...(body.text ? { text: body.text } : {}),
      },
      world,
      { llm: metered.llm },
    ).catch(builderHttpError);
    return { step: result.step, summary: result.summary, applied: result.applied };
  });
}

/** What Suggest may point a step at, and what the publish checks know: the Uses picker's own lists. */
async function suggestWorld(
  ctx: Parameters<typeof actionCatalogFor>[0] & Parameters<typeof operatorSkills>[0],
  row: AgentRow,
) {
  const { platform } = ctx.services;
  const groups = await actionCatalogFor(ctx, row);
  const actions = groups.flatMap((g) =>
    g.actions.map((a) => ({ id: a.id, label: `${g.name} › ${a.label}`, kind: a.kind })),
  );
  const builtin = platform.catalog
    .list()
    .filter((d) => !isStepSkill(d))
    .map((d: SkillDefinition) => ({ ref: d.id, name: d.name, description: d.description }));
  const custom = (await operatorSkills(ctx, row.tenantId)).map((s) => ({
    ref: s.def.id,
    name: s.def.name,
    description: s.def.description,
  }));
  return {
    actions,
    skills: [...builtin, ...custom],
    models: knownModelIds(),
    context: {
      sideEffect: (id: string) => platform.tools.get(id)?.spec.sideEffect,
    },
  } as const;
}

/** A skill the registry refuses is a plain 422 in the registry's words. */
function skillHttpError(error: unknown): never {
  if (error instanceof Error && error.name === "AgentsError") {
    const e = error as Error & { code?: string };
    throw new HttpError(422, e.code ?? "invalid_skill", error.message);
  }
  throw error;
}
