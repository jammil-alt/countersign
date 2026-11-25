// The step model (docs/step-model-plan.md §7; stream A's wiring of stream D): the executor's Match
// port, over the deployment's Match engine (`matchPort()` in ../packs.ts, every area's profiles).
// Each call runs in one client's pack context, as a pack tool's does (`packToolContext`), on the
// run's model transport, which for a client in HIPAA mode is the guarded one (`forClient`): a
// model call its compliance refuses is refused, and the engine leaves the item for a person.

import { conferModel, type RuntimeDeps, recordModelCall } from "@countersign/agents";
import {
  ComplianceRefusal,
  type ModelChoice,
  PROFILE_CHOICE_TOOL,
  type ProfileChooser,
  ProfileMatchError,
  profileChoiceMessages,
} from "@countersign/core";
import type { Db } from "@countersign/db";
import type { LlmClient, LlmTransport } from "@countersign/llm";
import type { PackToolContext } from "@countersign/pack-materials";
import { packToolContext } from "@countersign/pack-materials";
import type { MatchPort, RunInfo } from "@countersign/workflows";
import { matchPort } from "../packs";

/** A model that chooses among a shortlist, its usage on the Match step's row. */
function chooser(llm: LlmClient, model: ModelChoice, label: string): ProfileChooser {
  return async (question) => {
    const m = profileChoiceMessages(question);
    const { value } = await llm.callTool({
      model: model.id as never,
      maxTokens: Math.min(model.maxTokens ?? 1024, 1024),
      system: m.system,
      messages: [{ role: "user", content: m.user }],
      tool: {
        name: PROFILE_CHOICE_TOOL.name,
        description: PROFILE_CHOICE_TOOL.description,
        schema: PROFILE_CHOICE_TOOL.schema,
      },
      label,
    });
    return value;
  };
}

/**
 * The Match port for one run. `transport` is the run's (guarded for a client in HIPAA mode);
 * `runtime` gives the agent's model and where usage and model calls are recorded.
 */
// DECISION: the step's model is the agent's own; its second opinion, by default, a different one
// (`conferModel`, as a Confer's AI reviewer), so a second look is never the same model's (§7).
export function runMatchPort(deps: {
  db: Db;
  transport: LlmTransport | null;
  runtime: RuntimeDeps;
  info: RunInfo;
}): MatchPort {
  const { db, transport, runtime, info } = deps;
  const engine = matchPort();
  const context = (nodeId: string, stepRunId: string | null): PackToolContext =>
    packToolContext({
      tenantId: info.tenantId,
      agentVersionId: info.agentVersionId,
      runId: info.id,
      stepId: nodeId,
      mode: info.mode,
      db,
      transport,
      recordUsage: async (usage) => {
        if (!stepRunId) return;
        await runtime.ports.log.addUsage(info.tenantId, { runId: info.id, stepRunId }, usage);
      },
      recordModelCall: async (record, exchange) => {
        if (!stepRunId) return;
        await recordModelCall(
          runtime.ports.modelCalls,
          info.tenantId,
          { runId: info.id, stepRunId, agentVersionId: info.agentVersionId, action: "choice" },
          record,
          exchange,
        );
      },
    });
  return {
    async match({ nodeId, stepRunId, match, input }) {
      const profile = engine.profile(match.to);
      if (!profile) return { kind: "failed", error: `nothing can be matched to "${match.to}"` };
      const ctx = context(nodeId, stepRunId);
      const raw = input as { items?: unknown } | null;
      const items = (Array.isArray(raw?.items) ? raw.items : [input]).map((i) =>
        i !== null && typeof i === "object" ? (i as Record<string, unknown>) : { value: i },
      );
      const pinned = await runtime.ports.store.loadAgentVersion(info.tenantId, info.agentVersionId);
      const model = pinned.bundle.definition.model;
      const llm = ctx.llm;
      try {
        const r = await engine.match({
          ctx,
          settings: match,
          items,
          ...(llm
            ? {
                choose: chooser(llm, model, `${nodeId}:match`),
                second: chooser(llm, conferModel(model, {}), `${nodeId}:match:second`),
              }
            : {}),
        });
        return {
          kind: "done",
          output: r.output,
          notes: r.notes.map((n) => ({ sources: n.sources, labels: n.labels })),
          profileName: profile.name,
        };
      } catch (error) {
        if (error instanceof ProfileMatchError || error instanceof ComplianceRefusal) {
          return { kind: "failed", error: error.message };
        }
        throw error;
      }
    },
    async learn({ nodeId, profile, item, recordId, personId }) {
      return engine.learn({
        ctx: context(nodeId, null),
        profile,
        item: (item !== null && typeof item === "object" ? item : { value: item }) as Record<
          string,
          unknown
        >,
        recordId,
        by: { personId, runId: info.id, stepId: nodeId, agentVersionId: info.agentVersionId },
      });
    },
  };
}
