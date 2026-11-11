// Back office: Reshape data (owner, 2026-11-11; ARCHITECTURE §10.14 "Reshape data"). Two builder
// questions about a Reshape step in the process being edited (unsaved): propose its mapping (core's
// deterministic proposal by name and type, then the Builder AI once for what is left, every
// suggestion checked), and the value each field would hold (from the latest test or live run's
// stored step outputs, else samples from the schemas). Operator only; each request is audited by
// `mount`. The model call is the Builder's (the operator's cost), never a client run's.

import { resolveCustomSkill, suggestReshape } from "@countersign/agents";
import {
  isoToday,
  parseSkillRef,
  processes,
  type ReshapeProposalView,
  type ReshapeSampleView,
  resolveTemplate,
  routes,
  type SkillDefinition,
  type TypingContext,
} from "@countersign/core";
import { run, stepRun } from "@countersign/db";
import { createLlmClient, type LlmTransport } from "@countersign/llm";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Hono } from "hono";
import { type AppEnv, type HandlerCtx, HttpError, mount } from "../http";
import { workerTransport } from "../runs/execute";
import { agentInScope } from "./ops-lineage";

type Ctx = HandlerCtx<never>;

/** The model transport: the app's (tests pass a replay), else the Worker's live one. */
function transport(ctx: Pick<Ctx, "services">): LlmTransport {
  const { deps, env } = ctx.services;
  return deps.llm?.(env) ?? workerTransport(env);
}

/** The process and its Reshape step, as the builder sent them. */
function reshapeStep(body: { process: unknown; stepId: string }) {
  const parsed = processes.Process.safeParse(body.process);
  if (!parsed.success) {
    throw new HttpError(422, "invalid_process", "the process doesn't read as a v4 process");
  }
  const process = parsed.data;
  const step = processes.findStep(process, body.stepId)?.step;
  if (step?.kind !== "skill" || !processes.isReshapeStep(step)) {
    throw new HttpError(422, "not_a_reshape_step", `no Reshape data step "${body.stepId}"`);
  }
  return { process, step };
}

/** What the validator types with: the platform's tools and events, and every skill it names. */
async function typingFor(
  ctx: Pick<Ctx, "tx" | "services">,
  tenantId: string | null,
  process: processes.Process,
): Promise<TypingContext> {
  const { platform } = ctx.services;
  const skills: Record<string, SkillDefinition> = {};
  const refs = new Set<string>();
  processes.walkSteps(process, ({ step }) => {
    if (step.kind === "skill") refs.add(step.skill);
  });
  for (const ref of refs) {
    const builtin = platform.catalog.get(parseSkillRef(ref).id);
    const def = builtin ?? (await resolveCustomSkill(ctx.tx, { tenantId, ref }))?.definition;
    if (def) skills[ref] = def;
  }
  return {
    skills,
    tools: platform.tools.specs(),
    ...(platform.ctx.events ? { events: platform.ctx.events } : {}),
  };
}

