// Who speaks on a call and with what (docs/plan.md §1.23): the ElevenLabs voice agent for a client
// agent's version and a step's call settings (made once per distinct settings and kept by their
// hash), and, for a call ringing in, whether an agent may answer it: only where the client agent's
// answering step (`call.answer`, in a workflow on `call.received`) may run without approval: the
// operator set it to `not_required`, the connection's matrix allows `auto` for create and the agent
// is in `act` mode (invariant 8). Otherwise the call is forwarded or goes to voicemail.

import { grantOf } from "@countersign/agents";
import {
  CALL_ANSWER_TOOL,
  CALL_RECEIVED_EVENT,
  createVoiceAgent,
  ELEVENLABS_AGENT_ENTITY,
  ELEVENLABS_CONNECTOR_ID,
  elevenLabsLanguage,
  type FetchLike,
  FOLLOW_UP_TOOL,
  globalFetch,
  VOICE_FIXED_INPUTS,
  type VoiceAgentConfig,
  type VoiceSettings,
  VoiceSettings as VoiceSettingsSchema,
  type VoiceTool,
  voiceAgentHash,
  voicePrompt,
  voiceToolName,
} from "@countersign/connectors";
import {
  type AgentBundle,
  type CallLanguage,
  decideToolCall,
  fixedInputProblem,
  grantAllowsTool,
  type InboundDecision,
  openingLine,
  type PermissionMatrix,
  type Step,
} from "@countersign/core";
import { agent, agentVersion, type Tx } from "@countersign/db";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { releaseCoversTx } from "../access/release";
import type { Bindings } from "../env";
import type { Platform } from "../platform";
import { findRecord, storeOnce } from "./store";

/** What calls need from the deployment: ElevenLabs, our public origin, outbound HTTP. */
export interface VoiceDeps {
  elevenlabs: { apiKey: string; webhookSecret: string } | null;
  origin: string;
  fetch: FetchLike;
}

export function voiceDepsFromEnv(
  env: Pick<Bindings, "ELEVENLABS_API_KEY" | "ELEVENLABS_WEBHOOK_SECRET" | "APP_ORIGIN">,
  fetch: FetchLike = globalFetch(),
  fallbackOrigin = "",
): VoiceDeps {
  const apiKey = env.ELEVENLABS_API_KEY?.trim();
  const webhookSecret = env.ELEVENLABS_WEBHOOK_SECRET?.trim();
  return {
    elevenlabs: apiKey && webhookSecret ? { apiKey, webhookSecret } : null,
    origin: (env.APP_ORIGIN?.trim() || fallbackOrigin).replace(/\/+$/, ""),
    fetch,
  };
}

export function voiceToolsUrl(origin: string, tenantId: string): string {
  return `${origin}/api/voice/${tenantId}/tools`;
}

const FOLLOW_UP_INPUT = {
  type: "object",
  properties: {
    what: {
      type: "string",
      description: "What the person asked to change, in their words, with any details they gave.",
    },
  },
  required: ["what"],
};

/**
 * The voice agent's settings for one call: the platform's rules and the agent's version (identity,
 * instructions) with the step's purpose, the disclosure-first opening, the language, and as server
 * tools only the step's tools that read (writes are left out here and refused at call time too).
 */
export function voiceAgentConfig(input: {
  tenantId: string;
  client: string;
  agentSlug: string;
  bundle: AgentBundle;
  settings: VoiceSettings;
  language: CallLanguage;
  direction: "in" | "out";
  origin: string;
  platform: Platform;
}): VoiceAgentConfig {
  const d = input.bundle.definition;
  const toolsUrl = voiceToolsUrl(input.origin, input.tenantId);
  const tools: VoiceTool[] = [];
  for (const id of input.settings.tools) {
    const spec = input.platform.tools.get(id)?.spec;
    if (spec?.sideEffect !== "none") continue;
    tools.push({
      name: voiceToolName(id),
      description: spec.description,
      url: `${toolsUrl}/${voiceToolName(id)}`,
      input: spec.input as Record<string, unknown>,
    });
  }
  tools.push({
    name: FOLLOW_UP_TOOL,
    description:
      "Note something the person asked to change (an order, a booking, a payment, a record). Nothing changes now: a person reviews it after the call.",
    url: `${toolsUrl}/${FOLLOW_UP_TOOL}`,
    input: FOLLOW_UP_INPUT,
  });
  return {
    name: `mezonas-${input.tenantId.slice(0, 8)}-${input.agentSlug}`,
    prompt: voicePrompt({
      client: input.client,
      agentName: d.identity.name,
      role: d.identity.role,
      mission: d.identity.mission,
      instructions: d.instructions,
      purpose: input.settings.purpose,
      direction: input.direction,
    }),
    firstMessage: openingLine({
      direction: input.direction,
      language: input.language,
      client: input.client,
      firstMessage: input.settings.firstMessage,
    }),
    language: elevenLabsLanguage(input.language),
    voiceId: input.settings.voiceId ?? null,
    maxDurationSecs: input.settings.maxMinutes * 60,
    tools,
  };
}

/** The ElevenLabs agent for a config: the one made before for the same settings, or a new one. */
export async function ensureVoiceAgent(
  tx: Tx,
  input: {
    tenantId: string;
    connectionId: string;
    agentVersionId: string;
    config: VoiceAgentConfig;
    voice: VoiceDeps;
  },
): Promise<string> {
  if (!input.voice.elevenlabs) throw new Error("ElevenLabs isn't set up on this deployment");
  const hash = await voiceAgentHash(input.config);
  const found = await findRecord(tx, input.tenantId, ELEVENLABS_AGENT_ENTITY, hash);
  if (found) return String((found.payload as { agentId: string }).agentId);
  const agentId = await createVoiceAgent(input.voice.fetch, input.voice.elevenlabs, input.config);
  // DECISION: one ElevenLabs agent per client agent version and call settings, kept by the hash of
  // what it was made with, so settings come only from the version (invariant 4) and an old version's
  // calls keep their agent. Two calls racing to make the same agent leave one unused at ElevenLabs.
  const stored = await storeOnce(tx, {
    tenantId: input.tenantId,
    connectionId: input.connectionId,
    connector: ELEVENLABS_CONNECTOR_ID,
    entityType: ELEVENLABS_AGENT_ENTITY,
    externalId: hash,
    payload: { agentId, agentVersionId: input.agentVersionId, language: input.config.language },
  });
  if (stored) return agentId;
  const again = await findRecord(tx, input.tenantId, ELEVENLABS_AGENT_ENTITY, hash);
  return String((again?.payload as { agentId?: string } | undefined)?.agentId ?? agentId);
}

// ── Inbound calls ────────────────────────────────────────────────────────────────────────────────

export interface AnsweringStep {
  agentId: string;
  agentName: string;
  agentSlug: string;
  agentVersionId: string;
  bundle: AgentBundle;
  step: Step & { kind: "action" };
}

/**
 * The first active client agent bound to this Twilio connection whose live version has an enabled
 * workflow on `call.received` with a `call.answer` step.
 */
// DECISION: when several agents could answer, the oldest one wins (by creation), so adding a
// second agent never changes who answers a client's calls without the operator noticing.
export async function answeringStep(
  tx: Tx,
  tenantId: string,
  connectionId: string,
): Promise<AnsweringStep | null> {
  const rows = await tx
    .select({ a: agent, v: agentVersion })
    .from(agent)
    .innerJoin(
      agentVersion,
      and(eq(agentVersion.id, agent.liveVersionId), eq(agentVersion.tenantId, agent.tenantId)),
    )
    .where(
      and(
        eq(agent.tenantId, tenantId),
        eq(agent.kind, "client"),
        eq(agent.runStatus, "active"),
        eq(agent.testCopy, false),
        isNotNull(agent.liveVersionId),
        sql`${agent.bindings}->>'twilio' = ${connectionId}`,
      ),
    )
    .orderBy(asc(agent.createdAt), asc(agent.id));
  for (const { a, v } of rows) {
    for (const wf of v.bundle.workflows) {
      if (wf.enabled === false) continue;
      const on = wf.workflow.trigger.on;
      if (on.type !== "event" || on.event !== CALL_RECEIVED_EVENT) continue;
      const step = wf.workflow.steps.find(
        (s): s is Step & { kind: "action" } => s.kind === "action" && s.tool === CALL_ANSWER_TOOL,
      );
      if (step) {
        return {
          agentId: a.id,
          agentName: a.name,
          agentSlug: a.slug,
          agentVersionId: v.id,
          bundle: v.bundle,
          step,
        };
      }
    }
  }
  return null;
}