export function opsReshapeRoutes(app: Hono<AppEnv>): void {
  mount(app, routes.opsReshapePropose, async (ctx): Promise<ReshapeProposalView> => {
    const { body } = ctx;
    const row = await agentInScope(ctx, ctx.params.id);
    const { process, step } = reshapeStep(body);
    const typing = await typingFor(ctx, row.tenantId, process);
    const context = processes.reshapeContext(process, step.id, typing);
    if (!context) throw new HttpError(422, "not_a_reshape_step", "the step isn't in the process");
    const proposal = processes.proposeReshape({
      context,
      ...(body.update ? { current: { input: step.input, mapping: step.reshape } } : {}),
    });
    const how: ReshapeProposalView["how"] = { ...proposal.how };
    let fields = proposal.mapping.fields;
    let unmapped = proposal.unmapped;
    const ai: ReshapeProposalView["ai"] = {
      asked: false,
      fields: [],
      dropped: [],
      why: {},
      costUsd: null,
    };
    // DECISION: the Builder AI is asked about top-level fields only, once per proposal; a mapped
    // list's item fields it left (`lines.account`) are the operator's.
    const ask = unmapped.filter((u) => !u.includes("."));
    if (body.ai !== false && ask.length > 0) {
      const s = await suggestReshape(
        { context, mapping: proposal.mapping, unmapped: ask },
        { llm: createLlmClient({ transport: transport(ctx) }) },
      ).catch((error: unknown) => {
        throw new HttpError(
          503,
          "builder_unavailable",
          `the Builder could not reach its model: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      fields = fields.map((f) => {
        const from = s.fields[f.name];
        return from ? { ...f, from } : f;
      });
      for (const name of Object.keys(s.fields)) how[name] = "ai";
      unmapped = unmapped.filter((u) => !Object.hasOwn(s.fields, u));
      Object.assign(ai, {
        asked: true,
        fields: Object.keys(s.fields),
        dropped: s.dropped,
        why: s.why,
        costUsd: s.costUsd,
      });
    }
    // The input brings in every source a field now reads.
    const used = new Set(fields.flatMap((f) => (f.from ? processes.exprInputKeys(f.from) : [])));
    const input: Record<string, string> = { ...proposal.input };
    for (const s of context.sources) {
      if (used.has(s.key) && !Object.hasOwn(input, s.key)) input[s.key] = s.template;
    }
    return {
      stepId: step.id,
      next: context.next ? { stepId: context.next.stepId, name: context.next.name } : null,
      sources: context.sources.map((s) => ({ key: s.key, label: s.label, template: s.template })),
      input,
      mapping: { fields },
      how,
      unmapped,
      ai,
    };
  });

  mount(app, routes.opsReshapeSample, async (ctx): Promise<ReshapeSampleView> => {
    const { tx, body } = ctx;
    const row = await agentInScope(ctx, ctx.params.id);
    const { process, step } = reshapeStep(body);
    const typing = await typingFor(ctx, row.tenantId, process);
    const context = processes.reshapeContext(process, step.id, typing);
    if (!context) throw new HttpError(422, "not_a_reshape_step", "the step isn't in the process");

    // The steps the input reads (`{{steps.<id>.output…}}`), and the trigger.
    const ids = new Set<string>();
    for (const v of Object.values(step.input)) {
      const m = typeof v === "string" ? /^\{\{\s*steps\.([^.}\s]+)\./.exec(v) : null;
      if (m?.[1]) ids.add(m[1]);
    }
    const scope: { trigger: unknown; steps: Record<string, { output: unknown }> } = {
      trigger: processes.sampleFromSchema(processes.processTriggerSchema(process, typing)),
      steps: {},
    };
    let from: ReshapeSampleView["run"] = null;
    // DECISION: a client agent's latest test or live run that stored an output for any step the
    // input reads (back office only; the step rows are the client's, read in its scope); a
    // template has no runs of its own, so it samples from the schemas.
    if (row.tenantId !== null && ids.size > 0) {
      const [latest] = await tx
        .select({ id: run.id, mode: run.mode, createdAt: run.createdAt, trigger: run.trigger })
        .from(stepRun)
        .innerJoin(run, and(eq(run.id, stepRun.runId), eq(run.tenantId, stepRun.tenantId)))
        .where(
          and(
            eq(stepRun.tenantId, row.tenantId),
            eq(run.agentId, row.id),
            inArray(stepRun.nodeId, [...ids]),
            eq(stepRun.status, "succeeded"),
          ),
        )
        .orderBy(desc(run.createdAt))
        .limit(1);
      if (latest) {
        const rows = await tx
          .select({ nodeId: stepRun.nodeId, output: stepRun.output })
          .from(stepRun)
          .where(
            and(
              eq(stepRun.tenantId, row.tenantId),
              eq(stepRun.runId, latest.id),
              inArray(stepRun.nodeId, [...ids]),
              eq(stepRun.status, "succeeded"),
            ),
          );
        for (const r of rows) scope.steps[r.nodeId] = { output: r.output };
        if (latest.trigger && typeof latest.trigger === "object") scope.trigger = latest.trigger;
        from = {
          id: latest.id,
          mode: latest.mode === "test" ? "test" : "live",
          at: latest.createdAt.toISOString(),
        };
      }
    }
    // A step the run didn't reach (or no run at all) reads as a sample of its output.
    for (const id of ids) {
      if (scope.steps[id]) continue;
      const src = context.sources.find((s) => s.template === `{{steps.${id}.output}}`);
      scope.steps[id] = { output: processes.sampleFromSchema(src?.schema) };
    }
    const input = resolveTemplate(step.input, scope);
    const mapping = step.reshape ?? { fields: [] };
    const r = processes.evaluateReshape(mapping, input, { today: isoToday(new Date()) });
    return {
      source: from ? "run" : "schema",
      run: from,
      input,
      fields: mapping.fields.map((f) => {
        const problem = r.problems.find(
          (p) => p.field === f.name || p.field.startsWith(`${f.name}.`),
        );
        return {
          name: f.name,
          value: Object.hasOwn(r.output, f.name) ? r.output[f.name] : null,
          problem: problem?.message ?? null,
        };
      }),
    };
  });
}