export interface InboundPlan {
  decision: InboundDecision;
  reason: string;
  answering: AnsweringStep | null;
  /** When an agent answers: the step's call settings. */
  settings: VoiceSettings | null;
}

/** Who takes a call ringing in now, and why: decided in code, recorded with the call. */
export async function planInbound(
  tx: Tx,
  input: {
    tenantId: string;
    connectionId: string;
    permissions: Partial<PermissionMatrix>;
    /** The connection's config: its human release setting (docs/plan.md §1.26). */
    config: unknown;
    forwardTo: string | null;
    voice: VoiceDeps;
    now?: Date;
  },
): Promise<InboundPlan> {
  const answering = await answeringStep(tx, input.tenantId, input.connectionId);
  const fallback = (reason: string): InboundPlan => ({
    decision: input.forwardTo ? "forward" : "voicemail",
    reason: `${reason}, so the call ${input.forwardTo ? "is forwarded" : "goes to voicemail"}`,
    answering,
    settings: null,
  });
  if (!answering) return fallback("no agent answers this client's calls");
  const { callSid: _ignored, ...raw } = answering.step.input as Record<string, unknown>;
  const settings = VoiceSettingsSchema.safeParse(raw);
  if (!settings.success) return fallback(`${answering.agentName}'s answering step isn't complete`);
  // The step's raw input is never rendered here, but a template in what becomes the voice agent's
  // words is refused all the same, as the gate refuses it for `call.place` (invariant 9).
  if (fixedInputProblem(VOICE_FIXED_INPUTS, raw, raw)) {
    return fallback(
      `${answering.agentName}'s answering step takes its purpose or opening from a template`,
    );
  }
  // The answering agent's grant on the connection narrows it too (docs/plan.md §1.26).
  const grant = await grantOf(tx, {
    tenantId: input.tenantId,
    agentId: answering.agentId,
    connectionId: input.connectionId,
  });
  if (!grantAllowsTool(grant?.limits, CALL_ANSWER_TOOL)) {
    return fallback(
      `${answering.agentName}'s access to the Twilio connection leaves out answering calls`,
    );
  }
  // Human release: a ringing call can't wait for a person's code, so an agent answers only under a
  // release already live for it on this connection (an hours release: there is no run yet).
  const released = await releaseCoversTx(tx, input.tenantId, {
    connection: { id: input.connectionId, config: input.config },
    agentId: answering.agentId,
    runId: null,
    now: input.now ?? new Date(),
  });
  if (!released) {
    return fallback(
      `the client's Twilio connection needs a person to release it before ${answering.agentName} answers, and no release is live`,
    );
  }
  const decision = decideToolCall({
    sideEffect: "external",
    verb: "create",
    matrix: input.permissions,
    grant: grant?.limits ?? null,
    stepApproval: answering.step.approval?.required,
    agentMode: answering.bundle.definition.permissions.mode,
  });
  if (decision === "refused") {
    return fallback(`creating is off for ${answering.agentName} on the client's Twilio connection`);
  }
  if (decision !== "run") {
    return fallback(
      `${answering.agentName}'s answering step needs approval, the connection doesn't allow it to run by itself, or the agent only suggests`,
    );
  }
  if (!input.voice.elevenlabs) return fallback("voice agents aren't set up on this deployment");
  return {
    decision: "agent",
    reason: `answered by ${answering.agentName}`,
    answering,
    settings: settings.data,
  };
}
